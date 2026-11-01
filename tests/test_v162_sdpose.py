"""v1.6.2 SDPose-OOD pose preprocessor. REAL diffusers 0.36 UNet2DConditionModel / AutoencoderKL loaders on a tiny
RANDOM local repository with the SDPose-Body layout (unet/, vae/, decoder/decoder.safetensors), CPU only.
Random weights cannot locate a pose, so routing/lifecycle tests run the real forward pass and then substitute
synthetic heatmaps. They prove code paths, routing, error handling and reference release; they are NOT
pretrained SDPose quality or T4 RAM/VRAM evidence."""
import sys, gc, io, json, base64, types, weakref, tempfile, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine'))
import numpy as np, torch
from PIL import Image, ImageDraw
from diffusers import UNet2DConditionModel, AutoencoderKL, ControlNetModel, DiffusionPipeline, StableDiffusionXLPipeline
from safetensors.torch import save_file
from inference import controlnet as cn
from inference import sdpose
from inference.text2img import InferenceAdapter
import test_controlnet_diffusers_cpu as base

# A standing figure in model-input pixels (768x1024), COCO-17 order.
FIGURE = [(384, 160), (400, 145), (368, 145), (420, 155), (348, 155), (450, 250), (318, 250), (480, 360), (288, 360),
          (500, 460), (268, 460), (430, 520), (338, 520), (440, 680), (328, 680), (445, 840), (323, 840)]

def heatmaps_for(points, sigma=6.0, size=(192, 256)):
    W, H = size
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
    out = np.zeros((17, H, W), np.float32)
    for k, (x, y) in enumerate(points):
        if x is None: continue
        hx, hy = x / sdpose.INPUT_SIZE[0] * (W - 1), y / sdpose.INPUT_SIZE[1] * (H - 1)
        out[k] = np.exp(-((xs - hx) ** 2 + (ys - hy) ** 2) / (2 * sigma ** 2))
    return out

def make_repo(root):
    torch.manual_seed(0)
    unet = UNet2DConditionModel(sample_size=8, in_channels=4, out_channels=4, down_block_types=('DownBlock2D', 'CrossAttnDownBlock2D'),
                                up_block_types=('CrossAttnUpBlock2D', 'UpBlock2D'), block_out_channels=(320, 64), layers_per_block=1,
                                cross_attention_dim=1024, attention_head_dim=8, norm_num_groups=32,
                                class_embed_type='projection', projection_class_embeddings_input_dim=4)
    unet.save_pretrained(root / 'unet')
    # Like the official loader: the repository config is completed by the class_embed_type override at load time.
    cfg = json.loads((root / 'unet/config.json').read_text())
    cfg['class_embed_type'] = None; cfg['projection_class_embeddings_input_dim'] = None
    (root / 'unet/config.json').write_text(json.dumps(cfg))
    vae = AutoencoderKL(block_out_channels=(8, 8, 8, 8), down_block_types=('DownEncoderBlock2D',) * 4, up_block_types=('UpDecoderBlock2D',) * 4,
                        norm_num_groups=4, latent_channels=4, layers_per_block=1, mid_block_add_attention=False)
    vae.save_pretrained(root / 'vae')
    (root / 'decoder').mkdir()
    head = sdpose.build_head()
    save_file({k: v.contiguous() for k, v in head.state_dict().items()}, str(root / 'decoder/decoder.safetensors'))
    return {k: v.clone() for k, v in unet.state_dict().items() if k.startswith('class_embedding')}

def enc(im):
    b = io.BytesIO(); im.save(b, format='PNG'); return 'data:image/png;base64,' + base64.b64encode(b.getvalue()).decode()

