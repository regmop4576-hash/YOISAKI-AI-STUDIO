import {STUDIO_VERSION} from './lib/release';
import {createRoot} from 'react-dom/client';
import {Component,type ReactNode} from 'react';
import {Shell} from './components/Shell';
import {usePathname,navigate} from './compat/navigation';
import Generate from './app/generate/page';
import Edit from './app/edit/page';
import Models from './app/models/page';
import Gallery from './app/gallery/page';
import Engine from './app/engine/page';
import {useDirect} from './lib/engine/direct';
import {localApi} from './lib/local-api';
import {useStudio} from './stores/studio';
import './app/globals.css';
class ErrorBoundary extends Component<{children:ReactNode},{error:boolean}>{state={error:false};static getDerivedStateFromError(){return {error:true}}render(){return this.state.error?<div className="page notice">Ошибка интерфейса. <button onClick={()=>location.reload()}>Перезагрузить</button></div>:this.props.children}}
function App(){const path=usePathname();const Page=({'/generate':Generate,'/edit':Edit,'/models':Models,'/gallery':Gallery,'/engine':Engine} as Record<string,typeof Generate>)[path]||Generate;return <ErrorBoundary><Shell><Page/></Shell></ErrorBoundary>}
async function boot(){
 const session=await localApi<{version:string}>('/api/session');
 if(session.version!==STUDIO_VERSION){document.getElementById('root')!.textContent=`Версии интерфейса (${STUDIO_VERSION}) и локального сервера (${session.version}) различаются. Выполните bash stop.sh и bash start.sh в установленной папке, затем обновите страницу.`;return;}
 await useStudio.persist.rehydrate();
 await useDirect.getState().refresh();
 if(location.pathname==='/')history.replaceState(null,'','/generate');
 createRoot(document.getElementById('root')!).render(<App/>);
 let pending=false;
 setInterval(()=>{if(document.visibilityState==='visible'&&!pending&&useDirect.getState().url){pending=true;useDirect.getState().refresh().finally(()=>{pending=false})}},30000);
}
boot().catch(()=>{const el=document.getElementById('root')!;el.textContent='Не удалось открыть локальное хранилище. Перезапустите ./start.sh и обновите страницу.'});
