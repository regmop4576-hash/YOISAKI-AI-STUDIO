"""Installation runs once per ephemeral runtime; UI imports no inference libraries."""
from pathlib import Path
import subprocess,sys,json
ROOT=Path(__file__).resolve().parent

def install():
    python=ROOT/'.venv/bin/python';log=ROOT/'setup.log'
    with log.open('w') as f:
        # Inherit Colab's tested CUDA torch without modifying the notebook interpreter.
        if not python.exists():
            result=subprocess.run([sys.executable,'-m','venv','--system-site-packages',str(ROOT/'.venv')],stdout=f,stderr=subprocess.STDOUT)
            if result.returncode:
                # Some Colab images omit ensurepip. Bootstrap virtualenv without apt or root writes.
                import os
                seed=ROOT/'_bootstrap'
                subprocess.run([sys.executable,'-m','pip','install','--target',str(seed),'virtualenv>=20.31,<21'],check=True,stdout=f,stderr=subprocess.STDOUT)
                env=os.environ.copy();env['PYTHONPATH']=str(seed)
                subprocess.run([sys.executable,'-m','virtualenv','--system-site-packages',str(ROOT/'.venv')],env=env,check=True,stdout=f,stderr=subprocess.STDOUT)
        import importlib.metadata
        torch_version=importlib.metadata.version('torch')
        constraint=ROOT/'colab-torch-constraint.txt'
        constraint.write_text('torch=='+torch_version+'\n')
        subprocess.run([str(python),'-m','pip','install','-c',str(constraint),'--disable-pip-version-check','-r',str(ROOT/'requirements.txt')],check=True,stdout=f,stderr=subprocess.STDOUT)
        check="from worker.direct_server import create_app; from inference.text2img import InferenceAdapter; import torch; from diffusers import StableDiffusionXLPipeline, StableDiffusionXLControlNetPipeline, ControlNetModel, AutoencoderKL; import peft, transformers, accelerate, cv2; from controlnet_aux import OpenposeDetector; from transformers import AutoImageProcessor, AutoModelForDepthEstimation; from diffusers import UNet2DConditionModel; from controlnet_aux.open_pose import PoseResult, draw_poses; from inference.sdpose import detect, load_embedding; load_embedding(); from diffusers import StableDiffusionXLImg2ImgPipeline, StableDiffusionXLControlNetImg2ImgPipeline; from inference.img2img import activate, source_image; from inference.facedetect import _model; _model('anime'); _model('human'); print('IMPORTS_OK'); print('CUDA',torch.cuda.is_available())"
        subprocess.run([str(python),'-c',check],cwd=ROOT,check=True,stdout=f,stderr=subprocess.STDOUT)
        with (ROOT/'installed-versions.txt').open('w') as versions:
            subprocess.run([str(python),'-m','pip','freeze'],stdout=versions,check=True)
