"""v1.6.1 regression tests with REAL diffusers 0.36 / accelerate / peft objects on tiny RANDOM
SDXL components, CPU only. Accelerate model offload runs with device='cpu' (same hook code path).
They prove code paths, types and lifecycle; they are NOT pretrained quality or T4 RAM/VRAM evidence."""
import sys, gc, io, json, math, types, weakref, tempfile, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine'))
import numpy as np, torch
from PIL import Image, ImageDraw
from diffusers import (StableDiffusionXLPipeline, UNet2DConditionModel, AutoencoderKL, EulerDiscreteScheduler,
                       ControlNetModel, DiffusionPipeline)
from transformers import CLIPTextConfig, CLIPTextModel, CLIPTextModelWithProjection, CLIPTokenizer
from peft import LoraConfig
from inference.text2img import InferenceAdapter
from inference import controlnet as cn
from worker.direct_server import AdapterRequest

_ORIG_OFFLOAD = DiffusionPipeline.enable_model_cpu_offload
def _cpu_offload(self, gpu_id=None, device=None):
    return _ORIG_OFFLOAD(self, device='cpu')

def tiny_pipe(root):
    torch.manual_seed(0)
    vocab = {'<|startoftext|>': 0, '<|endoftext|>': 1}
    for c in 'abcdefghijklmnopqrstuvwxyz':
        vocab[c] = len(vocab); vocab[c + '</w>'] = len(vocab)
    (root / 'vocab.json').write_text(json.dumps(vocab)); (root / 'merges.txt').write_text('#version: 0.2\n')
    tok = CLIPTokenizer(vocab_file=str(root / 'vocab.json'), merges_file=str(root / 'merges.txt'), model_max_length=16)
    cfg = CLIPTextConfig(vocab_size=len(vocab), hidden_size=8, intermediate_size=16, num_hidden_layers=2, num_attention_heads=2,
                         max_position_embeddings=16, projection_dim=8, bos_token_id=0, eos_token_id=1, pad_token_id=1)
    unet = UNet2DConditionModel(sample_size=4, in_channels=4, out_channels=4, down_block_types=('CrossAttnDownBlock2D', 'DownBlock2D'),
                                up_block_types=('UpBlock2D', 'CrossAttnUpBlock2D'), block_out_channels=(16, 32), layers_per_block=1,
                                cross_attention_dim=16, attention_head_dim=4, norm_num_groups=4, addition_embed_type='text_time',
                                addition_time_embed_dim=2, projection_class_embeddings_input_dim=20)
    vae = AutoencoderKL(block_out_channels=(8, 8, 8, 8), down_block_types=('DownEncoderBlock2D',) * 4,
                        up_block_types=('UpDecoderBlock2D',) * 4, norm_num_groups=4, latent_channels=4)
    template = ControlNetModel.from_unet(unet, conditioning_embedding_out_channels=(4, 8, 8, 8))
    for n, p in template.named_parameters():
        if 'controlnet_down_blocks' in n or 'controlnet_mid_block' in n:
            with torch.no_grad(): p.normal_(std=.5)
    pipe = StableDiffusionXLPipeline(vae=vae, text_encoder=CLIPTextModel(cfg), text_encoder_2=CLIPTextModelWithProjection(cfg),
                                     tokenizer=tok, tokenizer_2=tok, unet=unet, scheduler=EulerDiscreteScheduler(), add_watermarker=False)
    unet.add_adapter(LoraConfig(r=2, lora_alpha=2, target_modules=['to_q', 'to_k', 'to_v', 'to_out.0']), adapter_name='adapter_0')
    for n, p in unet.named_parameters():
        if 'lora_' in n:
            with torch.no_grad(): p.normal_(std=.3)
    return pipe, template

def control_image(kind, w=32, h=32):
    a = np.zeros((h, w, 3), np.uint8)
    if kind == 'Canny': a[8:24, 8] = 255; a[8, 8:24] = 255
    elif kind == 'Depth': a[:] = np.linspace(0, 255, w, dtype=np.uint8)[None, :, None]
    else: a[4:28, 15:17] = 255
    return cn.encode_image(Image.fromarray(a))

def wire(value):
    """What the website sends: JavaScript JSON.stringify writes 1.0 as 1, so Python receives int."""
    if isinstance(value, dict): return {k: wire(v) for k, v in value.items()}
    if isinstance(value, list): return [wire(v) for v in value]
    if isinstance(value, float) and math.isfinite(value) and value.is_integer(): return int(value)
    return value

