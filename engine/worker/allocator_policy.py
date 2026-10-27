"""Worker-start policy for glibc CPU tensor allocation; no per-job trimming."""
import platform


def worker_environment(environ):
    env = dict(environ)
    # Apply before exec, before Python/PyTorch initialize malloc. Never alter
    # the notebook kernel, tensor values, offload order, or a user's allocator.
    if (env.get("YOISAKI_RAM_FIX", "1") != "0"
            and platform.system() == "Linux"
            and platform.libc_ver()[0] == "glibc"
            and not env.get("LD_PRELOAD")
            and "glibc.malloc." not in env.get("GLIBC_TUNABLES", "")):
        env.setdefault("MALLOC_MMAP_THRESHOLD_", "131072")
    return env
