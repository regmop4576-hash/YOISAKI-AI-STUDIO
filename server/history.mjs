export const TERMINAL_STATUSES=['COMPLETED','FAILED','CANCELLED','INTERRUPTED'];
export const HISTORY_LIMIT=50;
export const isTerminal=j=>TERMINAL_STATUSES.includes(j.status);
export const matchesHistory=(j,scope)=>isTerminal(j)&&(scope==='all'||(scope==='completed'?j.status==='COMPLETED':j.status!=='COMPLETED'));
export function pruneHistory(history){
 const terminal=history.filter(isTerminal);
 if(terminal.length<=HISTORY_LIMIT)return history;
 const time=j=>Number.isFinite(j.updated)?j.updated:Number.isFinite(j.created)?j.created:0;
 const keep=new Set(terminal.map((j,index)=>({j,index})).sort((a,b)=>time(b.j)-time(a.j)||a.index-b.index).slice(0,HISTORY_LIMIT).map(x=>x.j.id));
 return history.filter(j=>!isTerminal(j)||keep.has(j.id));
}
