import type {LiveJob} from './Generator';
import {useI18n} from '@/i18n';
import {Meter} from './ui';
/** Stage derived only from the job record the server returned (same rules as v1.8.1). */
export function stageOf(job:LiveJob){return job.connection_error?'CONNECTION_LOST':job.status==='COMPLETED'?'DONE':job.status==='QUEUED'?'PENDING':['FAILED','CANCELLED','INTERRUPTED','CONNECTION_LOST'].includes(job.status)?job.status:job.progress?.stage||'PREPARING'}
export function JobProgress({job}:{job:LiveJob}){
 const {t,tv}=useI18n();const p=job.progress;const stage=stageOf(job);
 const tone=stage==='DONE'?'ok':['FAILED','CANCELLED','INTERRUPTED','CONNECTION_LOST'].includes(stage)?'bad':'warn';
 return <div className="stack" style={{overflowWrap:'anywhere',gap:6}} data-localized="true">
  <div className="row" style={{justifyContent:'space-between'}}><span className="status" data-tone={tone}><span className="dot"/>{tv('stage',stage)}</span><span className="tiny muted">{t('job.id')}: {job.id.slice(0,8)}</span></div>
  {p&&<><Meter value={stage==='DONE'?100:p.percent??0} tone={stage==='DONE'?'ok':undefined} label={tv('stage',stage)}/><span className="tiny">{t('job.diffusion',{step:p.step??0,total:p.total_steps??0,pct:p.percent??0})}</span>
   <span className="tiny muted">{t('job.elapsed')}: {p.elapsed_seconds===undefined?'—':Math.round(p.elapsed_seconds)+' '+t('job.sec')} · {t('job.eta')}: {stage==='GENERATING'&&p.eta_seconds!=null?Math.ceil(p.eta_seconds)+' '+t('job.sec'):'—'}</span></>}
  <span className="tiny muted">{t('job.position')}: {job.queue_position??'—'} · {t('job.pending')}: {job.pending_jobs??'—'}</span>
  {stage==='DECODING'||stage==='SAVING'?<span className="tiny">{t('job.postSteps')}</span>:null}
  {job.connection_error&&<span className="notice">{job.connection_error}</span>}
  {job.error&&<span className="notice dangernotice">{job.error}</span>}
 </div>;
}
