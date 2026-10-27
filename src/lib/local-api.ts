let sessionReady:Promise<void>|null=null;
export async function localFetch(path:string,init:RequestInit={}):Promise<Response>{
 if(path!=='/api/session')await (sessionReady??=fetch('/api/session',{credentials:'same-origin',headers:{'X-Yoisaki-Local':'1'}}).then(r=>{if(!r.ok)throw Error('Локальная сессия недоступна')}));
 const ctrl=new AbortController();const t=setTimeout(()=>ctrl.abort(),95000);
 try{
 const r=await fetch(path,{...init,credentials:'same-origin',cache:'no-store',signal:init.signal||ctrl.signal,headers:{'X-Yoisaki-Local':'1',...(init.body&&typeof init.body==='string'?{'Content-Type':'application/json'}:{}),...init.headers}});
 if(!r.ok){let msg='Ошибка локального API: HTTP '+r.status,code='HTTP_ERROR';try{const x=await r.json();msg=x.error||msg;code=x.code||code}catch{}throw Object.assign(Error(msg),{code})}return r;
 }catch(e){if((e as Error).name==='AbortError')throw Error('Локальный сервер не ответил. Проверьте Termux; статус задания можно восстановить после обновления.');throw e}finally{clearTimeout(t)}
}
export async function localApi<T>(path:string,init?:RequestInit):Promise<T>{return (await localFetch(path,init)).json() as Promise<T>}
