import {useState} from 'react';
import {Trash2} from 'lucide-react';
import {localApi} from '@/lib/local-api';
import {JobProgress} from './JobProgress';
import type {LiveJob} from './Generator';
export function JobHistory({items,error,onSelect,onChange,onMutation}:{items:LiveJob[];error:string;onSelect:(j:LiveJob)=>void;onChange:(items:LiveJob[])=>void;onMutation:()=>void}){
 const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const inactive=items.filter(j=>j.terminal),active=items.filter(j=>!j.terminal);
 async function mutate(url:string,method:string,body?:unknown){
  setBusy(true);setMessage('');onMutation();
  try{const result=await localApi<{items:LiveJob[]}>(url,{method,...(body?{body:JSON.stringify(body)}:{})});onChange(result.items)}catch(e){setMessage((e as Error).message)}finally{onMutation();setBusy(false)}
 }
 function clean(scope:string){
  const selected=inactive.filter(j=>j.can_delete&&(scope==='all'||(scope==='completed'?j.status==='COMPLETED':j.status!=='COMPLETED')));
  if(!selected.length)return;
  const label=scope==='completed'?'успешных':scope==='unsuccessful'?'неуспешных':'завершённых';
  if(confirm(`Удалить ${selected.length} ${label} записей истории? Изображения, избранное и параметры в галерее сохранятся. Активные задания и задания с неподтверждённым статусом останутся.`))void mutate('/api/history/cleanup','POST',{scope,ids:selected.map(j=>j.id)});
 }
 function card(j:LiveJob){return <div className="card stack" key={j.id}>
  <div className="row"><span className="tiny grow">{j.status} · {j.id.slice(0,8)}</span>{(j.can_delete||j.status==='CONNECTION_LOST')&&<button disabled={busy} aria-label={'Удалить запись '+j.id} style={{minWidth:44,minHeight:44}} onClick={()=>{
   if(j.status==='CONNECTION_LOST'&&!confirm('Проверить статус на GPU и удалить запись только после подтверждения завершения? Изображения сохранятся.'))return;
   void mutate('/api/history/'+j.id,'DELETE');
  }}><Trash2 size={17}/>{j.status==='CONNECTION_LOST'?'Проверить и удалить':null}</button>}</div>
  <details open={j.status==='RUNNING'||j.status==='QUEUED'}><summary>Подробности задания</summary><JobProgress job={error&&!j.terminal?{...j,connection_error:error}:j}/><div className="row"><button onClick={()=>onSelect(j)}>Показать</button>{!j.terminal&&<button disabled={busy} onClick={async()=>{
   setBusy(true);onMutation();try{await localApi('/api/gpu/jobs/'+j.id,{method:'DELETE'});const x=await localApi<{items:LiveJob[]}>('/api/history');onChange(x.items)}catch(e){setMessage((e as Error).message)}finally{onMutation();setBusy(false)}
  }}>Отменить</button>}</div></details>
 </div>}
 return <div className="stack">
  {(error||message)&&<div role="alert" className="notice">{message||error}</div>}
  {active.map(card)}
  {active.some(j=>j.status==='CONNECTION_LOST')&&<p className="tiny muted">Потеря связи не подтверждает завершение. Такие задания не удаляются автоматически.</p>}
  <div className="row" style={{justifyContent:'space-between'}}><span className="tiny">Сохранено завершённых: {inactive.length} / 50</span><details><summary>Очистить ▾</summary><div className="stack">
   <button disabled={busy||!inactive.some(j=>j.can_delete&&j.status==='COMPLETED')} onClick={()=>clean('completed')}>Удалить успешные</button>
   <button disabled={busy||!inactive.some(j=>j.can_delete&&j.status!=='COMPLETED')} onClick={()=>clean('unsuccessful')}>Удалить неуспешные</button>
   <button disabled={busy||!inactive.some(j=>j.can_delete)} onClick={()=>clean('all')}>Удалить все завершённые</button>
  </div></details></div>
  <details><summary>История генераций ({inactive.length})</summary><div className="stack">{inactive.length?inactive.map(card):<p className="tiny muted">Нет завершённых записей.</p>}</div></details>
 </div>
}