class RealDiffusersControlNet(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(2)
        DiffusionPipeline.enable_model_cpu_offload = _cpu_offload
        cls.tmp = Path(tempfile.mkdtemp())
        cls.pipe, cls.template = tiny_pipe(cls.tmp)
        cls.pipe.enable_vae_slicing(); cls.pipe.enable_model_cpu_offload()
        cls.state = {k: v.clone() for k, v in cls.template.state_dict().items()}
        cls.config = dict(cls.template.config)
        cls.refs, cls.loads = [], []
        cls._orig_from_pretrained = ControlNetModel.from_pretrained
        def fake_from_pretrained(repo, **kw):
            cls.loads.append((repo, kw))
            m = ControlNetModel.from_config(cls.config); m.load_state_dict(cls.state)
            cls.refs.append(weakref.ref(m)); return m   # fp32 on CPU: fp16 conv kernels are not the subject here
        ControlNetModel.from_pretrained = staticmethod(fake_from_pretrained)
        a = InferenceAdapter(cls.tmp); a.pipe = cls.pipe; a.key = ('ckpt', 'auto')
        a.adapter_key = (('adapter_0', 'x', 1, 1),); a.scheduler_config = dict(cls.pipe.scheduler.config)
        a.load = lambda identifier, vae_id='auto': a.pipe
        a.prepare_adapters = lambda req: (a.pipe.set_adapters(['adapter_0'], [1.0]) or ([('adapter_0', 1.0)], []))
        cls.adapter = a; cls.unet = cls.pipe.unet
        cls.plain = cls.run_job(cls.req())   # list of images; tests compare self.plain[0]

    @classmethod
    def tearDownClass(cls):
        DiffusionPipeline.enable_model_cpu_offload = _ORIG_OFFLOAD
        ControlNetModel.from_pretrained = cls._orig_from_pretrained

    @staticmethod
    def req(control=None, **kw):
        r = dict(mode='text2img', prompt='a fox in a park', negative_prompt='blur', checkpoint_id='c', vae_id='auto',
                 lora_adapters=[], width=32, height=32, steps=3, cfg_scale=5.0, sampler='Euler', scheduler='Normal', seed=123,
                 batch_size=1, regions=[], controlnet_config=control or {'enabled': False})
        r.update(kw); return wire(r)

    @staticmethod
    def ctl(kind, strength=.8, start=0.0, end=1.0, image=None):
        return dict(enabled=True, type=kind, map_type=kind, image=image or control_image(kind), strength=strength, start=start, end=end)

    @classmethod
    def run_job(cls, r, progress=lambda *a: None):
        """Mirrors worker.direct_server.run_job: generate, then finish_job in finally."""
        a = cls.adapter; a.measure = lambda phase: None; out = err = None
        try:
            images, _ = a.generate(r, progress); out = [np.asarray(im).astype(np.float32) for im in images]
        except Exception as exc:
            err = exc
        finally:
            try: a.finish_job()
            except Exception: a.unload()
            gc.collect()
        if err is not None: raise err
        return out

    def assert_base_state(self):
        p = self.adapter.pipe
        self.assertIs(type(p), StableDiffusionXLPipeline)
        self.assertFalse(hasattr(p, 'controlnet'))
        self.assertIs(p.unet, self.unet)
        self.assertIn('adapter_0', p.unet.peft_config)
        self.assertEqual([r for r in self.refs if r() is not None], [], 'ControlNet retained after job')
        self.assertEqual(len(p._all_hooks), 4)

    def test_aud001_strength_values_from_json(self):
        for strength in (0.0, 0.5, 0.8, 1.0, 1.5, 2.0):
            r = self.req(self.ctl('Canny', strength=strength, start=0.0, end=1.0))
            sent = r['controlnet_config']
            if strength.is_integer(): self.assertIs(type(sent['strength']), int)   # the real wire type that used to fail
            out = self.run_job(r)
            self.assertTrue(np.isfinite(out[0]).all(), strength)
            diff = np.abs(out[0] - self.plain[0]).max()
            if strength == 0: self.assertEqual(diff, 0.0)
            else: self.assertGreater(diff, 0.0, strength)
            self.assert_base_state()

    def test_aud001_invalid_values_rejected(self):
        good = self.ctl('Canny')
        for key, value in [('strength', -0.01), ('strength', 2.01), ('strength', float('nan')), ('strength', True),
                           ('strength', '1'), ('start', -0.1), ('end', 1.01), ('start', 0.5)]:
            bad = {**good, key: value, **({'end': 0.5} if key == 'start' and value == 0.5 else {})}
            with self.assertRaises(cn.ControlNetError, msg=(key, value)): cn.validate_control(bad)
            with self.assertRaises(ValueError):
                AdapterRequest(prompt='x', checkpoint_id='a' * 32, width=256, height=256, steps=2, cfg_scale=5, sampler='Euler',
                               scheduler='Normal', seed=1, batch_size=1, controlnet_config=bad)
        self.assertEqual(cn.normalize({**good, 'strength': 1, 'start': 0, 'end': 1})['strength'], 1.0)
        self.assertIs(type(cn.normalize({**good, 'strength': 1, 'start': 0, 'end': 1})['start']), float)

    def test_lifecycle_modes_errors_cancel_lora_and_plain_unchanged(self):
        for kind in ('OpenPose', 'Canny', 'Depth', 'Canny'):
            out = self.run_job(self.req(self.ctl(kind)))
            self.assertGreater(np.abs(out[0] - self.plain[0]).max(), 0); self.assert_base_state()
        self.assertEqual(len(self.run_job(self.req(self.ctl('Depth', strength=1), batch_size=2))), 2); self.assert_base_state()
        with self.assertRaises(cn.ControlNetError):
            self.run_job(self.req(self.ctl('Canny', image=control_image('Canny', 40, 32))))
        self.assert_base_state()
        def cancel(step, stage):
            if stage == 'GENERATING' and step >= 1: raise RuntimeError('Cancellation requested')
        with self.assertRaises(RuntimeError): self.run_job(self.req(self.ctl('Depth')), cancel)
        self.assert_base_state()
        with self.assertRaisesRegex(cn.ControlNetError, 'Regional'): self.run_job(self.req(self.ctl('Canny'), regions=[{'enabled': True}]))
        self.assertTrue(np.array_equal(self.run_job(self.req())[0], self.plain[0]), 'plain Text2Img changed after ControlNet use')

    def test_aud003_controlnet_never_copied_back_before_release(self):
        """After activation the ControlNet must not be moved again (on CUDA every such .to() is a 2.4 GB GPU->RAM copy)."""
        moves, offloads = [], []
        orig_to = torch.nn.Module.to
        import accelerate.hooks as ah
        orig_offload = ah.UserCpuOffloadHook.offload
        active = {'on': False}
        def spy_to(module, *a, **k):
            if active['on'] and isinstance(module, ControlNetModel): moves.append((a, k))
            return orig_to(module, *a, **k)
        def spy_offload(hook):
            offloads.append(type(hook.model).__name__); return orig_offload(hook)
        orig_activate = cn.activate
        def activate_then_watch(adapter, mode):
            pipe = orig_activate(adapter, mode)
            self.assertIn('controlnet', pipe._exclude_from_cpu_offload)
            self.assertFalse(hasattr(pipe.controlnet, '_hf_hook'), 'ControlNet must not get an offload hook')
            active['on'] = True; return pipe
        torch.nn.Module.to = spy_to; ah.UserCpuOffloadHook.offload = spy_offload
        cn.activate, saved = activate_then_watch, cn.activate
        try:
            out = self.run_job(self.req(self.ctl('Canny', strength=1)))
        finally:
            torch.nn.Module.to = orig_to; ah.UserCpuOffloadHook.offload = orig_offload; cn.activate = saved; active['on'] = False
        self.assertTrue(np.isfinite(out[0]).all())
        self.assertEqual(moves, [], 'ControlNet was moved after activation')
        for name in ('UNet2DConditionModel', 'AutoencoderKL', 'CLIPTextModel', 'CLIPTextModelWithProjection'):
            self.assertIn(name, offloads)   # base models are still offloaded exactly like model CPU offload
        self.assert_base_state()

    def test_aud004_canny_and_depth_use_fp16_variant_openpose_unchanged(self):
        self.loads.clear()
        for kind in ('Canny', 'Depth', 'OpenPose'): self.run_job(self.req(self.ctl(kind)))
        got = {repo: kw for repo, kw in self.loads}
        self.assertEqual(got['diffusers/controlnet-canny-sdxl-1.0'].get('variant'), 'fp16')
        self.assertEqual(got['diffusers/controlnet-depth-sdxl-1.0-small'].get('variant'), 'fp16')
        self.assertNotIn('variant', got['xinsir/controlnet-openpose-sdxl-1.0'])
        for kw in got.values():
            self.assertIs(kw['torch_dtype'], torch.float16); self.assertTrue(kw['use_safetensors']); self.assertTrue(kw['low_cpu_mem_usage'])

    def test_aud004_real_loader_picks_fp16_file_from_repo_layout(self):
        """Real ControlNetModel.from_pretrained via activate(): a local repo with BOTH fp32 and fp16 files,
        like diffusers/controlnet-canny-sdxl-1.0. The fp16 file holds distinguishable weights."""
        repo = self.tmp / 'canny-repo'
        m = ControlNetModel.from_config(self.config); m.load_state_dict(self.state)
        m.save_pretrained(repo, safe_serialization=True)
        marker = next(n for n, _ in m.named_parameters() if 'controlnet_mid_block' in n and n.endswith('weight'))
        with torch.no_grad(): dict(m.named_parameters())[marker].fill_(0.25)
        m.half().save_pretrained(repo, safe_serialization=True, variant='fp16')
        self.assertEqual(sorted(p.name for p in repo.glob('*.safetensors')),
                         ['diffusion_pytorch_model.fp16.safetensors', 'diffusion_pytorch_model.safetensors'])
        saved_models, fake = dict(cn.MODELS), ControlNetModel.from_pretrained
        ControlNetModel.from_pretrained = self._orig_from_pretrained
        cn.MODELS['Canny'] = str(repo)
        try:
            self.adapter.measure = lambda p: None
            pipe = cn.activate(self.adapter, 'Canny')
            loaded = pipe.controlnet
            self.assertIs(next(loaded.parameters()).dtype, torch.float16)
            self.assertTrue(torch.all(dict(loaded.named_parameters())[marker] == 0.25), 'fp32 file was loaded instead of fp16 variant')
            self.assertIs(pipe.unet, self.unet)
            del loaded, pipe
            cn.to_base(self.adapter); gc.collect()
        finally:
            cn.MODELS.clear(); cn.MODELS.update(saved_models); ControlNetModel.from_pretrained = fake
        self.assertIs(type(self.adapter.pipe), StableDiffusionXLPipeline); self.assertIs(self.adapter.pipe.unet, self.unet)


class FP16PipelineTransitions(unittest.TestCase):
    """AUD-019: diffusers 0.36 from_pipe() defaults to torch_dtype=float32 and casts the SHARED modules.
    The T4 pipeline is fp16; base and ControlNet must stay fp16 through activate()/to_base() cycles."""
    def test_aud019_activate_and_release_keep_fp16_and_bytes(self):
        DiffusionPipeline.enable_model_cpu_offload = _cpu_offload
        saved = ControlNetModel.from_pretrained
        try:
            pipe, template = tiny_pipe(Path(tempfile.mkdtemp()))
            pipe.to(dtype=torch.float16); pipe.enable_model_cpu_offload()
            ControlNetModel.from_pretrained = staticmethod(lambda repo, **kw: ControlNetModel.from_config(dict(template.config)).to(kw['torch_dtype']))
            adapter = types.SimpleNamespace(pipe=pipe, measure=lambda p: None, unload=lambda: None)
            names = ('unet', 'text_encoder', 'text_encoder_2', 'vae')
            def nbytes(p): return sum(x.numel() * x.element_size() for n in names for x in getattr(p, n).parameters())
            before = nbytes(pipe)
            for mode in ('Canny', 'Depth', 'OpenPose'):
                p = cn.activate(adapter, mode)
                self.assertEqual({str(next(getattr(p, n).parameters()).dtype) for n in names + ('controlnet',)}, {'torch.float16'}, mode)
                self.assertEqual(nbytes(p), before, mode)
                del p
                cn.to_base(adapter)
                self.assertEqual({str(next(getattr(adapter.pipe, n).parameters()).dtype) for n in names}, {'torch.float16'}, mode)
                self.assertEqual(nbytes(adapter.pipe), before, mode)
                self.assertIs(adapter.pipe.unet, pipe.unet)
                self.assertTrue(all(p.dtype == torch.float16 for n, p in adapter.pipe.unet.named_parameters() if 'lora_' in n))
        finally:
            DiffusionPipeline.enable_model_cpu_offload = _ORIG_OFFLOAD; ControlNetModel.from_pretrained = saved

class Preprocessing(unittest.TestCase):
    def enc(self, im, fmt='PNG', mime='png'):
        b = io.BytesIO(); im.save(b, format=fmt); return f'data:image/{mime};base64,' + __import__('base64').b64encode(b.getvalue()).decode()
    def reference(self, w, h):
        im = Image.new('RGB', (w, h), (40, 40, 40)); d = ImageDraw.Draw(im)
        d.ellipse((w // 4, h // 5, 3 * w // 4, 4 * h // 5), fill=(220, 180, 120)); d.rectangle((10, 10, w // 6, h - 10), fill=(90, 160, 220))
        return im
    def test_aud008_canny_binary_for_sizes_and_aspects(self):
        for (sw, sh), (w, h) in [((768, 512), (1024, 768)), ((768, 512), (1024, 1024)), ((512, 768), (832, 1216)),
                                 ((1600, 900), (1536, 640)), ((300, 300), (256, 512))]:
            out = cn.preprocess(dict(image=self.enc(self.reference(sw, sh)), type='Canny', prepared=False, width=w, height=h))
            with cn.decode_image(out['image']) as m:
                a = np.asarray(m)
                self.assertEqual(m.size, (w, h))
                self.assertLessEqual(set(np.unique(a).tolist()), {0, 255}, f'non-binary Canny map {sw}x{sh}->{w}x{h}')
                self.assertGreater((a > 0).mean(), 0.001)
    def test_aud008_prepared_binary_maps_stay_binary(self):
        im = Image.new('RGB', (512, 384)); ImageDraw.Draw(im).rectangle((50, 50, 400, 300), outline='white', width=3)
        for w, h in [(1024, 768), (768, 768), (384, 256)]:
            out = cn.preprocess(dict(image=self.enc(im), type='Canny', prepared=True, width=w, height=h))
            with cn.decode_image(out['image']) as m:
                self.assertLessEqual(set(np.unique(np.asarray(m)).tolist()), {0, 255})
        pose = Image.new('RGB', (512, 768)); ImageDraw.Draw(pose).line((256, 100, 256, 600), fill=(255, 0, 0), width=6)
        out = cn.preprocess(dict(image=self.enc(pose), type='OpenPose', prepared=True, width=1024, height=1024))
        with cn.decode_image(out['image']) as m:
            self.assertLessEqual(set(map(tuple, np.asarray(m).reshape(-1, 3))), {(0, 0, 0), (255, 0, 0)})
    def depth_with(self, fn, w=768, h=512):
        from transformers import AutoImageProcessor, AutoModelForDepthEstimation
        class Proc:
            def __call__(self, images, return_tensors): return {'pixel_values': torch.zeros(1, 3, 37, 56)}
        class Est(torch.nn.Module):
            def forward(self, pixel_values): return types.SimpleNamespace(predicted_depth=fn(37, 56))
        saved = AutoImageProcessor.from_pretrained, AutoModelForDepthEstimation.from_pretrained
        AutoImageProcessor.from_pretrained = staticmethod(lambda *a, **k: Proc())
        AutoModelForDepthEstimation.from_pretrained = staticmethod(lambda *a, **k: Est())
        try: return cn.preprocess(dict(image=self.enc(self.reference(w, h)), type='Depth', prepared=False, width=1024, height=768))
        finally: AutoImageProcessor.from_pretrained, AutoModelForDepthEstimation.from_pretrained = saved
    def test_aud012_uniform_and_near_uniform_depth_rejected(self):
        torch.manual_seed(0)
        for name, fn in [('flat', lambda h, w: torch.ones(1, h, w) * 3.7),
                         ('round-off noise', lambda h, w: 3.7 + 1e-6 * torch.randn(1, h, w)),
                         ('0.01% ripple', lambda h, w: 5.0 + 5e-4 * torch.rand(1, h, w)),
                         ('NaN', lambda h, w: torch.full((1, h, w), float('nan')))]:
            with self.assertRaisesRegex(cn.ControlNetError, 'глубину', msg=name): self.depth_with(fn)
    def test_aud012_valid_and_low_contrast_depth_accepted(self):
        for name, fn in [('gradient', lambda h, w: torch.linspace(0, 8, w).repeat(1, h, 1)),
                         ('low contrast 3%', lambda h, w: 10 + 0.3 * torch.linspace(0, 1, w).repeat(1, h, 1)),
                         ('small magnitude', lambda h, w: 0.02 * torch.linspace(0, 1, h)[None, :, None].repeat(1, 1, w))]:
            out = self.depth_with(fn)
            with cn.decode_image(out['image']) as m:
                a = np.asarray(m); self.assertEqual(m.size, (1024, 768), name); self.assertEqual(a.max(), 255, name)
                self.assertGreater(a.std(), 1, name)

if __name__ == '__main__':
    unittest.main(verbosity=2)
