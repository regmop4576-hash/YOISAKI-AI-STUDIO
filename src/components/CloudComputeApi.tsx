'use client';
import {useCallback,useEffect,useState} from 'react';
import {KeyRound} from 'lucide-react';
import {useStudio} from '@/stores/studio';
import {localApi} from '@/lib/local-api';

// v1.7.3 CloudCompute REST API panel. The key is entered once and kept by the local app (secrets.json 0600):
// the page only ever sees "saved/validated" flags and instance data, never the key itself.
export type Instance={id:string;name:string;status:'RUNNING'|'STARTING'|'STOPPING'|'STOPPED'|'ERROR'|'UNKNOWN';provider_status:string;gpu:string|null;gpu_count:number|null;disk_gb:number|null;price_per_hour:number|null;image:string|null};
export type CloudView={configured:boolean;saved_at:number|null;validated_at:number|null;instance_id:string|null;api_host:string;docs_url:string;panel_url:string;
 contract:{verified:boolean;verified_against:string;error:string;capabilities:{validate:boolean;list:boolean;get:boolean;start:boolean;stop:boolean}};instances:Instance[];listed_at:number|null;error:string;code:string};

const EN:Record<string,string>={CC_INVALID_KEY:'The CloudCompute API key must start with “cc-” and contain no spaces. Copy it completely from the API access page.',
 CC_AUTH_REJECTED:'CloudCompute rejected the API key: it is wrong, revoked or has no access to GPU instances. Create a new key on the API access page.',
 CC_UNSUPPORTED:'This operation is not available: the CloudCompute API description has not been verified against the official documentation.',
 CC_NOT_FOUND:'The instance was not found in the CloudCompute account.',CC_PAYMENT:'CloudCompute: insufficient balance.',CC_RATE_LIMITED:'CloudCompute API: too many requests, wait a minute.',
 CC_UNAVAILABLE:'The CloudCompute API is temporarily unavailable.',CC_NETWORK:'No connection to the CloudCompute API. Check the phone’s internet.',CC_TLS:'The CloudCompute API certificate failed verification; the connection was not made.',
 CC_TIMEOUT:'The CloudCompute API did not answer in time.',CC_REJECTED:'CloudCompute rejected the operation.',CC_INVALID_RESPONSE:'The CloudCompute API answered in an unexpected format: the API description does not match.',
 CC_NO_KEY:'Save the CloudCompute API key first.',CONFIRMATION_REQUIRED:'Confirm the operation first.',CC_PRIVATE_DESTINATION:'The CloudCompute API name resolves to a private address; the request was blocked.'};

