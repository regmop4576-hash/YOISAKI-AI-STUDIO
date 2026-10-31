import {useState} from 'react';
import {Trash2,Eye,X} from './icons';
import {localApi} from '@/lib/local-api';
import {JobProgress} from './JobProgress';
import type {LiveJob} from './Generator';
import {useI18n} from '@/i18n';
import {toast} from './ui';
export function JobHistory({items,error,onSelect,onChange,onMutation}:{items:LiveJob[];error:string;onSelect:(j:LiveJob)=>void;onChange:(items:LiveJob[])=>void;onMutation:()=>void}){
 const {t,tv}=useI18n();const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const inactive=items.filter(j=>j.terminal),active=items.filter(j=>!j.terminal);
 async function mutate(url:string,method:string,body?:unknown,ok?:string){
  setBusy(true);setMessage('');onMutation();
  try{const result=await localApi<{items:LiveJob[]}>(url,{method,...(body?{body:JSON.stringify(body)}:{})});onChange(result.items);if(ok)toast('ok',ok)}catch(e){setMessage((e as Error).message)}finally{onMutation();setBusy(false)}
 }
 function clean(scope:string){
  const selected=inactive.filter(j=>j.can_delete&&(scope==='all'||(scope==='completed'?j.status==='COMPLETED':j.status!=='COMPLETED')));
  if(!selected.length)return;
  const label=scope==='completed'?t('history.scopeOk'):scope==='unsuccessful'?t('history.scopeBad'):t('history.scopeAll');
  if(confirm(t('history.cleanConfirm',{n:selected.length,label})))void mutate('/api/history/cleanup','POST',{scope,ids:selected.map(j=>j.id)},t('history.cleaned'));
 }
 function card(j:LiveJob){return <div className="card stack" style={{gap:6}} key={j.id}>
  <div className="row"><span className="tiny grow"><b className="gold">{tv('status',j.status)}</b> · {j.id.slice(0,8)}</span>{(j.can_delete||j.status==='CONNECTION_LOST')&&<button type="button" className="pill danger" disabled={busy} aria-label={t('history.deleteRecord',{id:j.id})} style={{minWidth:44,minHeight:44}} onClick={()=>{
   if(j.status==='CONNECTION_LOST'&&!confirm(t('history.lostConfirm')))return;
   void mutate('/api/history/'+j.id,'DELETE',undefined,t('history.deleted'));
  }}><Trash2 size={16}/>{j.status==='CONNECTION_LOST'?t('history.checkDelete'):null}</button>}</div>
  <details open={j.status==='RUNNING'||j.status==='QUEUED'}><summary className="tiny">{t('history.details')}</summary><JobProgress job={error&&!j.terminal?{...j,connection_error:error}:j}/><div className="row" style={{marginTop:6}}><button type="button" className="pill" onClick={()=>onSelect(j)}><Eye size={15}/>{t('history.show')}</button>{!j.terminal&&<button type="button" className="pill danger" disabled={busy} onClick={async()=>{
   setBusy(true);onMutation();try{await localApi('/api/gpu/jobs/'+j.id,{method:'DELETE'});const x=await localApi<{items:LiveJob[]}>('/api/history');onChange(x.items);toast('info',t('gen.cancelSent'))}catch(e){setMessage((e as Error).message)}finally{onMutation();setBusy(false)}
  }}><X size={15}/>{t('gen.cancelJob')}</button>}</div></details>
 </div>}
 return <div className="stack" style={{gap:8}} data-localized="true">
  {(error||message)&&<div role="alert" className="notice dangernotice">{message||error}</div>}
  {active.map(card)}
  {active.some(j=>j.status==='CONNECTION_LOST')&&<p className="tiny muted">{t('history.lostNote')}</p>}
  <div className="row" style={{justifyContent:'space-between'}}><span className="tiny">{t('history.kept',{n:inactive.length})}</span><details><summary className="tiny">{t('history.clean')}</summary><div className="stack" style={{gap:6}}>
   <button type="button" disabled={busy||!inactive.some(j=>j.can_delete&&j.status==='COMPLETED')} onClick={()=>clean('completed')}>{t('history.cleanOk')}</button>
   <button type="button" disabled={busy||!inactive.some(j=>j.can_delete&&j.status!=='COMPLETED')} onClick={()=>clean('unsuccessful')}>{t('history.cleanBad')}</button>
   <button type="button" className="danger" disabled={busy||!inactive.some(j=>j.can_delete)} onClick={()=>clean('all')}>{t('history.cleanAll')}</button>
  </div></details></div>
  <details><summary className="tiny">{t('history.title',{n:inactive.length})}</summary><div className="stack" style={{gap:8}}>{inactive.length?inactive.map(card):<p className="tiny muted">{t('history.empty')}</p>}</div></details>
 </div>;
}
