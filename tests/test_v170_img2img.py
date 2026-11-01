"""v1.7.0 Img2Img. REAL diffusers 0.36 / accelerate / peft objects on tiny RANDOM SDXL components, CPU only
(Accelerate model offload with device='cpu', the same hook code path as on the T4). They prove code paths,
component sharing, lifecycle and the request contract; they are NOT pretrained quality or T4 RAM/VRAM evidence."""
import sys, gc, io, time, types, base64, weakref, tempfile, threading, unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np, torch
from PIL import Image
from diffusers import (StableDiffusionXLPipeline, StableDiffusionXLImg2ImgPipeline, StableDiffusionXLControlNetPipeline,
                       StableDiffusionXLControlNetImg2ImgPipeline, ControlNetModel, DiffusionPipeline, UNet2DConditionModel, AutoencoderKL)
from fastapi.testclient import TestClient
from inference.text2img import InferenceAdapter
from inference import controlnet as cn, img2img as i2i
from worker.direct_server import AdapterRequest, create_app
import test_controlnet_diffusers_cpu as base

def source(w=32, h=32, seed=0, fmt='PNG'):
    a = (np.random.default_rng(seed).random((h, w, 3)) * 255).astype(np.uint8)
    b = io.BytesIO(); Image.fromarray(a).save(b, format=fmt)
    return f'data:image/{fmt.lower()};base64,' + base64.b64encode(b.getvalue()).decode()