export function CloudComputeApi({onChange}:{onChange?:(v:CloudView)=>void}){
 const english=useStudio(x=>x.language)==='English';const t=(ru:string,en:string)=>english?en:ru;
 const [view,setView]=useState<CloudView|null>(null),[key,setKey]=useState(''),[editing,setEditing]=useState(false),[busy,setBusy]=useState(''),[error,setError]=useState('');
 const apply=useCallback((v:CloudView)=>{setView(v);onChange?.(v)},[onChange]);
 const show=(e:unknown)=>{const x=e as Error&{code?:string};setError(english&&x.code&&EN[x.code]?EN[x.code]:x.message)};
 const run=async(label:string,fn:()=>Promise<CloudView>)=>{setBusy(label);setError('');try{apply(await fn())}catch(e){show(e);try{apply(await localApi<CloudView>('/api/cloudcompute'))}catch{}}finally{setBusy('')}};
 useEffect(()=>{localApi<CloudView>('/api/cloudcompute').then(v=>{apply(v);if(v.configured&&v.contract.capabilities.list)void run('list',()=>localApi<CloudView>('/api/cloudcompute/instances'))}).catch(show)},[]);
 if(!view)return null;
 const caps=view.contract.capabilities;const selected=view.instances.find(i=>i.id===view.instance_id)||null;
 const date=(n:number|null)=>n?new Date(n).toLocaleString(english?'en-GB':'ru-RU'):'';
 const statusName:Record<string,string>={RUNNING:t('Работает','Running'),STARTING:t('Запускается','Starting'),STOPPING:t('Останавливается','Stopping'),STOPPED:t('Остановлен','Stopped'),ERROR:t('Ошибка','Error'),UNKNOWN:t('Неизвестно','Unknown')};
 const save=()=>run('save',async()=>{const v=await localApi<CloudView>('/api/cloudcompute/key',{method:'PUT',body:JSON.stringify({api_key:key.trim()})});setKey('');setEditing(false);if(v.contract.capabilities.list)return localApi<CloudView>('/api/cloudcompute/instances');return v});
 const remove=()=>{if(confirm(t('Удалить ключ CloudCompute API с этого телефона? Инстансы и движок не изменятся.','Remove the CloudCompute API key from this phone? Instances and the engine are not changed.')))void run('remove',()=>localApi<CloudView>('/api/cloudcompute/key',{method:'DELETE'}))};
 const lifecycle=(i:Instance,action:'start'|'stop')=>{
  const text=action==='start'?t(`Запустить инстанс «${i.name}»? С момента запуска CloudCompute начинает оплату GPU${i.price_per_hour?` (≈ ${i.price_per_hour} ₽/ч)`:''}.`,`Start instance “${i.name}”? CloudCompute bills the GPU from now on${i.price_per_hour?` (≈ ${i.price_per_hour} RUB/h)`:''}.`)
   :t(`Остановить инстанс «${i.name}»? Генерация на нём прекратится, движок отключится. Хранение диска может оплачиваться и после остановки — проверьте тариф в панели CloudCompute.`,`Stop instance “${i.name}”? Generation on it ends and the engine disconnects. Disk storage may still be billed after stopping — check the CloudCompute panel.`);
  if(confirm(text))void run(action,()=>localApi<CloudView>('/api/cloudcompute/instance/'+action,{method:'POST',body:JSON.stringify({instance_id:i.id,confirm:true})}));
 };
 const keyState=!view.configured?t('Ключ не сохранён','No key saved'):view.validated_at?t(`Ключ сохранён и проверен ${date(view.validated_at)}`,`Key saved and verified ${date(view.validated_at)}`):t(`Ключ сохранён ${date(view.saved_at)} · на сервере CloudCompute не проверялся`,`Key saved ${date(view.saved_at)} · not verified with CloudCompute`);
 return <div className="card stack" aria-label="CloudCompute API" data-localized="true">
  <div className="row" style={{justifyContent:'space-between'}}><b><KeyRound size={16} style={{verticalAlign:'-3px'}}/> CloudCompute API</b><span className="status" role="status">{keyState}</span></div>
  <p className="tiny muted">{t('Ключ API даёт доступ к вашим GPU-инстансам (список, статус, запуск/остановка). Он не даёт доступа к движку YOISAKI: для движка остаётся отдельная защищённая ссылка с токеном. Ключ хранится только в приложении на телефоне (файл 0600) и не передаётся ни странице, ни GPU-серверу.','The API key gives access to your GPU instances (list, status, start/stop). It does not give access to the YOISAKI engine: the engine keeps its own protected link with a token. The key stays only in the app on this phone (file 0600) and is never sent to the page or the GPU server.')}</p>
  {(!view.configured||editing)?<div className="stack">
   <label className="field">{t('Ключ API (cc-…)','API key (cc-…)')}<input type="password" autoComplete="off" spellCheck={false} value={key} onChange={e=>setKey(e.target.value)} placeholder="cc-…" aria-label={t('Ключ CloudCompute API','CloudCompute API key')}/></label>
   <div className="row"><button className="primary" disabled={!!busy||!key.trim()} onClick={()=>void save()}>{busy==='save'?t('Сохраняю…','Saving…'):t('Сохранить ключ','Save key')}</button>
    {editing&&<button disabled={!!busy} onClick={()=>{setEditing(false);setKey('')}}>{t('Отмена','Cancel')}</button>}</div>
   <p className="tiny muted">{t('Где взять: панель CloudCompute → «Доступ к API» → создать ключ. Вводится один раз.','Where: CloudCompute panel → “API access” → create a key. Entered once.')}</p>
  </div>:<div className="row">
   <button disabled={!!busy||!caps.validate} onClick={()=>void run('validate',()=>localApi<CloudView>('/api/cloudcompute/validate',{method:'POST',body:'{}'}))}>{busy==='validate'?t('Проверяю…','Checking…'):t('Проверить ключ','Validate key')}</button>
   <button disabled={!!busy} onClick={()=>setEditing(true)}>{t('Заменить ключ','Replace key')}</button>
   <button className="danger" disabled={!!busy} onClick={remove}>{t('Удалить ключ','Remove key')}</button>
  </div>}
  {!view.contract.verified&&<div className="notice">
   {t('Управление инстансами через API пока недоступно: точные методы CloudCompute API (адреса, параметры, ответы) ещё не сверены с официальной документацией, а угадывать их для платных операций нельзя. Ключ уже можно сохранить. Запускайте и останавливайте инстанс в панели CloudCompute; подключение движка работает как прежде.','Instance control through the API is not available yet: the exact CloudCompute API methods have not been verified against the official documentation, and guessing them for billable operations is not acceptable. You can already save the key. Start and stop the instance in the CloudCompute panel; the engine connection works as before.')}
   {view.contract.error&&<div className="tiny danger" style={{marginTop:6}}>{view.contract.error}</div>}
   <div className="row tiny" style={{marginTop:6}}><a href={view.docs_url} target="_blank" rel="noopener noreferrer">{t('Документация API','API documentation')}</a><a href={view.panel_url} target="_blank" rel="noopener noreferrer">{t('Панель CloudCompute','CloudCompute panel')}</a></div>
  </div>}
  {view.contract.verified&&<p className="tiny muted">{t('Описание API проверено: ','API description verified: ')}{view.contract.verified_against}</p>}
  {view.configured&&caps.list&&<div className="stack">
   <div className="row" style={{justifyContent:'space-between'}}><b className="tiny">{t('GPU-инстансы','GPU instances')}</b><button disabled={!!busy} onClick={()=>void run('list',()=>localApi<CloudView>('/api/cloudcompute/instances'))}>{busy==='list'?t('Обновляю…','Refreshing…'):t('Обновить','Refresh')}</button></div>
   {view.instances.length===0?<p className="tiny muted">{view.listed_at?t('В аккаунте нет GPU-инстансов. Создайте инстанс в панели CloudCompute.','No GPU instances in the account. Create one in the CloudCompute panel.'):t('Список ещё не загружен.','The list has not been loaded yet.')}</p>:
   <div className="stack" role="radiogroup" aria-label={t('Выбор инстанса','Instance selection')}>{view.instances.map(i=><label key={i.id} className="card row" style={{alignItems:'flex-start',gap:10,cursor:'pointer'}}>
    <input type="radio" name="cc-instance" checked={view.instance_id===i.id} disabled={!!busy} onChange={()=>void run('select',()=>localApi<CloudView>('/api/cloudcompute/select',{method:'POST',body:JSON.stringify({instance_id:i.id})}))}/>
    <span className="stack grow" style={{gap:2,minWidth:0}}><b style={{overflowWrap:'anywhere'}}>{i.name}</b>
     <span className="tiny muted" style={{overflowWrap:'anywhere'}}>{[i.gpu&&(i.gpu_count&&i.gpu_count>1?`${i.gpu_count}× ${i.gpu}`:i.gpu),i.disk_gb!=null&&`${t('диск','disk')} ${i.disk_gb} GB`,i.price_per_hour!=null&&`${i.price_per_hour} ₽/${t('ч','h')}`].filter(Boolean).join(' · ')||i.id}</span></span>
    <span className={'tiny'+(i.status==='ERROR'?' danger':'')} style={{whiteSpace:'nowrap'}}>{statusName[i.status]}{i.provider_status&&i.status==='UNKNOWN'?` (${i.provider_status})`:''}</span>
   </label>)}</div>}
   {selected&&<div className="row">
    {caps.start&&<button disabled={!!busy||!['STOPPED'].includes(selected.status)} onClick={()=>lifecycle(selected,'start')}>{busy==='start'?t('Запускаю…','Starting…'):t('Запустить инстанс','Start instance')}</button>}
    {caps.stop&&<button className="danger" disabled={!!busy||!['RUNNING','STARTING'].includes(selected.status)} onClick={()=>lifecycle(selected,'stop')}>{busy==='stop'?t('Останавливаю…','Stopping…'):t('Остановить инстанс','Stop instance')}</button>}
    {(!caps.start||!caps.stop)&&<span className="tiny muted">{t('Запуск/остановка — в панели CloudCompute (метод API не описан).','Start/stop in the CloudCompute panel (API method not described).')}</span>}
   </div>}
   <p className="tiny muted">{t('Удаление инстанса здесь не предусмотрено: оно уничтожает диск с моделями. Удаляйте только в панели CloudCompute.','Deleting an instance is not offered here: it destroys the disk with the models. Delete only in the CloudCompute panel.')}</p>
  </div>}
  {(error||view.error)&&<div className="notice dangernotice" role="alert">{error||(english&&EN[view.code]?EN[view.code]:view.error)}</div>}
 </div>;
}
