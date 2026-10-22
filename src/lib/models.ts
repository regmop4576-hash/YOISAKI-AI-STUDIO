export type ModelKind='checkpoint'|'lora'|'vae'|'controlnet';
export interface DemoModel{id:string;name:string;kind:ModelKind;architecture:string;extension:string;size:string;trigger?:string;compatibility:string;description:string}
export const demoModels:DemoModel[]=[
{id:'illustrious',name:'Illustrious XL',kind:'checkpoint',architecture:'Illustrious / SDXL-family',extension:'.safetensors',size:'Not installed',compatibility:'SDXL-family LoRAs require individual verification',description:'Illustrative checkpoint metadata only. No model file is bundled.'},
{id:'amber',name:'Amber 3.0 LoRA',kind:'lora',architecture:'Illustrious XL (example)',extension:'.safetensors',size:'Not installed',trigger:'amber_batcat',compatibility:'Example target: Illustrious XL. Verify actual base model and weight.',description:'Demo entry for Amber character LoRA.'},
{id:'vesper',name:'Vesper 3.0 LoRA',kind:'lora',architecture:'Illustrious XL (example)',extension:'.safetensors',size:'Not installed',trigger:'vesperfox',compatibility:'Example target: Illustrious XL. Verify actual base model and weight.',description:'Demo entry for Vesper character LoRA.'},
{id:'sdxl-vae',name:'SDXL VAE',kind:'vae',architecture:'SDXL',extension:'.safetensors',size:'Not installed',compatibility:'Depends on checkpoint',description:'Demonstration VAE metadata.'},
{id:'openpose',name:'SDXL OpenPose ControlNet',kind:'controlnet',architecture:'SDXL',extension:'.safetensors',size:'Not installed',compatibility:'Requires a compatible SDXL control pipeline',description:'Future ControlNet reference. No pose extraction.'}];