def mask(w=32, h=32):
    im = Image.new('L', (w, h), 0); im.paste(255, (0, 0, w // 2, h))
    b = io.BytesIO(); im.save(b, format='PNG'); return 'data:image/png;base64,' + base64.b64encode(b.getvalue()).decode()

MODULES = ('unet', 'vae', 'text_encoder', 'text_encoder_2')

class RealDiffusersImg2Img(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(2)
        DiffusionPipeline.enable_model_cpu_offload = base._cpu_offload
        cls.tmp = Path(tempfile.mkdtemp())
        cls.pipe, cls.template = base.tiny_pipe(cls.tmp)
        cls.pipe.enable_vae_slicing(); cls.pipe.enable_model_cpu_offload()
        state = {k: v.clone() for k, v in cls.template.state_dict().items()}; config = dict(cls.template.config)
        cls.refs = []
        cls._orig_from_pretrained = ControlNetModel.from_pretrained
        def fake_from_pretrained(repo, **kw):
            m = ControlNetModel.from_config(config); m.load_state_dict(state); cls.refs.append(weakref.ref(m)); return m
        ControlNetModel.from_pretrained = staticmethod(fake_from_pretrained)
        a = InferenceAdapter(cls.tmp); a.pipe = cls.pipe; a.key = ('ckpt', 'auto')
        a.adapter_key = (('adapter_0', 'x', 1, 1),); a.scheduler_config = dict(cls.pipe.scheduler.config)
        a.load = lambda identifier, vae_id='auto': a.pipe
        # Active LoRA (adapter_0) is selected exactly like prepare_adapters(); regions get no regional LoRA here.
        a.prepare_adapters = lambda req: (a.pipe.set_adapters(['adapter_0'], [1.0]) or ([('adapter_0', 1.0)], [[] for r in req.get('regions', []) if r['enabled']]))
        cls.adapter = a
        cls.modules = {n: getattr(cls.pipe, n) for n in MODULES}
        cls.plain = cls.run_job(cls.req())[0]

    @classmethod
    def tearDownClass(cls):
        DiffusionPipeline.enable_model_cpu_offload = base._ORIG_OFFLOAD
        ControlNetModel.from_pretrained = cls._orig_from_pretrained

    @staticmethod
    def req(**kw): return base.RealDiffusersControlNet.req(**kw)

    @classmethod
    def i2i(cls, strength=.6, image=None, steps=5, **kw):
        return cls.req(mode='img2img', kind='img2img', init_image=image or source(), denoising_strength=strength, steps=steps, **kw)

    @classmethod
    def run_job(cls, r, progress=None, seen=None):
        """Mirrors worker.direct_server.run_job: generate, then finish_job in finally."""
        a = cls.adapter; a.measure = lambda phase: None; out = err = None; events = []
        def observe(step, stage):
            events.append((step, stage))
            if seen is not None and stage == 'GENERATING' and step > 0:
                seen.append((type(a.pipe), all(getattr(a.pipe, n) is m for n, m in cls.modules.items()), weakref.ref(a.pipe)))
            if progress: progress(step, stage)
        try:
            images, _ = a.generate(r, observe); out = [np.asarray(im).astype(np.float32) for im in images]
        except Exception as exc:
            err = exc
        finally:
            try: a.finish_job()
            except Exception: a.unload()
            gc.collect()
        if err is not None: raise err
        return out, events

    def assert_base_state(self):
        p = self.adapter.pipe
        self.assertIs(type(p), StableDiffusionXLPipeline)
        self.assertFalse(hasattr(p, 'controlnet')); self.assertFalse(getattr(p, '_yoisaki_img2img', False))
        for n, m in self.modules.items(): self.assertIs(getattr(p, n), m, n)   # never reloaded / duplicated
        self.assertIn('adapter_0', p.unet.peft_config)
        self.assertEqual([r for r in self.refs if r() is not None], [], 'ControlNet retained after job')
        self.assertEqual(len(p._all_hooks), 4)

    def assert_views_released(self, seen, kind):
        self.assertTrue(seen)
        self.assertTrue(all(t is kind and shared for t, shared, _ in seen), seen)
        gc.collect()
        self.assertTrue(all(ref() is None for _, _, ref in seen), 'per-job pipeline wrapper retained')

    def test_img2img_shares_loaded_components_and_returns_to_base(self):
        units, vaes = (sum(isinstance(o, c) for o in gc.get_objects()) for c in (UNet2DConditionModel, AutoencoderKL))
        seen = []
        out, _ = self.run_job(self.i2i(), seen=seen)
        self.assert_views_released(seen, StableDiffusionXLImg2ImgPipeline)
        self.assertEqual(out[0].shape, (32, 32, 3)); self.assertTrue(np.isfinite(out[0]).all())
        self.assertGreater(np.abs(out[0] - self.plain[0]).max(), 0)
        self.assertEqual(sum(isinstance(o, UNet2DConditionModel) for o in gc.get_objects()), units)
        self.assertEqual(sum(isinstance(o, AutoencoderKL) for o in gc.get_objects()), vaes)
        self.assert_base_state()

    def test_progress_counts_only_executed_denoising_steps(self):
        for steps, strength, expected in [(10, .3, 3), (5, 1, 5), (20, .55, 11), (4, .25, 1)]:
            r = self.i2i(strength, steps=steps)
            self.assertEqual(i2i.total_steps(r), expected)
            _, events = self.run_job(r)
            generating = [s for s, stage in events if stage == 'GENERATING' and s > 0]
            self.assertEqual(generating, list(range(1, expected + 1)), (steps, strength))
            self.assertIn((expected, 'DECODING'), events)
        self.assertEqual(i2i.total_steps(self.req(steps=7)), 7)   # Text2Img unchanged
        self.assert_base_state()

    def test_seed_denoise_source_batch_and_samplers(self):
        a = self.run_job(self.i2i())[0][0]
        self.assertTrue(np.array_equal(a, self.run_job(self.i2i())[0][0]), 'same seed must reproduce')
        for changed in (self.i2i(seed=124), self.i2i(.9), self.i2i(image=source(seed=7)), self.i2i(negative_prompt='other')):
            self.assertGreater(np.abs(self.run_job(changed)[0][0] - a).max(), 0)
        batch = self.run_job(self.i2i(batch_size=2))[0]
        self.assertEqual(len(batch), 2); self.assertGreater(np.abs(batch[0] - batch[1]).max(), 0)
        for sampler, scheduler in [('Euler', 'Karras'), ('Euler a', 'Normal'), ('DPM++ 2M', 'Normal'), ('DPM++ 2M', 'Karras')]:
            out = self.run_job(self.i2i(sampler=sampler, scheduler=scheduler))[0]
            self.assertTrue(np.isfinite(out[0]).all(), sampler)
        self.assert_base_state()

    def test_lora_weight_reaches_img2img(self):
        a = self.adapter; saved = a.prepare_adapters
        try:
            a.prepare_adapters = lambda req: (a.pipe.set_adapters(['adapter_0'], [0.0]) or ([('adapter_0', 0.0)], []))
            off = self.run_job(self.i2i())[0][0]
        finally:
            a.prepare_adapters = saved
        self.assertGreater(np.abs(self.run_job(self.i2i())[0][0] - off).max(), 0, 'active LoRA must change the Img2Img result')
        self.assert_base_state()

    def test_source_of_other_size_and_formats_is_fitted_not_stretched(self):
        wide = np.zeros((32, 96, 3), np.uint8); wide[:, :32] = (255, 0, 0); wide[:, 32:64] = (0, 255, 0); wide[:, 64:] = (0, 0, 255)
        b = io.BytesIO(); Image.fromarray(wide).save(b, format='PNG')
        with i2i.source_image('data:image/png;base64,' + base64.b64encode(b.getvalue()).decode(), 32, 32) as fitted:
            self.assertEqual(fitted.size, (32, 32))
            self.assertTrue((np.asarray(fitted)[:, 4:28] == (0, 255, 0)).all(), 'centre crop expected')
        for fmt in ('JPEG', 'WEBP'):
            out = self.run_job(self.i2i(image=source(48, 40, fmt=fmt)))[0]
            self.assertEqual(out[0].shape, (32, 32, 3), fmt)
        self.assert_base_state()

    def test_controlnet_img2img_and_text2img_controlnet_unchanged(self):
        seen = []
        with_control = self.run_job(self.i2i(controlnet_config=base.RealDiffusersControlNet.ctl('Canny', strength=1)), seen=seen)[0]
        self.assert_views_released(seen, StableDiffusionXLControlNetImg2ImgPipeline)
        self.assertGreater(np.abs(with_control[0] - self.run_job(self.i2i())[0][0]).max(), 0)
        self.assert_base_state()
        seen = []
        self.run_job(self.req(controlnet_config=base.RealDiffusersControlNet.ctl('Depth')), seen=seen)
        self.assert_views_released(seen, StableDiffusionXLControlNetPipeline)
        self.assert_base_state()
        with self.assertRaises(cn.ControlNetError):   # map/size check is shared with Text2Img
            self.run_job(self.i2i(controlnet_config=base.RealDiffusersControlNet.ctl('Canny', image=base.control_image('Canny', 40, 32))))
        self.assert_base_state()

    def test_regional_control_with_img2img(self):
        region = dict(name='A', enabled=True, lora_id='', trigger='amber', prompt='bat', negative_prompt='fox', weight=1.0, mask=mask())
        regional = self.run_job(self.i2i(regions=[region]))[0][0]
        self.assertTrue(np.isfinite(regional).all())
        self.assertGreater(np.abs(regional - self.run_job(self.i2i())[0][0]).max(), 0)
        self.assert_base_state()

    def test_failures_and_cancel_release_the_view_and_text2img_is_unchanged(self):
        with self.assertRaises(i2i.Img2ImgError):
            self.run_job(self.i2i(image='data:image/png;base64,iVBORw0KGgo='))
        self.assert_base_state()
        def cancel(step, stage):
            if stage == 'GENERATING' and step >= 1: raise RuntimeError('Cancellation requested')
        with self.assertRaises(RuntimeError): self.run_job(self.i2i(.8), cancel)
        self.assert_base_state()
        self.assertTrue(np.array_equal(self.run_job(self.req())[0][0], self.plain[0]), 'plain Text2Img changed after Img2Img use')

    def test_repeated_runs_do_not_accumulate_objects(self):
        jobs = [self.i2i(), self.req(), self.i2i(controlnet_config=base.RealDiffusersControlNet.ctl('OpenPose')), self.i2i(.4, batch_size=2)]
        for r in jobs: self.run_job(r)   # warm-up: lazy imports, scheduler caches
        gc.collect()
        def census():
            objs = gc.get_objects()
            return (sum(torch.is_tensor(o) for o in objs), sum(isinstance(o, DiffusionPipeline) for o in objs), sum(isinstance(o, torch.nn.Module) for o in objs))
        before = census()
        for _ in range(3):
            for r in jobs: self.run_job(r)
        gc.collect()
        self.assertEqual(census(), before, 'tensors / pipelines / modules accumulate across repeated jobs')
        self.assert_base_state()

class FP16Img2ImgTransitions(unittest.TestCase):
    """AUD-019 for the v1.7.0 views: no upcast and no extra bytes of the shared fp16 modules."""
    def test_img2img_views_keep_fp16_and_bytes(self):
        DiffusionPipeline.enable_model_cpu_offload = base._cpu_offload
        saved = ControlNetModel.from_pretrained
        try:
            pipe, template = base.tiny_pipe(Path(tempfile.mkdtemp()))
            pipe.to(dtype=torch.float16); pipe.enable_model_cpu_offload()
            ControlNetModel.from_pretrained = staticmethod(lambda repo, **kw: ControlNetModel.from_config(dict(template.config)).to(kw['torch_dtype']))
            adapter = types.SimpleNamespace(pipe=pipe, measure=lambda p: None, unload=lambda: None)
            def nbytes(p): return sum(x.numel() * x.element_size() for n in MODULES for x in getattr(p, n).parameters())
            before = nbytes(pipe)
            for make, kind in [(lambda: i2i.activate(adapter), StableDiffusionXLImg2ImgPipeline),
                               (lambda: cn.activate(adapter, 'Canny', img2img=True), StableDiffusionXLControlNetImg2ImgPipeline)]:
                p = make(); self.assertIs(type(p), kind)
                self.assertEqual({str(next(getattr(p, n).parameters()).dtype) for n in MODULES}, {'torch.float16'})
                self.assertEqual(nbytes(p), before); self.assertIs(p.unet, pipe.unet)
                del p
                cn.to_base(adapter)
                self.assertIs(type(adapter.pipe), StableDiffusionXLPipeline)
                self.assertEqual({str(next(getattr(adapter.pipe, n).parameters()).dtype) for n in MODULES}, {'torch.float16'})
                self.assertEqual(nbytes(adapter.pipe), before); self.assertEqual(len(adapter.pipe._all_hooks), 4)
        finally:
            DiffusionPipeline.enable_model_cpu_offload = base._ORIG_OFFLOAD; ControlNetModel.from_pretrained = saved

REQ = dict(prompt='park', checkpoint_id='b' * 32, width=512, height=512, steps=10, cfg_scale=5, sampler='Euler', scheduler='Normal', seed=1, batch_size=1)
IMG = source(512, 512)

class Img2ImgRequestContract(unittest.TestCase):
    def test_valid_requests(self):
        r = AdapterRequest(**REQ, kind='img2img', mode='img2img', init_image=IMG, denoising_strength=1)
        self.assertEqual(r.denoising_strength, 1.0); self.assertIs(type(r.model_dump()['denoising_strength']), float)
        t = AdapterRequest(**REQ).model_dump()
        self.assertIsNone(t['init_image']); self.assertIsNone(t['denoising_strength']); self.assertEqual(t['mode'], 'text2img')

    def test_invalid_requests(self):
        ok = dict(REQ, kind='img2img', mode='img2img', init_image=IMG, denoising_strength=.5)
        for bad in [dict(init_image=None), dict(denoising_strength=None), dict(denoising_strength=0), dict(denoising_strength=1.01),
                    dict(denoising_strength=float('nan')), dict(denoising_strength=-.2), dict(steps=3, denoising_strength=.3),
                    dict(init_image='data:image/gif;base64,R0lGODlhAQABAAAAACw='), dict(init_image='data:image/png;base64,bm90IGFuIGltYWdl'),
                    dict(init_image=source(8, 8)), dict(kind='text2img'), dict(mode='inpaint', kind='inpaint')]:
            with self.assertRaises(ValueError, msg=str(bad)[:80]): AdapterRequest(**{**ok, **bad})
        for bad in [dict(init_image=IMG), dict(denoising_strength=.5)]:   # Text2Img stays exactly Text2Img
            with self.assertRaises(ValueError): AdapterRequest(**REQ, **bad)

    def test_engine_route_progress_capability_and_errors(self):
        calls = []
        def generate(adapter, req, progress):
            calls.append(req); total = i2i.total_steps(req)
            if req['prompt'] == 'fail': raise i2i.Img2ImgError('Исходное изображение Img2Img: тестовая ошибка.')
            for step in range(1, total + 1): progress(step, 'GENERATING')
            return [Image.new('RGB', (8, 8))], req['seed']
        cuda = types.SimpleNamespace(empty_cache=lambda: None, is_available=lambda: True, mem_get_info=lambda: (10, 16), get_device_name=lambda: 'TEST DOUBLE')
        token = 'a' * 64; headers = {'Authorization': 'Bearer ' + token}
        def wait(client, ident):
            deadline = time.time() + 5
            while time.time() < deadline:
                j = client.get('/jobs/' + ident, headers=headers).json()
                if j['status'] in ('COMPLETED', 'FAILED'): return j
                time.sleep(.01)
            self.fail('job did not finish')
        with patch.dict(sys.modules, torch=types.SimpleNamespace(cuda=cuda)), patch('worker.direct_server.scan', return_value=[dict(id='b' * 32, kind='checkpoint')]), \
             patch('worker.direct_server.resolve'), patch.object(InferenceAdapter, 'generate', generate), patch.object(InferenceAdapter, 'finish_job', lambda self: None):
            with TestClient(create_app('/unused', token)) as client:
                health = client.get('/health', headers=headers).json()
                self.assertEqual(health['engine_version'], '1.8.1'); self.assertIs(health['capabilities']['img2img'], True)
                body = dict(REQ, kind='img2img', mode='img2img', init_image=IMG, denoising_strength=.35)
                r = client.post('/generate', headers=headers, json=body); self.assertEqual(r.status_code, 200, r.text)
                j = wait(client, r.json()['id'])
                self.assertEqual(j['status'], 'COMPLETED'); self.assertEqual(j['progress']['total_steps'], 3); self.assertEqual(j['progress']['step'], 3)
                self.assertEqual(j['progress']['percent'], 100)
                self.assertEqual(calls[-1]['init_image'], IMG); self.assertEqual(calls[-1]['denoising_strength'], .35)
                r = client.post('/generate', headers=headers, json={**body, 'prompt': 'fail'})
                j = wait(client, r.json()['id'])
                self.assertEqual(j['status'], 'FAILED'); self.assertEqual(j['error'], 'Исходное изображение Img2Img: тестовая ошибка.')
                r = client.post('/generate', headers=headers, json={**body, 'denoising_strength': .05, 'steps': 10})
                self.assertEqual(r.status_code, 422); self.assertIn('не даёт ни одного шага', r.text)
                r = client.post('/generate', headers=headers, json=REQ); j = wait(client, r.json()['id'])
                self.assertEqual(j['progress']['total_steps'], 10); self.assertIsNone(calls[-1]['init_image'])

if __name__ == '__main__': unittest.main(verbosity=2)
