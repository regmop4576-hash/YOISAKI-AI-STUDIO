# Docker deployment 1.7.7.1 — source delivery

Target: `ghcr.io/regmop4576-hash/yoisaki-ai-studio/engine:1.7.7.1`, platform `linux/amd64`.

**PUBLISHED** on 2026-10-28 by GitHub Actions run [40701192429](https://github.com/regmop4576-hash/YOISAKI-AI-STUDIO/actions/runs/40701192429) from commit `1166a784d42f8b1e7f618c46eb8ecb01987f28e3` (branch `ccr-cd7a1445-guevci`):

- manifest digest `sha256:a148c0e8f5df410454c33dc4bef902fbfad412ddfc9b357e487f02a9ce4964dc` (pull by digest: `ghcr.io/regmop4576-hash/yoisaki-ai-studio/engine@sha256:a148c0e8f5df410454c33dc4bef902fbfad412ddfc9b357e487f02a9ce4964dc`);
- config `sha256:8a1385c1adcffbb32d0876c4e462ee854e2f8c812c70d3c44b11aac17168bb03` = the image ID of the candidate that passed `tests/docker-startup-1771.sh` in the same run; config read anonymously: `linux/amd64`, version label `1.7.7.1`, revision label `1166a784d42f8b1e7f618c46eb8ecb01987f28e3`;
- anonymous manifest request: HTTP 200; tags in the registry: `1.7.5`, `1.7.7`, `1.7.7.1` (1.7.5 and 1.7.7 digests unchanged, no `latest`).

A real GPU deployment was **not** performed. The first attempt (before this run) was rejected by the connected GitHub integration with HTTP 403 while writing the source (`create-tree`); no workflow ran then, hence the 404. Do not disable the website's image check to rent an instance with a missing tag.

The installation ZIP contains the complete project. The separate Docker source ZIP contains Dockerfile, .dockerignore, engine/, cloudcompute/, server/ (used by the runtime test's onstart generator), required shell scripts, the runtime test and GitHub workflow. Models, keys and credentials are absent.

## Maintainer publication

With authorized repository/package write access, use `.github/workflows/engine-image.yml` from this source. Preserve the existing repository; the submitted baseline corresponds to v1.7.7 branch `ccr-774a8291-6mlfxa` / commit `488369a0e0a832a54e052a1a9a5742f8b3e4561e`, not the older main branch. The write attempt in this repair did not change any branch.

Workflow:

1. Read cloudcompute/VERSION and check Dockerfile label.
2. Refuse to overwrite an existing version.
3. Build a local linux/amd64 candidate using pinned base/dependencies.
4. Run `tests/docker-startup-1771.sh` against the actual candidate (CPU only).
5. Push only after tests pass.
6. Verify anonymous manifest access. Failure is an error, not a publication-success claim.

Equivalent build/test commands on a Docker-capable maintainer host:

```bash
docker build --platform linux/amd64 -t ghcr.io/regmop4576-hash/yoisaki-ai-studio/engine:1.7.7.1 .
bash tests/docker-startup-1771.sh ghcr.io/regmop4576-hash/yoisaki-ai-studio/engine:1.7.7.1
```

Before publishing, verify that 1.7.7.1 does not already exist and authenticate with package write permissions. Never overwrite 1.7.7. The included workflow implements the version guard; manual publication must preserve it.

CPU tests intentionally use `YOISAKI_GPU_PREFLIGHT=0` only in designated smoke scenarios. Production keeps GPU preflight enabled. No models are loaded during CPU smoke tests. Real NVIDIA runtime, CloudCompute bootstrap/proxy, Cloudflare reachability and inference require a separate acceptance run.

The main container still starts as root for provider bootstrap and drops the inference launcher to uid 1000. `/data` is persistent; app configuration is private. Required runtime tools are tini, bash, flock, setpriv, setsid, nohup, Python venv and cloudflared. Normal CMD and provider onstart call the same supervisor.
