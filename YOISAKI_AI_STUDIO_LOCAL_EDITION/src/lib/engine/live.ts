import {localApi} from '../local-api';
export type LiveModel={id:string;name:string;kind:'checkpoint'|'lora'|'vae'|'controlnet';architecture:string;compatible:boolean|null;size_bytes:number|null;base_model?:string;compatibility_reason?:string};
export type LiveEngine={id:string;state:string;provider:string;models:LiveModel[];telemetry?:{gpu_name?:string;vram_total_mb?:number;vram_available_mb?:number}};
export async function api<T>(path:string,init?:RequestInit):Promise<T>{return localApi<T>('/api/connect/'+path,init)}
