// SIMULATED CloudCompute GPU: answers /health, /inventory and the /sync/* routes in the exact JSON format of
// cloudcompute/drive_sync.py. Every progress value is set explicitly by the test; nothing here is a real transfer.
import {AppError} from '../../server/errors.mjs';
export const TOKEN='b'.repeat(64);
export const HEALTH={engine:'YOISAKI_ENGINE',engine_version:'1.7.0',api_version:'1.7.0',capabilities:{controlnet:true,sdpose:true,img2img:true,regional_control:true},state:'READY',gpu_name:'TEST DOUBLE RTX 5060 Ti',vram_total_mb:16311,vram_available_mb:15000};
let n=0;export const modelId=()=>(++n).toString(16).padStart(32,'0');
export function fakeGpu(){
 const g={up:true,health:{},models:[{id:modelId(),name:'Illustrious_XL_v17.safetensors',kind:'checkpoint',architecture:'SDXL',compatible:true,size_bytes:7e9}],revision:'1'.repeat(32),starts:[],cancels:0,binds:[],
  sync:{enabled:true,rclone_available:true,configured:true,connection:{state:'OK',error:'',code:''},job:null,items:[],disk:{free_bytes:100*2**30,total_bytes:120*2**30,reserve_bytes:2*2**30},last_success_unix:null,last_check_unix:null,inventory_revision:0,owner:'self',selective:true}};
 g.view=()=>({service:'YOISAKI_DRIVE_SYNC',source:'Выбранная папка Google Drive',scope:'drive.readonly',verification:'test',folder_selection:true,...structuredClone(g.sync)});
 g.job=(patch)=>{g.sync.job={...g.sync.job,...patch,overall:{...g.sync.job.overall,...patch.overall}};if(patch.current===null)g.sync.job.current=null};
 g.item=(path,state,extra={})=>{const i=g.sync.items.find(x=>x.path===path);Object.assign(i,{state,...extra})};
 g.upstream=async(c,p,o={})=>{
  if(!g.up)throw new AppError('TUNNEL_UNAVAILABLE','Туннель недоступен: GPU-сервер выключен, ещё запускается или связь прервалась.',502);
  if(p==='/health')return {...HEALTH,...g.health};
  if(p==='/inventory')return {revision:g.revision};
  if(p==='/inventory?models=1')return {revision:g.revision,models:structuredClone(g.models)};
  if(p==='/sync/status')return g.view();
  if(p==='/sync/drive/connect'){g.binds.push(JSON.parse(o.body));g.sync.configured=true;g.sync.connection={state:'UNKNOWN',error:'',code:''};return g.view()}
  if(p==='/sync/start'){const body=JSON.parse(o.body);g.starts.push(body);
   g.sync.job={id:'job'+g.starts.length,type:'sync',state:'RUNNING',phase:'LISTING',started_unix:Date.now()/1000,finished_unix:null,error:'',error_code:'',current:null,overall:{files_total:0,files_done:0,files_failed:0,bytes_total:0,bytes_done:0},summary:{},cancel_requested:false,restart_recommended:false};return g.view()}
  if(p==='/sync/cancel'){g.cancels++;if(g.sync.job?.state==='RUNNING')g.sync.job.cancel_requested=true;return g.view()}
  throw new Error('unexpected upstream '+p);
 };
 return g;
}