def reference(w=600, h=800):
    im = Image.new('RGB', (w, h), (40, 40, 40)); ImageDraw.Draw(im).ellipse((w // 4, h // 6, 3 * w // 4, 5 * h // 6), fill=(220, 150, 90))
    return im

class SDPoseCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(2)
        cls.root = Path(tempfile.mkdtemp()) / 'SDPose-Body'
        cls.class_embedding = make_repo(cls.root)
    def setUp(self):
        self.saved = sdpose.REPO, sdpose.load_models, sdpose.infer
        sdpose.REPO = str(self.root)
        self.refs = []
        real_load = self.saved[1]
        def tracked(device, dtype):
            models = real_load(device, dtype)
            self.refs.extend(weakref.ref(m) for m in models)
            return models
        sdpose.load_models = tracked
    def tearDown(self):
        sdpose.REPO, sdpose.load_models, sdpose.infer = self.saved
    def synthetic(self, points=FIGURE, run_real=True):
        """Real forward pass (exercised), then heatmaps of a known pose, as a pretrained model would produce."""
        real_infer = self.saved[2]
        def infer(models, image, device, dtype):
            _, scale, offset = real_infer(models, image, device, dtype) if run_real else sdpose.letterbox(image)
            return heatmaps_for(points), scale, offset
        sdpose.infer = infer
    def alive(self):
        gc.collect()
        return [r for r in self.refs if r() is not None]
    def request(self, **kw):
        return {**dict(image=enc(reference()), type='OpenPose', prepared=False, width=768, height=1024, preprocessor='sdpose'), **kw}

class Components(SDPoseCase):
    def test_head_matches_reference_state_dict_layout(self):
        # mmpose HeatmapHead(use_silu=True): InstanceNorm2d has no affine params; same keys as ComfyUI's heatmap_head.*
        self.assertEqual(set(sdpose.build_head().state_dict()), {'deconv_layers.0.weight', 'conv_layers.0.weight', 'conv_layers.0.bias', 'final_layer.weight', 'final_layer.bias'})
        head = sdpose.build_head(); state = head.state_dict()
        legacy = {'deconv_layers.0.weight': state['deconv_layers.0.weight'], 'final_layer.0.weight': state['conv_layers.0.weight'], 'final_layer.0.bias': state['conv_layers.0.bias'],
                  'final_layer.3.weight': state['final_layer.weight'], 'final_layer.3.bias': state['final_layer.bias']}
        self.assertEqual(set(sdpose.head_state(legacy)), set(state)); self.assertEqual(sdpose.head_state(state).keys(), state.keys())
        out = sdpose.build_head()(torch.zeros(1, 320, 128, 96))
        self.assertEqual(tuple(out.shape), (1, 17, 256, 192))
    def test_bundled_empty_embedding_and_corruption_check(self):
        e = sdpose.load_embedding()
        self.assertEqual((tuple(e.shape), e.dtype), ((1, 2, 1024), torch.float32))
        bad = Path(tempfile.mkdtemp()) / 'e.safetensors'
        save_file({'empty_text_embed': e + 1}, str(bad))
        saved = sdpose.EMBED_PATH; sdpose.EMBED_PATH = bad
        try:
            with self.assertRaisesRegex(sdpose.SDPoseError, 'Повреждён'): sdpose.load_embedding()
        finally: sdpose.EMBED_PATH = saved
    def test_udp_decode_subpixel_and_empty_heatmap(self):
        points = [(100.3, 200.7), (500.6, 900.2), (60.4, 120.9)] + [None] * 14   # interior: DARK is approximate at a cut-off border, also in mmpose
        maps = heatmaps_for([p if p else (None, None) for p in points])
        kp, sc = sdpose.decode_heatmaps(maps)
        for k, p in enumerate(points[:3]):
            self.assertLess(np.abs(kp[k] - p).max(), 0.5, (k, kp[k], p))
            self.assertGreater(sc[k], 0.9)
        self.assertTrue((sc[3:] == 0).all() and (kp[3:] == -1).all())
    def test_real_loader_override_device_map_and_forward(self):
        unet, vae, head = self.saved[1](torch.device('cpu'), torch.float32)
        self.assertEqual(unet.config.class_embed_type, 'projection')
        for k, v in self.class_embedding.items(): self.assertTrue(torch.equal(unet.state_dict()[k], v), k)   # loaded, not random
        self.assertIsNone(vae.decoder)
        self.assertEqual({p.dtype for p in unet.parameters()}, {torch.float32})
        heat, scale, offset = sdpose.infer((unet, vae, head), reference(600, 800), torch.device('cpu'), torch.float32)
        self.assertEqual(heat.shape, (17, 256, 192)); self.assertTrue(np.isfinite(heat).all())
        self.assertEqual(len(unet.up_blocks[-1]._forward_hooks), 0)
        self.assertAlmostEqual(scale, min(768 / 600, 1024 / 800)); self.assertEqual(offset, (0, 0))
    def test_letterbox_keypoints_map_back_to_image(self):
        image = reference(1000, 500)   # landscape: model input is letterboxed vertically
        _, scale, offset = sdpose.letterbox(image)
        target = [(x * 1.0, y * 0.4) for x, y in FIGURE]
        self.synthetic([(x * scale + offset[0], y * scale + offset[1]) for x, y in target], run_real=False)
        seen = {}
        saved = sdpose.draw_openpose
        sdpose.draw_openpose = lambda kp, sc, w, h: seen.update(kp=kp, size=(w, h)) or saved(kp, sc, w, h)
        try: sdpose.detect(image)
        finally: sdpose.draw_openpose = saved
        self.assertEqual(seen['size'], (1000, 500))
        self.assertLess(np.abs(seen['kp'] - np.array(target)).max(), 1.0)

class Routing(SDPoseCase):
    def test_sdpose_route_produces_openpose_map_and_releases_everything(self):
        import controlnet_aux
        saved = controlnet_aux.OpenposeDetector
        controlnet_aux.OpenposeDetector = lambda *a, **k: self.fail('classic OpenPose must not run for SDPose')
        self.synthetic()
        try: out = cn.preprocess(self.request())
        finally: controlnet_aux.OpenposeDetector = saved
        self.assertEqual((out['type'], out['preprocessor'], out['width'], out['height']), ('OpenPose', 'sdpose', 768, 1024))
        with cn.decode_image(out['image']) as m:
            a = np.asarray(m); self.assertEqual(m.size, (768, 1024)); cn.ensure_content(m, 'OpenPose')
            self.assertGreater((a.max(axis=2) > 0).mean(), 0.005)
            self.assertIn((255, 0, 0), set(map(tuple, a.reshape(-1, 3))))   # OpenPose nose colour, identical palette
        self.assertEqual(len(self.refs), 3)
        self.assertEqual(self.alive(), [], 'SDPose models retained after preprocessing')
        # The map is accepted by the existing generation validation (same OpenPose ControlNet path).
        cn.validate_control(dict(enabled=True, type='OpenPose', map_type='OpenPose', preprocessor='sdpose', image=out['image'], strength=1, start=0, end=1))
    def test_repeated_runs_do_not_accumulate(self):
        self.synthetic()
        first = cn.preprocess(self.request())
        for _ in range(3):
            self.assertEqual(cn.preprocess(self.request()), first)   # deterministic (posterior mean, no sampling)
            self.assertEqual(self.alive(), [])
        self.assertEqual(len(self.refs), 12)
        live = [o for o in gc.get_objects() if isinstance(o, (UNet2DConditionModel, AutoencoderKL)) and getattr(o, 'config', None) is not None and o.config.get('_name_or_path', '').startswith(str(self.root))]
        self.assertEqual(live, [])
    def test_failures_are_clear_and_release_models_even_if_exception_is_kept(self):
        def oom(models, image, device, dtype): raise RuntimeError('CUDA out of memory. Tried to allocate 2.00 GiB')
        sdpose.infer = oom
        with self.assertRaisesRegex(cn.ControlNetError, 'Недостаточно VRAM для SDPose-OOD') as ctx: cn.preprocess(self.request())
        kept = ctx.exception   # the executor future keeps the exception and its traceback
        self.assertEqual(len(self.refs), 3); self.assertEqual(self.alive(), [], 'traceback pinned SDPose weights')
        del kept
        sdpose.load_models = lambda device, dtype: (_ for _ in ()).throw(OSError('403 Forbidden huggingface.co'))
        with self.assertRaisesRegex(cn.ControlNetError, 'Не удалось загрузить веса SDPose-OOD'): cn.preprocess(self.request())
        sdpose.load_models = lambda device, dtype: (_ for _ in ()).throw(MemoryError())
        with self.assertRaisesRegex(cn.ControlNetError, 'системной RAM для SDPose-OOD'): cn.preprocess(self.request())
    def test_no_pose_and_nan_are_rejected(self):
        self.synthetic([(None, None)] * 15 + [(100, 100), (120, 100)])
        with self.assertRaisesRegex(cn.ControlNetError, 'не обнаружил позу'): cn.preprocess(self.request())
        def nan(models, image, device, dtype): return np.full((17, 256, 192), np.nan, np.float32), 1.0, (0, 0)
        sdpose.infer = nan
        with self.assertRaisesRegex(cn.ControlNetError, 'NaN'): cn.preprocess(self.request())
        self.assertEqual(self.alive(), [])
    def test_ready_map_never_loads_sdpose(self):
        sdpose.load_models = lambda *a: self.fail('ready map must not load SDPose')
        pose = Image.new('RGB', (512, 768)); ImageDraw.Draw(pose).line((256, 100, 256, 600), fill=(255, 0, 0), width=6)
        out = cn.preprocess(self.request(image=enc(pose), prepared=True))
        self.assertEqual(out['type'], 'OpenPose')
    def test_preprocessor_validation(self):
        for bad in [dict(type='Canny', preprocessor='sdpose'), dict(type='Depth', preprocessor='openpose'), dict(preprocessor='dwpose'), dict(preprocessor=None)]:
            with self.assertRaisesRegex(cn.ControlNetError, 'препроцессор', msg=bad): cn.preprocess(self.request(**bad))
        good = dict(enabled=True, type='OpenPose', map_type='OpenPose', image=base.control_image('OpenPose'), strength=1, start=0, end=1)
        cn.validate_control(good); cn.validate_control({**good, 'preprocessor': 'sdpose'}); cn.validate_control({**good, 'preprocessor': 'openpose'})
        for bad in [{**good, 'preprocessor': 'dwpose'}, {**good, 'type': 'Canny', 'map_type': 'Canny', 'image': base.control_image('Canny'), 'preprocessor': 'sdpose'}]:
            with self.assertRaisesRegex(cn.ControlNetError, 'препроцессор'): cn.validate_control(bad)

class OtherModesUnaffected(SDPoseCase):
    def test_classic_openpose_canny_depth_after_sdpose_failure(self):
        sdpose.load_models = lambda device, dtype: (_ for _ in ()).throw(OSError('download blocked'))
        with self.assertRaises(cn.ControlNetError): cn.preprocess(self.request())
        import controlnet_aux, huggingface_hub
        from controlnet_aux.open_pose import body
        calls = []
        class Classic:
            def __init__(self, model): calls.append('init')
            def __call__(self, image, **kw):
                calls.append(kw); out = Image.new('RGB', image.size); ImageDraw.Draw(out).line((10, 10, 200, 200), fill=(255, 0, 0), width=8); return out
        saved = controlnet_aux.OpenposeDetector, body.Body, huggingface_hub.hf_hub_download
        controlnet_aux.OpenposeDetector, body.Body, huggingface_hub.hf_hub_download = Classic, lambda path: path, lambda *a, **k: 'body.pth'
        try:
            for request in (self.request(preprocessor='openpose'), {k: v for k, v in self.request().items() if k != 'preprocessor'}):
                out = cn.preprocess(request)
                self.assertEqual((out['type'], out['preprocessor']), ('OpenPose', 'openpose'))
        finally: controlnet_aux.OpenposeDetector, body.Body, huggingface_hub.hf_hub_download = saved
        self.assertEqual(calls[1], dict(detect_resolution=512, image_resolution=1024, include_hand=False, include_face=False))
        out = cn.preprocess(dict(image=enc(reference()), type='Canny', prepared=False, width=512, height=512))
        self.assertNotIn('preprocessor', out)
        depth = base.Preprocessing('test_aud012_valid_and_low_contrast_depth_accepted')
        depth.test_aud012_valid_and_low_contrast_depth_accepted()
        self.assertEqual(self.refs, [])

class GenerationAfterRelease(SDPoseCase):
    """SDPose map -> existing OpenPose ControlNet generation on a tiny real SDXL pipeline, after SDPose was released."""
    def test_sdpose_map_drives_openpose_controlnet_job(self):
        DiffusionPipeline.enable_model_cpu_offload = base._cpu_offload
        saved_cn = ControlNetModel.from_pretrained
        try:
            pipe, template = base.tiny_pipe(Path(tempfile.mkdtemp()))
            pipe.enable_model_cpu_offload()
            loads, cn_refs = [], []
            def fake(repo, **kw):
                loads.append(repo); m = ControlNetModel.from_config(dict(template.config)); m.load_state_dict(template.state_dict()); cn_refs.append(weakref.ref(m)); return m
            ControlNetModel.from_pretrained = staticmethod(fake)
            a = InferenceAdapter(Path(tempfile.mkdtemp())); a.pipe = pipe; a.key = ('c', 'auto'); a.scheduler_config = dict(pipe.scheduler.config)
            a.load = lambda identifier, vae_id='auto': a.pipe
            a.prepare_adapters = lambda req: (a.pipe.set_adapters(['adapter_0'], [1.0]) or ([('adapter_0', 1.0)], []))
            self.synthetic()
            out = cn.preprocess(self.request(width=256, height=256))
            self.assertEqual(self.alive(), [], 'SDPose resident when generation starts')
            control = dict(enabled=True, type='OpenPose', map_type=out['type'], preprocessor=out['preprocessor'], image=out['image'], strength=1.0, start=0.0, end=1.0)
            r = base.wire(dict(mode='text2img', prompt='a fox', negative_prompt='', checkpoint_id='c', vae_id='auto', lora_adapters=[], width=256, height=256,
                               steps=2, cfg_scale=5.0, sampler='Euler', scheduler='Normal', seed=7, batch_size=1, regions=[], controlnet_config=control))
            try: images, _ = a.generate(r, lambda *x: None)
            finally: a.finish_job(); gc.collect()
            self.assertEqual(loads, [cn.MODELS['OpenPose']])
            self.assertTrue(np.isfinite(np.asarray(images[0], np.float32)).all())
            self.assertIs(type(a.pipe), StableDiffusionXLPipeline); self.assertEqual([x for x in cn_refs if x() is not None], [])
        finally:
            DiffusionPipeline.enable_model_cpu_offload = base._ORIG_OFFLOAD; ControlNetModel.from_pretrained = saved_cn

if __name__ == '__main__':
    unittest.main(verbosity=2)
