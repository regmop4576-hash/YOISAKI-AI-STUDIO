# Validation harness (development sandbox only — NOT part of the deployment)

Used to produce the logs in `../`. The sandbox had no NVIDIA GPU, a TLS-intercepting proxy and no route to `api.trycloudflare.com`, so:

- `Dockerfile.validate` = the shipped `Dockerfile` + the sandbox proxy CA (3 lines after `FROM`).
- `Dockerfile.patch` = the same COPY + import-check steps on top of the full build, for source-only changes made after the network slowed down.
- `compose.validate.yml` (via `YOISAKI_COMPOSE_OVERRIDE`) removes the GPU reservation and mounts `sitecustomize.py`, a CUDA test double, so the REAL engine server reports READY without a GPU.
- `docker-e2e.sh`, `native-in-image.sh`, `native-root-stub.sh` drive the shipped scripts end to end.
- `package.py` rebuilds `package-manifest.json` + the ZIP; `package-check.sh` checks it; `stage-release.sh` copies the release here.
