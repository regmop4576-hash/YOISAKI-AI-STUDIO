# Docker deployment 1.7.7.1 — source delivery

Target: `ghcr.io/regmop4576-hash/yoisaki-ai-studio/engine:1.7.7.1`, platform `linux/amd64`.

**NOT PUBLISHED.** Connected GitHub write failed with HTTP 403; anonymous manifest returned 404. Neither a Docker runtime test nor a real GPU deployment was performed for this version in the repair environment. Do not disable the website's image check to rent an instance with a missing tag.

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
