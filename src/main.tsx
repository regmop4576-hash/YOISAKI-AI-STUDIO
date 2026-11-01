import {STUDIO_VERSION,STUDIO_BUILD} from './lib/release';
import {createRoot} from 'react-dom/client';
import {Component,type ReactNode} from 'react';
import {Shell} from './components/Shell';
import {usePathname,navigate} from './compat/navigation';
import Generate from './app/generate/page';
import Edit from './app/edit/page';
import Models from './app/models/page';
import Gallery from './app/gallery/page';
import Engine from './app/engine/page';
import Settings from './app/settings/page';
import {useDirect} from './lib/engine/direct';
import {localApi} from './lib/local-api';
import {useStudio} from './stores/studio';
import './app/globals.css';
class ErrorBoundary extends Component<{children:ReactNode},{error:boolean}>{state={error:false};static getDerivedStateFromError(){return {error:true}}render(){return this.state.error?<div className="page"><div className="notice dangernotice row" role="alert">Ошибка интерфейса. Данные и галерея не затронуты. <button onClick={()=>location.reload()}>Перезагрузить</button></div></div>:this.props.children}}
function App(){const path=usePathname();const Page=({'/generate':Generate,'/edit':Edit,'/models':Models,'/gallery':Gallery,'/engine':Engine,'/settings':Settings} as Record<string,typeof Generate>)[path]||Generate;return <ErrorBoundary><Shell><Page/></Shell></ErrorBoundary>}
async function boot(){
 const session=await localApi<{version:string;build?:string}>('/api/session');
 // Same version 1.9.2, different build: the browser still runs JS of the previous installation. Reload once
 // bypassing the cache; if that does not help, say so instead of running mismatched code.
 if(session.version===STUDIO_VERSION&&session.build&&STUDIO_BUILD!=='dev'&&session.build!==STUDIO_BUILD){
  let retried=false;try{retried=sessionStorage.getItem('yoisaki-build-reload')===session.build;sessionStorage.setItem('yoisaki-build-reload',session.build)}catch{}
  if(!retried){location.reload();return}
  document.getElementById('root')!.textContent=`Браузер показывает старую сборку (${STUDIO_BUILD}), а сервер работает со сборкой ${session.build}. Закройте вкладку и откройте http://127.0.0.1:3000 заново или очистите кэш этого сайта (данные и галерея хранятся в Termux и не удаляются).`;return;
 }
 try{sessionStorage.removeItem('yoisaki-build-reload')}catch{}
 if(session.version!==STUDIO_VERSION){document.getElementById('root')!.textContent=`Версии интерфейса (${STUDIO_VERSION}) и локального сервера (${session.version}) различаются. Выполните bash stop.sh и bash start.sh в установленной папке, затем обновите страницу.`;return;}
 await useStudio.persist.rehydrate();
 if(location.pathname==='/')history.replaceState(null,'','/generate');
 createRoot(document.getElementById('root')!).render(<App/>);
 // v1.7.3: a page reload also re-reads the GPU model list (in the background, after the first paint).
 void useDirect.getState().refresh(true);
 // Read the local snapshot promptly; upstream health remains separately rate limited.
 let snapshotPending=false;
 setInterval(()=>{if(document.visibilityState==='visible'&&!snapshotPending&&useDirect.getState().url){snapshotPending=true;useDirect.getState().poll().finally(()=>{snapshotPending=false})}},3000);
 let pending=false;
 setInterval(()=>{if(document.visibilityState==='visible'&&!pending&&useDirect.getState().url){pending=true;useDirect.getState().refresh().finally(()=>{pending=false})}},30000);
 // A tab left open across `yoisaki update` keeps running the previous build's JS (same version 1.9.2).
 // Detect it when the tab becomes visible and ask for a reload instead of silently mixing builds.
 const checkBuild=()=>{if(document.visibilityState!=='visible'||STUDIO_BUILD==='dev'||document.getElementById('yoisaki-build-banner'))return;fetch('/api/session',{credentials:'same-origin',cache:'no-store',headers:{'X-Yoisaki-Local':'1'}}).then(r=>r.ok?r.json():null).then((x:{build?:string}|null)=>{if(!x?.build||x.build===STUDIO_BUILD)return;const b=document.createElement('div');b.id='yoisaki-build-banner';b.setAttribute('role','alert');b.className='notice dangernotice';b.style.cssText='position:fixed;left:8px;right:8px;top:8px;z-index:9999';b.textContent=`Установлена другая сборка (${x.build}); эта вкладка работает со старой (${STUDIO_BUILD}). `;const btn=document.createElement('button');btn.textContent='Обновить страницу';btn.onclick=()=>location.reload();b.append(btn);document.body.append(b)}).catch(()=>{})};
 document.addEventListener('visibilitychange',checkBuild);setInterval(checkBuild,60000);
}
boot().catch(()=>{const el=document.getElementById('root')!;el.textContent='Не удалось открыть локальное хранилище. Перезапустите ./start.sh и обновите страницу.'});
