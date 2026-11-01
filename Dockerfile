# syntax=docker/dockerfile:1
# YOISAKI ENGINE · CloudCompute deployment 1.7.7.1 (engine protocol 1.7.0, engine/ unchanged since 1.7.4).
# Model weights, API keys and Google credentials are NEVER part of the image: models live on the data volume (/data),
# the engine token is issued per instance by YOISAKI AI STUDIO at creation time (cloudcompute/autostart-image.sh).
#
# CUDA 12.8 base: the minimum CUDA for RTX 50xx (sm_120); the PyTorch wheel brings its own CUDA 12.8
# runtime libraries, the host provides only the NVIDIA driver (NVIDIA Container Toolkit, `--gpus all`).
#
# Reproducible build: the base image is pinned by digest, every Python wheel by version + sha256
# (cloudcompute/requirements-lock.txt), cloudflared by version + sha256. Published by .github/workflows/engine-image.yml
# as ghcr.io/<owner>/<repo>/engine:<cloudcompute/VERSION> (never :latest).
# Optional for builds behind a TLS-inspecting proxy: `--secret id=extra_ca,src=ca.crt` (used only during RUN, not stored).
FROM nvidia/cuda:12.8.1-base-ubuntu24.04@sha256:133c78a0575303be34164d0b90137a042172bdf60696af01a3c424ab402d86e2

ARG CLOUDFLARED_VERSION=2026.9.3
ARG CLOUDFLARED_SHA256=77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2
ARG YOISAKI_REVISION=unknown

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# python3.12 (Ubuntu 24.04), tini as PID 1 (signal forwarding, zombie reaping), glib for OpenCV.
# util-linux (setpriv, flock) is part of the base system and used by cloudcompute/autostart-image.sh.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates curl tini libglib2.0-0t64 \
 && rm -rf /var/lib/apt/lists/* \
 && command -v setpriv flock >/dev/null

# Dependencies first: this ~7 GB layer is reused by every later build of changed code.
# The lock pins the complete dependency tree by hash; check_lock.py proves it satisfies the top-level pins.
COPY engine/requirements.txt /opt/yoisaki/engine/requirements.txt
COPY cloudcompute/requirements-cloud.txt cloudcompute/requirements-lock.txt cloudcompute/check_lock.py /opt/yoisaki/cloudcompute/
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export PIP_CERT=/run/secrets/extra_ca; fi \
 && python3 -m venv /opt/yoisaki/venv \
 && /opt/yoisaki/venv/bin/pip install --require-hashes --no-deps -r /opt/yoisaki/cloudcompute/requirements-lock.txt \
 && /opt/yoisaki/venv/bin/pip check \
 && /opt/yoisaki/venv/bin/python /opt/yoisaki/cloudcompute/check_lock.py /opt/yoisaki

# Pinned cloudflared release, verified by SHA-256 (same quick-tunnel transport as the Colab panel).
RUN --mount=type=secret,id=extra_ca,required=false \
    CA=; if [ -s /run/secrets/extra_ca ]; then CA="--cacert /run/secrets/extra_ca"; fi \
 && curl -fsSL $CA -o /usr/local/bin/cloudflared \
      "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64" \
 && echo "${CLOUDFLARED_SHA256}  /usr/local/bin/cloudflared" | sha256sum -c - \
 && chmod 0755 /usr/local/bin/cloudflared

# 1.7.2: rclone for the read-only Google Drive model sync (Ubuntu archive package, verified by apt signatures).
# A separate layer AFTER the PyTorch layer: upgrading reuses the cached ~7 GB dependency layer.
RUN apt-get update \
 && apt-get install -y --no-install-recommends rclone \
 && rm -rf /var/lib/apt/lists/* \
 && rclone version | head -n1

COPY engine/ /opt/yoisaki/engine/
COPY cloudcompute/ /opt/yoisaki/cloudcompute/
COPY start-cloudcompute.sh stop-cloudcompute.sh check-cloudcompute.sh fetch-models-cloudcompute.sh drive-sync-cloudcompute.sh /opt/yoisaki/

# Same import check as the Colab installer + PyTorch kernels for sm_75..sm_120 (no GPU needed at build).
RUN cd /opt/yoisaki/engine && /opt/yoisaki/venv/bin/python /opt/yoisaki/cloudcompute/import_check.py /opt/yoisaki/engine \
 && find /opt/yoisaki -name __pycache__ -prune -exec rm -rf {} + \
 && chmod 0755 /opt/yoisaki/cloudcompute/autostart-image.sh \
 && chmod -R a+rX,go-w /opt/yoisaki

# Unprivileged runtime user (uid 1000; the stock "ubuntu" account is removed to free the uid).
# /data belongs to it, so a fresh volume (provider runtime or `docker run -v`) is writable without root.
RUN userdel -r ubuntu 2>/dev/null || true \
 && useradd --uid 1000 --create-home --shell /usr/sbin/nologin yoisaki \
 && mkdir -p /data/runtime/home \
 && chown -R 1000:1000 /data

ENV PATH=/opt/yoisaki/venv/bin:$PATH \
    YOISAKI_IN_IMAGE=1 \
    YOISAKI_DATA_ROOT=/data \
    YOISAKI_ENGINE_DIR=/opt/yoisaki/engine \
    YOISAKI_PYTHON=/opt/yoisaki/venv/bin/python \
    YOISAKI_CLOUDFLARED=/usr/local/bin/cloudflared \
    HF_HOME=/data/huggingface-cache \
    HOME=/data/runtime/home

# 1.7.7.1: no `USER 1000:1000`. The container starts as root, the Docker default that provider bootstraps (SSH / web
# terminal / monitoring agents, the "onstart" script) are normally written for. 1.7.5 started as uid 1000, so a
# bootstrap that installs or starts such services inside the container would fail (not confirmed for CloudCompute:
# its bootstrap scripts are not published; see YOISAKI_DOCKER_AUDIT.md). The ENGINE itself
# still runs as uid 1000: autostart-image.sh drops privileges with setpriv (--clear-groups) before it starts
# launcher.py. `docker run --user 1000:1000` and docker-compose.yml (user: 1000:1000) keep working unchanged.
WORKDIR /opt/yoisaki
VOLUME ["/data"]

# Healthy = the local engine answers /health with READY or BUSY (token read from the 0600 state file).
HEALTHCHECK --interval=30s --timeout=10s --start-period=300s --retries=3 \
  CMD ["/opt/yoisaki/venv/bin/python", "/opt/yoisaki/cloudcompute/launcher.py", "healthcheck"]

STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--"]
# 1.7.5: a small supervisor around launcher.py. Without the website-issued provisioning it behaves exactly like 1.7.4.
# 1.7.7.1: it never exits while another supervisor of the same container runs (onstart before CMD keeps PID 1 alive).
CMD ["/opt/yoisaki/cloudcompute/autostart-image.sh"]
LABEL org.opencontainers.image.title="YOISAKI ENGINE CloudCompute" \
      org.opencontainers.image.description="YOISAKI ENGINE 1.7.0 (SDXL / Illustrious XL, Multi-LoRA, ControlNet, Regional Control, Img2Img, Google Drive sync) for CloudCompute GPUs. No models or credentials inside." \
      org.opencontainers.image.version="1.7.7.1" \
      org.opencontainers.image.revision="${YOISAKI_REVISION}" \
      org.opencontainers.image.source="https://github.com/regmop4576-hash/YOISAKI-AI-STUDIO" \
      org.opencontainers.image.licenses="NOASSERTION"
