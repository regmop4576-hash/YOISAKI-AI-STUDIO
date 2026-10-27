import {useEffect,useRef,useState} from 'react';
import {localApi} from '@/lib/local-api';
import {useStudio} from '@/stores/studio';
type Instance={id:string;name:string;status:string;gpu:string;label:string};
export function CloudComputeAPI(){
 const en=useStudio(s=>s.language)==='English',t=(r:string,e:string)=>en?e:r;
 const [configured,setConfigured]=useState(false),[key,setKey]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[items,setItems]=useState<Instance[]>([]),[updated,setUpdated]=useState<number|null>(null),[stale,setStale]=useState(true),[creating,setCreating]=useState(false);
 const [ask,setAsk]=useState(''),[name,setName]=useState('YOISAKI'),[image,setImage]=useState(''),[disk,setDisk]=useState('80'),[price,setPrice]=useState('');const loading=useRef(false);
 async function refresh(){if(loading.current)return;loading.current=true;try{const r=await localApi<{instances:Instance[];updated_at:number}>('/api/cloudcompute/instances');setItems(r.instances);setUpdated(r.updated_at);setStale(false);setError('')}catch(e){setStale(true);setError((e as Error).message)}finally{loading.current=false}}
 useEffect(()=>{localApi<{configured:boolean}>('/api/cloudcompute/config').then(r=>setConfigured(r.configured)).catch(e=>setError(e.message))},[]);
 useEffect(()=>{if(!configured)return;void refresh();const id=setInterval(()=>{if(document.visibilityState==='visible')void refresh()},15000);return()=>clearInterval(id)},[configured]);
 async function run(fn:()=>Promise<unknown>){setBusy(true);setError('');try{await fn()}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 return <section className="panel stack" data-localized="true" aria-label="CloudCompute REST API">
  <h2>CLOUDCOMPUTE REST API</h2>
  <p className="tiny muted">{t('Управление арендой GPU. API-ключ хранится на локальном сервере и не передаётся движку. Подключение генератора настраивается отдельно ниже.','Manage GPU rentals. The API key stays on the local server and is never sent to the engine. Configure the generator connection separately below.')}</p>
  <label className="field">{t('API-ключ CloudCompute','CloudCompute API key')}<input type="password" autoComplete="off" spellCheck={false} value={key} placeholder={configured?t('Ключ сохранён · новый ключ для замены','Key saved · enter a replacement'):'cc-…'} onChange={e=>setKey(e.target.value)}/></label>
  <div className="row"><button className="primary" disabled={busy||!key.trim()} onClick={()=>void run(async()=>{await localApi('/api/cloudcompute/config',{method:'PUT',body:JSON.stringify({key:key.trim()})});setKey('');setConfigured(true);await refresh()})}>{t('Проверить и сохранить','Validate and save')}</button>
   {configured&&<><button disabled={busy} onClick={()=>void run(refresh)}>{t('Обновить инстансы','Refresh instances')}</button><button disabled={busy} onClick={()=>void run(async()=>{await localApi('/api/cloudcompute/config',{method:'DELETE'});setConfigured(false);setItems([]);setUpdated(null);setStale(true)})}>{t('Удалить ключ с телефона','Remove key from device')}</button></>}
  </div>
  {configured&&<>
   <p className="tiny" role="status">{stale?t('Список не подтверждён; показаны последние полученные данные.','List is unverified; showing last received data.'):t('Статусы получены от CloudCompute.','Statuses received from CloudCompute.')}{updated?' · '+new Date(updated).toLocaleTimeString():''}</p>
   {!items.length&&!stale&&<p>{t('Инстансов нет.','No instances.')}</p>}
   {items.map(i=><div className="card stack" key={i.id}><b style={{overflowWrap:'anywhere'}}>{i.name} · #{i.id}</b><div className="tiny">{i.gpu||'GPU'} · {i.status}{stale?' · '+t('устарело','stale'):''}</div><div className="row">
    <button disabled={busy||stale} onClick={()=>void run(async()=>{const n=prompt(t('Новое имя инстанса','New instance name'),i.name);if(!n)return;await localApi('/api/cloudcompute/instances/'+encodeURIComponent(i.id),{method:'PATCH',body:JSON.stringify({name:n})});await refresh()})}>{t('Переименовать','Rename')}</button>
    <button className="danger" disabled={busy||stale} onClick={()=>void run(async()=>{const answer=prompt(t(`Удаление инстанса может уничтожить его диск. Введите ID ${i.id} для подтверждения.`,`Deleting the instance may destroy its disk. Enter ID ${i.id} to confirm.`));if(answer!==i.id)return;await localApi('/api/cloudcompute/instances/'+encodeURIComponent(i.id),{method:'DELETE',body:JSON.stringify({confirm_id:i.id})});await refresh()})}>{t('Удалить инстанс','Delete instance')}</button>
   </div></div>)}
   <button disabled={busy} onClick={()=>setCreating(!creating)}>{t('Создать инстанс из Docker-образа','Create instance from Docker image')}</button>
   {creating&&<div className="card stack">
    <p className="tiny">{t('Используйте доступное предложение и опубликованный образ YOISAKI. Создание платное. Инструкция сборки образа и подключения постоянного диска: docs/INTEGRATIONS_SETUP_RU.md.','Use an available offer and a published YOISAKI image. Creation incurs charges. Image and persistent-disk setup: docs/INTEGRATIONS_SETUP_RU.md.')}</p>
    <label className="field">Offer / ask_id<input inputMode="numeric" value={ask} onChange={e=>setAsk(e.target.value)}/></label>
    <label className="field">{t('Имя','Name')}<input value={name} onChange={e=>setName(e.target.value)}/></label>
    <label className="field">Docker image<input value={image} placeholder="registry/owner/yoisaki:version" onChange={e=>setImage(e.target.value)}/></label>
    <label className="field">{t('Диск, ГБ','Disk, GB')}<input type="number" min="8" value={disk} onChange={e=>setDisk(e.target.value)}/></label>
    <label className="field">{t('Лимит цены, ₽/час','Price ceiling, RUB/hour')}<input type="number" min="0.01" step="0.01" value={price} onChange={e=>setPrice(e.target.value)}/></label>
    <button className="primary" disabled={busy||!ask||!image||!price} onClick={()=>void run(async()=>{if(!confirm(t(`Создать платный инстанс с лимитом ${price} ₽/час?`,`Create a paid instance with a ceiling of ${price} RUB/hour?`)))return;await localApi('/api/cloudcompute/instances',{method:'POST',body:JSON.stringify({confirm:true,instance:{ask_id:Number(ask),name,template_image:image,disk_gb:Number(disk),max_price_hour_minor:Math.round(Number(price)*100),currency:'RUB'}})});setCreating(false);await refresh()})}>{t('Создать платный инстанс','Create paid instance')}</button>
   </div>}
   <p className="tiny muted">{t('Start / Stop / Restart для GPU-инстансов не описаны в официальном API. Эти команды здесь не отправляются.','Start / Stop / Restart are not documented for GPU instances. Those commands are not sent.')}</p>
  </>}
  {busy&&<progress aria-label={t('Запрос CloudCompute','CloudCompute request')}/>}{error&&<p className="notice dangernotice" role="alert">{error}</p>}
 </section>;
}
