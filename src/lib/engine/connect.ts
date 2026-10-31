import {localApi} from '../local-api';
export type EngineState='OFFLINE'|'CONNECTING'|'LOADING'|'READY'|'BUSY'|'ERROR';
export interface ConnectedEngine {id:string;provider:string;state:EngineState;last_heartbeat:string|null;telemetry:{gpu_name?:string|null;vram_total_mb?:number|null;vram_available_mb?:number|null;checkpoint?:string|null;engine_version?:string};models:RemoteModel[]}
export interface RemoteModel {id:string;name:string;kind:'checkpoint'|'lora'|'vae'|'controlnet';architecture:string;size_bytes:number|null;compatible:boolean|null}
export async function connectApi<T>(path:string,init?:RequestInit):Promise<T>{return localApi<T>('/api/connect/'+path,init)}
