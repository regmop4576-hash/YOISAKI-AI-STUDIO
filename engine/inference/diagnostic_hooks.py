"""Scoped observation around existing Diffusers SDXL calls. No pipeline logic changes.

Instrumentation is opt-in, installed only around ONE existing pipeline call and
restored in finally. Callback/hook failures must never alter generated outputs.
"""
from contextlib import AbstractContextManager
from functools import wraps

class SDXLStageObserver(AbstractContextManager):
    def __init__(self,pipe,mark,steps):
        self.pipe=pipe;self.mark=mark;self.steps=steps
        self.saved=[];self.forward_handle=None
        self.once=set()
    def emit(self,name):
        if name in self.once:return
        self.once.add(name)
        try:self.mark(name)
        except Exception:pass
    def wrap(self,obj,name,before=None,after=None):
        original=getattr(obj,name,None)
        if not callable(original):return False
        @wraps(original)
        def traced(*args,**kw):
            if before:self.emit(before)
            value=original(*args,**kw)
            if after:self.emit(after)
            return value
        local_override=name in vars(obj)
        setattr(obj,name,traced)
        self.saved.append((obj,name,original,local_override))
        return True
    def __enter__(self):
        try:
            # Real boundaries in diffusers 0.36 StableDiffusionXLPipeline.__call__.
            self.wrap(self.pipe,'encode_prompt','before_text_encoding','after_text_encoding')
            vae=getattr(self.pipe,'vae',None)
            if vae is not None:
                self.wrap(vae,'decode','before_vae_decode','after_vae_decode')
            processor=getattr(self.pipe,'image_processor',None)
            if processor is not None:
                self.wrap(processor,'postprocess',None,'after_image_conversion')
            unet=getattr(self.pipe,'unet',None)
            if unet is not None:
                for hook in getattr(self.pipe, '_all_hooks', ()):
                    if getattr(hook, 'model', None) is unet:
                        self.wrap(hook, 'offload', 'before_unet_cpu_offload', 'after_unet_cpu_offload')
                self.forward_handle=unet.register_forward_pre_hook(lambda *_:self.emit('before_denoising'))
            return self
        except BaseException:
            self.__exit__(None,None,None)
            raise
    def step_end(self,step):
        # This is immediately after the final scheduler update and callback, but
        # some pipeline housekeeping can still happen before vae.decode.
        if step+1==self.steps:self.emit('after_denoising_callback')
    def __exit__(self,*args):
        if self.forward_handle is not None:
            self.forward_handle.remove();self.forward_handle=None
        for obj,name,original,local_override in reversed(self.saved):
            if local_override:setattr(obj,name,original)
            else:delattr(obj,name)   # Important: do not leave bound-method reference cycles
        self.saved.clear()
        return False
