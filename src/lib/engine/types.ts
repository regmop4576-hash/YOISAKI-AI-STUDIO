export type EngineStatus = 'OFFLINE'|'CONNECTING'|'LOADING_MODELS'|'READY'|'BUSY'|'ERROR';
export type JobStatus = 'QUEUED'|'PREPARING'|'RUNNING'|'COMPLETED'|'FAILED'|'CANCELLED';
export interface EngineTelemetry {gpuName?:string;vramUsedMB?:number;vramTotalMB?:number;provider?:string;version?:string;checkpoint?:string;lastHeartbeat?:string}
export interface EngineCapabilities {samplers:string[];schedulers:string[];maxWidth?:number;maxHeight?:number;img2img:boolean;inpaint:boolean;controlNet:boolean}
export interface EngineModel {id:string;name:string;kind:'checkpoint'|'lora'|'vae'|'controlnet';architecture:string;available:boolean}
export interface GenerationRequest {prompt:string;negativePrompt:string;width:number;height:number;steps:number;cfg:number;seed:number|null;sampler:string;scheduler:string;checkpoint:string}
export interface GenerationJob {id:string;status:JobStatus;progress?:number;stage?:string;completedSteps?:number;totalSteps?:number;error?:string}
export interface EngineAdapter {getStatus():Promise<EngineStatus>;getCapabilities():Promise<EngineCapabilities>;listModels():Promise<EngineModel[]>;submitGeneration(request:GenerationRequest):Promise<GenerationJob>;getJobStatus(id:string):Promise<GenerationJob>;cancelJob(id:string):Promise<void>;getResult(id:string):Promise<Blob|null>;getTelemetry():Promise<EngineTelemetry|null>}
