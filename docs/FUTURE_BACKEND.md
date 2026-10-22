# Future backend integration

The current application is an offline UI prototype, with no cloud registration or telemetry. Recommended backend topology: browser -> authenticated central HTTPS service -> queue -> provider-specific worker (Colab / local / cloud) -> secured artifact storage -> browser. Pair a worker once using server-provisioned short-lived credentials, and implement rotating tokens, revocation and heartbeat TTL server-side. Neither IP addresses nor keys should be entered into browser UI for routine use.

Next milestone: capability negotiation, model discovery, provider-neutral request schemas, image upload endpoints, queue status, cancel jobs, signed/downloadable results, and explicit status handling. Guard incompatible LoRAs and unsupported schedulers before submission, implement quotas and size caps. Add real integration tests before enabling generation.
