import {useEffect,useState} from 'react';
import {localApi} from '@/lib/local-api';
import {useDirect} from '@/lib/engine/direct';
import {useStudio} from '@/stores/studio';

type Folder={id:string;name:string};
type View={configured:boolean;client_id:string;connected:boolean;account:{email:string;name:string}|null;folder:Folder|null;last_result:{ok:boolean;message:string}|null};
export function GoogleAccount(){
 const en=useStudio(s=>s.language)==='English',t=(ru:string,eng:string)=>en?eng:ru;
 const gpu=useDirect();const [view,setView]=useState<View|null>(null),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 const [client,setClient]=useState(''),[secret,setSecret]=useState(''),[settings,setSettings]=useState(false);
 const [folders,setFolders]=useState<Folder[]>([]),[trail,setTrail]=useState<Folder[]>([{id:'root',name:'My Drive'}]),[page,setPage]=useState<string|null>(null),[browsing,setBrowsing]=useState(false),[folderLink,setFolderLink]=useState('');
 const load=async()=>{const v=await localApi<View>('/api/drive/oauth');setView(v);return v};
 useEffect(()=>{load().then(v=>{if(new URLSearchParams(location.search).get('drive_auth')==='1'){history.replaceState(null,'',location.pathname);if(v.last_result)(v.last_result.ok?setMessage:setError)(v.last_result.message)}}).catch(e=>setError(e.message))},[]);
 async function run(fn:()=>Promise<unknown>){setBusy(true);setError('');setMessage('');try{await fn()}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 async function browse(next=trail,more=false){const p=next[next.length-1];const data=await localApi<{folders:Folder[];next_page:string|null}>('/api/drive/folders?'+new URLSearchParams({parent:p.id,...(more&&page?{page}:{})}));setFolders(old=>more?[...old,...data.folders]:data.folders);setTrail(next);setPage(data.next_page);setBrowsing(true)}
 async function choose(id:string){await localApi('/api/drive/folder',{method:'PUT',body:JSON.stringify({id})});await load();setBrowsing(false);setMessage(t('Папка сохранена на телефоне.','Folder saved on this device.'))}
 return <section className="panel stack" data-localized="true" aria-label="Google account">
  <h2>GOOGLE DRIVE · {t('АККАУНТ И ПАПКА','ACCOUNT & FOLDER')}</h2>
  <p className="tiny muted">{t('Вход и выбор папки работают без GPU. У каждого пользователя — свой Google-аккаунт.','Sign in and choose a folder without a GPU. Each user connects their own Google account.')}</p>
  {view?.connected&&<div className="notice">{view.account?.email}<br/>{t('Папка моделей: ','Model folder: ')}<b>{view.folder?.name||t('не выбрана','not selected')}</b></div>}
  <div className="row">
   <button className="primary" disabled={busy||!view?.configured} onClick={()=>void run(async()=>{const r=await localApi<{url:string}>('/api/drive/oauth/start',{method:'POST',body:'{}'});location.href=r.url})}>{view?.connected?t('Сменить Google-аккаунт','Change Google account'):t('Войти в Google','Sign in with Google')}</button>
   {view?.connected&&<><button disabled={busy} onClick={()=>void run(()=>browse([{id:'root',name:'My Drive'}]))}>{t('Выбрать папку','Choose folder')}</button>
    <button disabled={busy||!view.folder||!gpu.url||gpu.provider!=='cloudcompute'} onClick={()=>void run(async()=>{await localApi('/api/drive/bind',{method:'POST',body:'{}'});setMessage(t('Доступ передан GPU. Ниже нажмите «Проверить модели».','Access sent to GPU. Press “Check models” below.'));window.dispatchEvent(new Event('yoisaki-drive-bound'))})}>{t('Использовать на подключённом GPU','Use on connected GPU')}</button>
    <button disabled={busy} onClick={()=>void run(async()=>{await localApi('/api/drive/account',{method:'DELETE'});await load();setFolders([]);setBrowsing(false);setMessage(t('Доступ удалён с телефона. Копия на GPU отключается в панели синхронизации.','Access removed from this device. Disconnect the GPU copy in the sync panel.'))})}>{t('Выйти на телефоне','Disconnect this device')}</button></>}
   <button disabled={busy} onClick={()=>setSettings(!settings)}>{t('Настройка OAuth','OAuth settings')}</button>
  </div>
  {!view?.configured&&<p className="notice">{t('В сборке ещё не настроен OAuth-клиент Google. Автор сборки может настроить его один раз для пользователей; также можно указать свой клиент ниже.','This build has no Google OAuth client configured yet. The publisher can configure one for all users, or you can supply your own below.')}</p>}
  {(settings||view&&!view.configured)&&<div className="card stack">
   <p className="tiny">{t('Google Cloud → включить Google Drive API → настроить экран согласия и тестовых пользователей → создать OAuth client типа Desktop app. Для распространения сборки: config/google-desktop-client.json. Подробности в docs/INTEGRATIONS_SETUP_RU.md.','Google Cloud → enable Drive API → configure consent and test users → create a Desktop app OAuth client. Publishers: config/google-desktop-client.json. See docs/INTEGRATIONS_SETUP_RU.md.')}</p>
   <label className="field">Google Client ID<input value={client} autoComplete="off" onChange={e=>setClient(e.target.value)}/></label>
   <label className="field">Google Client Secret<input type="password" value={secret} autoComplete="off" onChange={e=>setSecret(e.target.value)}/></label>
   <button disabled={busy||!client||!secret} onClick={()=>void run(async()=>{setView(await localApi<View>('/api/drive/oauth',{method:'PUT',body:JSON.stringify({client_id:client,client_secret:secret})}));setSecret('');setSettings(false)})}>{t('Сохранить настройки','Save settings')}</button>
  </div>}
  {browsing&&<div className="card stack">
   <div className="row">{trail.map((f,i)=><button disabled={busy} key={f.id} onClick={()=>void run(()=>browse(trail.slice(0,i+1)))}>{f.name}</button>)}</div>
   <p className="tiny">{t('Выберите папку, внутри которой находятся checkpoints/, loras/ и vae/.','Choose the folder containing checkpoints/, loras/ and vae/.')}</p>
   {folders.map(f=><div className="row" key={f.id}><span className="grow" style={{overflowWrap:'anywhere'}}>{f.name}</span><button disabled={busy} onClick={()=>void run(()=>browse([...trail,f]))}>{t('Открыть','Open')}</button><button disabled={busy} onClick={()=>void run(()=>choose(f.id))}>{t('Выбрать','Select')}</button></div>)}
   {!folders.length&&<p>{t('Вложенных папок нет.','No subfolders.')}</p>}
   {page&&<button disabled={busy} onClick={()=>void run(()=>browse(trail,true))}>{t('Ещё папки','More folders')}</button>}
   <button disabled={busy} onClick={()=>void run(()=>choose(trail[trail.length-1].id))}>{t('Выбрать текущую папку','Select current folder')}</button>
   <label className="field">{t('Или ссылка / ID общей папки','Or shared folder link / ID')}<input value={folderLink} onChange={e=>setFolderLink(e.target.value)}/></label>
   <button disabled={busy||!folderLink} onClick={()=>void run(()=>choose(folderLink.match(/\/folders\/([A-Za-z0-9_-]+)/)?.[1]||folderLink.trim()))}>{t('Проверить и выбрать','Verify and select')}</button>
  </div>}
  {busy&&<progress aria-label={t('Запрос Google','Google request')}/>}
  {error&&<p className="notice dangernotice" role="alert">{error}</p>}{message&&<p className="notice" role="status">{message}</p>}
  <p className="tiny muted">{t('Доступ только на чтение. Токены хранятся в закрытом каталоге приложения и обновляются автоматически. Пароль Google вводится только на странице Google.','Read-only access. Tokens stay in the app’s private directory and refresh automatically. Enter your Google password only on Google’s page.')}</p>
 </section>;
}
