import type {EngineAdapter,EngineCapabilities,EngineStatus,EngineModel,GenerationRequest,GenerationJob,EngineTelemetry} from './types';
export class OfflineEngine implements EngineAdapter {
 async getStatus():Promise<EngineStatus>{return 'OFFLINE'}
 async getCapabilities():Promise<EngineCapabilities>{return {samplers:[],schedulers:[],img2img:false,inpaint:false,controlNet:false}}
 async listModels():Promise<EngineModel[]>{return []}
 async submitGeneration(_request:GenerationRequest):Promise<GenerationJob>{throw Error('GPU engine is not connected.')}
 async getJobStatus(_id:string):Promise<GenerationJob>{throw Error('No engine job exists.')}
 async cancelJob(_id:string):Promise<void>{throw Error('No active job.')}
 async getResult(_id:string):Promise<Blob|null>{return null}
 async getTelemetry():Promise<EngineTelemetry|null>{return null}
}
