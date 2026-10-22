# YOISAKI ENGINE adapter contract

`EngineAdapter` in `src/lib/engine/types.ts` defines `getStatus`, `getCapabilities`, `listModels`, `submitGeneration`, `getJobStatus`, `cancelJob`, `getResult`, `getTelemetry`.

Supported engine state: OFFLINE, CONNECTING, LOADING_MODELS, READY, BUSY, ERROR. Jobs: QUEUED, PREPARING, RUNNING, COMPLETED, FAILED, CANCELLED. Capabilities are negotiated at connection time; the UI must not presume every sampler or scheduler is supported. `OfflineEngine` is deliberately not an inference simulator. On submit it throws a readable GPU-unavailable error.

When adding a live engine: use a server-side authentication layer and narrow permissions, server-issued revocable pairing credentials, signed job requests, secure data transfer, rate limits, uploaded-image validation, job ownership, status/heartbeat expiry, and a safe result URL or binary response. GPU provider adapters should not leak storage tokens or engine secrets to client bundles.
