'use client';
// v1.9.0 PIXEL FANTASY · GPU connection. Connection logic, phases, remembered servers and error codes are the v1.8.1
// ones; every indicator is read from /api/gpu/status (the local server checks the engine health), so READY is never
// shown for an engine that does not answer. CloudCompute is listed only when enabled in Settings or already selected.
import {useEffect,useState} from 'react';
import {CloudComputeAPI} from '@/components/CloudComputeAPI';
import {GpuReadiness} from '@/components/GpuReadiness';
import {useDirect,type Provider,type Phase} from '@/lib/engine/direct';
import {useStudio} from '@/stores/studio';
import {STUDIO_VERSION} from '@/lib/release';
import {localApi} from '@/lib/local-api';
import {PageHead,Modal,toast,ActionButton,gpuTone,SectionTitle,useCloudComputeVisible} from '@/components/ui';
import {Cpu,Power,RefreshCw,ExternalLink,Terminal,Link as LinkIcon,Clock,Database,Monitor,Zap,Server,Boxes,Copy,Warning} from '@/components/icons';
import {useI18n} from '@/i18n';
const ACTIVE:Phase[]=['STARTING','CONNECTING','AUTHENTICATING','LOADING'];
const STEPS:Phase[]=['STARTING','CONNECTING','AUTHENTICATING','LOADING','READY'];
const TARIFF_KEY='yoisaki-gpu-tariff-rub-hour';
function readTariff(){try{const v=Number(localStorage.getItem(TARIFF_KEY));return Number.isFinite(v)&&v>0?v:0}catch{return 0}}
export default function Page(){
 const gpu=useDirect();const english=useStudio(x=>x.language)==='English';const {t:tk}=useI18n();const cc=useCloudComputeVisible();
 const t=(ru:string,en:string)=>english?en:ru;
 const [value,setValue]=useState(gpu.endpoints[gpu.provider]);const [token,setToken]=useState('');
 const [drafts,setDrafts]=useState(gpu.endpoints);
 const [remember,setRemember]=useState(gpu.provider==='cloudcompute');const [notice,setNotice]=useState('');
 const [tariff,setTariff]=useState(readTariff);const [lastJob,setLastJob]=useState(0);const [now,setNow]=useState(Date.now());
 const [events,setEvents]=useState('');const [logs,setLogs]=useState(false);
 useEffect(()=>{setValue(gpu.endpoints[gpu.provider]);setToken('');setDrafts(gpu.endpoints);setRemember(gpu.provider==='cloudcompute');setNotice('')},[gpu.provider]);// eslint-disable-line react-hooks/exhaustive-deps
 const phase:Phase=gpu.phase||(gpu.state==='CONNECTING'?'CONNECTING':gpu.url?'READY':gpu.state==='ERROR'?'ERROR':'OFFLINE');
 const waiting=ACTIVE.includes(phase);
 // While the local server is connecting (possibly waiting minutes for the GPU to boot) follow its phases.
 useEffect(()=>{if(!waiting)return;const id=setInterval(()=>void gpu.poll(),1500);return ()=>clearInterval(id)},[waiting]);// eslint-disable-line react-hooks/exhaustive-deps
 useEffect(()=>{if(!gpu.url)return;const tick=()=>{setNow(Date.now());localApi<{items:{updated?:number;created?:number}[]}>('/api/history').then(x=>setLastJob(Math.max(0,...x.items.map(j=>j.updated||j.created||0)))).catch(()=>{})};tick();const id=setInterval(tick,30000);return ()=>clearInterval(id)},[gpu.url]);
 const saved=gpu.remembered?.[gpu.provider]||null;
 const providerLabel=gpu.provider==='colab'?'Google Colab':'CloudCompute';
 const label=gpu.provider==='colab'?t('URL туннеля Colab','Colab tunnel URL'):t('URL сервера CloudCompute','CloudCompute server URL');
 const names:Record<string,string>={OFFLINE:t('ОТКЛЮЧЁН','OFFLINE'),CONNECTING:t('ПОДКЛЮЧЕНИЕ','CONNECTING'),READY:t('ПОДКЛЮЧЁН','CONNECTED'),BUSY:t('ЗАНЯТ','BUSY'),LOADING:t('ЗАГРУЗКА','LOADING'),ERROR:t('ОШИБКА','ERROR')};
 const phaseNames:Record<Phase,string>={OFFLINE:t('Не подключено','Offline'),STARTING:t('Ожидание запуска GPU','Waiting for the GPU'),CONNECTING:t('Подключение','Connecting'),AUTHENTICATING:t('Проверка доступа','Authenticating'),LOADING:t('Загрузка движка и моделей','Loading engine and models'),READY:t('Готово к генерации','Ready'),ERROR:t('Ошибка','Error')};
 const componentNames:Record<string,string>={frontend:t('Сайт (телефон)','Website (phone)'),tunnel:t('Туннель / адрес','Tunnel / address'),auth:t('Доступ (токен)','Access (token)'),engine:t('Движок и зависимости','Engine and dependencies'),gpu:'GPU / CUDA',models:t('Модели','Models')};
 const stateNames:Record<string,string>={READY:t('ГОТОВ','READY'),WAITING:t('ОЖИДАНИЕ','WAITING'),WARNING:t('ВНИМАНИЕ','WARNING'),ERROR:t('ОШИБКА','ERROR'),UNKNOWN:'—'};
 const noData=t('Нет данных','No data');
 const change=(raw:string)=>{
  const hash=raw.indexOf('#');
  // A pasted protected link is immediately split. The token stays in a password input only.
  if(hash>=0){setValue(raw.slice(0,hash));setToken(new URLSearchParams(raw.slice(hash+1)).get('token')||'')}
  else setValue(raw);
 };
 async function paste(){
  setNotice('');
  try{const text=(await navigator.clipboard.readText()).trim();if(!/^https:\/\/\S+#token=[a-f0-9]{64}$/.test(text)){setNotice(t('В буфере нет полной ссылки движка вида https://…/#token=…','The clipboard has no full engine link https://…/#token=…'));return}change(text);toast('ok',t('Ссылка вставлена','Link pasted'))}
  catch{setNotice(t('Браузер не дал прочитать буфер обмена. Вставьте ссылку в поле вручную (долгое нажатие → «Вставить»).','The browser did not allow reading the clipboard. Paste the link into the field.'))}
 }
 async function select(provider:Provider){
  if(provider===gpu.provider)return;
  setToken('');
  await gpu.selectProvider(provider,value||drafts[gpu.provider]).catch(()=>{});
 }
 const displayError=english?({AUTH_REJECTED:'The GPU rejected the token. Paste a fresh protected link.',INVALID_URL:'Use a public HTTPS server URL on port 443 without a path or query.',INVALID_TOKEN:'Paste the complete protected link or its 64-character token.',ENGINE_UPGRADE_REQUIRED:'This server requires YOISAKI ENGINE 1.7.0, 1.7.6, 1.8.0 or 1.8.1 (API 1.7.0) with ControlNet, SDPose and Img2Img.',GPU_NOT_READY:'The engine responded, but the GPU is not ready.',DNS_ERROR:'Server name could not be resolved. Check the URL.',DNS_TIMEOUT:'DNS lookup timed out. Check your network.',PRIVATE_DESTINATION:'The server resolves to a private or reserved address. Use a public HTTPS endpoint.',TLS_ERROR:'The HTTPS certificate or secure connection is invalid.',TUNNEL_UNAVAILABLE:'The server or tunnel is unavailable.',TUNNEL_OFFLINE:'Cloudflare answers, but no GPU server is attached to the tunnel.',REDIRECT_REJECTED:'Redirects are blocked. Paste the direct HTTPS endpoint.',INVALID_RESPONSE:'The server returned an invalid engine response.',UPSTREAM_INTERRUPTED:'The GPU connection was interrupted.',PROVIDER_CHANGED:'Select the provider before connecting.',CONNECTION_TIMEOUT:'The GPU request timed out. Check the server and tunnel.',NOT_REMEMBERED:'No remembered server for this provider.'} as Record<string,string>)[gpu.code||'']||`Connection failed (${gpu.code||'NETWORK_ERROR'}). Check the selected server, URL and token; retry the connection.`:(gpu.phase==='ERROR'&&gpu.phase_message)||gpu.error;
 const connectedAt=gpu.connected_at||0;
 const minutes=connectedAt?Math.max(0,Math.floor((now-connectedAt)/60000)):0;
 const uptime=connectedAt?`${String(Math.floor(minutes/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`:'—';
 const idle=gpu.url&&connectedAt?Math.floor((now-Math.max(lastJob,connectedAt))/60000):0;
 const remaining=gpu.autoconnect?Math.max(0,Math.ceil((gpu.autoconnect.deadline-now)/60000)):0;
 useEffect(()=>{if(!gpu.autoconnect)return;const id=setInterval(()=>setNow(Date.now()),5000);return ()=>clearInterval(id)},[!!gpu.autoconnect]);// eslint-disable-line react-hooks/exhaustive-deps
 const host=(origin:string)=>{try{return new URL(origin).hostname}catch{return origin}};
 async function loadEvents(){try{setEvents(JSON.stringify(await localApi('/api/diagnostics'),null,1))}catch(e){setEvents((e as Error).message)}}
 const tone=gpuTone(gpu.state);const info=gpu.info;
 const vram=info?.vram_available_mb!=null&&info?.vram_total_mb!=null?`${((info.vram_total_mb-info.vram_available_mb)/1024).toFixed(1)} / ${(info.vram_total_mb/1024).toFixed(1)} GB`:noData;
 const providers:Provider[]=cc?['colab','cloudcompute']:['colab'];
 return <div className="page stack" data-localized="true">
  <PageHead icon={<Cpu size={24}/>} title={tk('gpu.title')} detail={tk('gpu.detail')}/>
  <div className="px-tabs" role="tablist" aria-label={t('Провайдер GPU','GPU provider')}>
   {providers.map(p=><button key={p} type="button" role="tab" aria-selected={gpu.provider===p} aria-pressed={gpu.provider===p} className={'pill'+(gpu.provider===p?' selected':'')} disabled={gpu.changing||waiting} onClick={()=>void select(p)}>{p==='colab'?'Google Colab':'CloudCompute'}</button>)}
  </div>
  {gpu.provider==='cloudcompute'&&<div className="notice dangernotice row" role="note"><Warning size={18}/><span className="grow">{tk('gpu.ccWarning')}</span></div>}
  <section className="panel stack">
   <div className="gpu-card-head"><span className="logo" aria-hidden>{gpu.provider==='colab'?'CO':'CC'}</span><div className="grow" style={{minWidth:0}}><h2 style={{margin:0}}>{providerLabel}</h2><p className="tiny muted">{gpu.provider==='colab'?t('Бесплатный GPU через Google Colab','Free GPU through Google Colab'):t('Облачный GPU через CloudCompute.ru','Cloud GPU through CloudCompute.ru')}{info?.gpu_name?` · ${info.gpu_name}`:''}</p></div></div>
   <div className="row" style={{justifyContent:'space-between'}}><span className="gpu-state" data-tone={tone} role="status"><span className="dot"/>{names[gpu.state]}</span>
    <div className="row">{gpu.url&&<ActionButton className="pill" aria-label={t('Обновить','Refresh')} disabled={gpu.changing} onAction={async()=>{await gpu.refresh(true);const st=useDirect.getState();if(st.state==='ERROR'||st.models_error)throw Error(st.error||st.models_error||'GPU')}} successText={tk('gpu.refreshed')}><RefreshCw size={15}/>{t('Обновить','Refresh')}</ActionButton>}
     <ActionButton className="pill danger" disabled={gpu.changing||(!gpu.url&&gpu.state!=='CONNECTING')} onAction={async()=>{setToken('');await gpu.disconnect();const st=useDirect.getState();if(st.url)throw Error(st.error||tk('gpu.error'));setValue(st.endpoints[gpu.provider])}} successText={tk('gpu.disconnected')}><Power size={15}/>{t('Отключиться','Disconnect')}</ActionButton></div></div>
   <div className="stat-list" role="list">
    <div role="listitem"><span className="k"><Cpu size={18}/>GPU</span><span className="v">{info?.gpu_name||noData}</span></div>
    <div role="listitem"><span className="k"><Database size={18}/>{tk('gpu.vramUsed')}</span><span className="v">{vram}</span></div>
    <div role="listitem"><span className="k"><Zap size={18}/>{t('Статус','Status')}</span><span className={'v '+(tone==='ok'?'ok':tone==='bad'?'bad':'')}>{phaseNames[phase]}</span></div>
    <div role="listitem"><span className="k"><Clock size={18}/>{tk('gpu.uptime')}</span><span className="v">{gpu.url?uptime:'—'}</span></div>
    <div role="listitem"><span className="k"><Server size={18}/>{t('Версия движка','Engine version')}</span><span className="v">{info?.engine_version||noData}{info?.api_version?` · API ${info.api_version}`:''}</span></div>
    <div role="listitem"><span className="k"><Boxes size={18}/>{t('Моделей','Models')}</span><span className="v">{info?gpu.models.length:noData}</span></div>
    <div role="listitem"><span className="k"><Monitor size={18}/>{t('Версия студии','Studio version')}</span><span className="v">{STUDIO_VERSION} · {gpu.compatibility||'NOT_CONNECTED'}</span></div>
   </div>
   {!info&&<p className="notice">{saved?t('Нажмите «Подключить одной кнопкой» или вставьте новую ссылку.','Press «One-click connect» or paste a new link.'):t('Подключите выбранный GPU-сервер защищённой ссылкой. Отметьте «Запомнить», чтобы в следующий раз подключаться одной кнопкой.','Connect the selected GPU server using its protected link. Tick «Remember» to connect with one click next time.')}</p>}
   <div className="stack" style={{gap:8}}>
    {gpu.provider==='colab'&&<a className="btn block" href="https://colab.research.google.com/" target="_blank" rel="noopener noreferrer"><ExternalLink size={18}/>{tk('gpu.openColab')}</a>}
    {gpu.provider==='colab'&&<p className="tiny muted">{tk('gpu.colabNote')}</p>}
    <button type="button" className="block" onClick={()=>{setLogs(true);void loadEvents()}}><Terminal size={18}/>{tk('gpu.showLogs')}</button>
   </div>
  </section>
  {saved&&<section className="panel stack" aria-label={t('Сохранённый сервер','Saved server')}>
   <SectionTitle icon={<Server size={20}/>}>{t('Сохранённый сервер','Saved server')}</SectionTitle>
   <b className="tiny" style={{overflowWrap:'anywhere'}}>{host(saved.origin)}</b>
   <p className="tiny muted">{gpu.provider==='colab'?t('Ссылка Colab действует до конца его сеанса. После нового запуска Colab вставьте новую ссылку.','A Colab link lasts until its session ends. After a new Colab start paste the new link.'):t('Запустите инстанс в панели CloudCompute и нажмите кнопку: сайт подождёт загрузку сервера (до 15 минут).','Start the instance in the CloudCompute panel and press the button: the site waits for the server (up to 15 minutes).')}</p>
   <button type="button" className="primary" disabled={gpu.changing||waiting||!!gpu.url} onClick={()=>{setNotice('');void gpu.connectSaved().catch(()=>{})}}><Zap size={18}/>{t('Подключить одной кнопкой','One-click connect')}</button>
   {gpu.provider==='cloudcompute'&&<label className="row tiny"><input type="checkbox" checked={saved.discover} disabled={waiting} onChange={e=>void gpu.updateSaved({discover:e.target.checked}).catch(x=>setNotice((x as Error).message))}/> {t(`Находить новый адрес Quick Tunnel автоматически (через ${gpu.rendezvous_host||'ntfy.sh'}; адрес подписан токеном, сам токен не передаётся). На сервере: ./setup-cloudcompute.sh → вариант 2.`,`Find the new Quick Tunnel address automatically (via ${gpu.rendezvous_host||'ntfy.sh'}; signed, the token is never sent). On the server: ./setup-cloudcompute.sh → option 2.`)}</label>}
   <button type="button" className="danger" disabled={waiting} onClick={()=>{if(confirm(t('Забыть сохранённый сервер на этом телефоне?','Forget the saved server on this phone?')))void gpu.updateSaved({forget:true}).then(()=>toast('ok',tk('gpu.forgotten'))).catch(x=>setNotice((x as Error).message))}}>{t('Забыть сервер','Forget server')}</button>
  </section>}
  {(waiting||phase==='ERROR'&&!!gpu.phase_message)&&<section className="panel stack" role="status" aria-label={t('Ход подключения','Connection progress')}>
   <SectionTitle icon={<Zap size={20}/>}>{phaseNames[phase]}</SectionTitle>
   <ol className="phase-steps">{STEPS.map(s=>{const i=STEPS.indexOf(s),cur=STEPS.indexOf(phase);return <li key={s} className={phase==='ERROR'?'':i<cur?'done':s===phase?'now':'todo'}>{phaseNames[s]}</li>})}</ol>
   {waiting&&<progress aria-label={phaseNames[phase]}/>}
   {gpu.phase_message&&<p className="tiny">{gpu.phase_message}</p>}
   {gpu.autoconnect&&<p className="tiny muted">{t(`Попытка ${gpu.autoconnect.attempt} · адрес ${host(gpu.autoconnect.origin)} · ожидание ещё до ${remaining} мин.`,`Attempt ${gpu.autoconnect.attempt} · ${host(gpu.autoconnect.origin)} · waiting up to ${remaining} more min.`)}</p>}
   {waiting&&<button type="button" onClick={()=>void gpu.disconnect()}>{t('Отменить подключение','Cancel')}</button>}
  </section>}
  <section className="panel stack">
   <SectionTitle icon={<LinkIcon size={20}/>}>{gpu.provider==='cloudcompute'?t('Подключение CloudCompute по ссылке (дополнительно)','CloudCompute connection by link (advanced)'):<>{t('Подключение','Connect to')} {providerLabel}</>}</SectionTitle>
   {gpu.provider==='cloudcompute'&&<p className="tiny muted">{t('Для сервера, созданного шагами CLOUDCOMPUTE выше, адрес и токен подставляются автоматически. Ручная ссылка нужна только для серверов, запущенных иначе.','For a server created with the CLOUDCOMPUTE steps above the address and token are filled in automatically. A manual link is only needed for servers started otherwise.')}</p>}
   <label className="field">{label}<input type="url" inputMode="url" autoComplete="off" spellCheck={false} value={value} disabled={gpu.changing||gpu.state==='CONNECTING'} onChange={e=>change(e.target.value)} placeholder="https://example.trycloudflare.com" aria-label={label}/></label>
   <label className="field">{t('Токен доступа','Access token')}<input type="password" autoComplete="off" spellCheck={false} value={token} disabled={gpu.changing||gpu.state==='CONNECTING'} onChange={e=>setToken(e.target.value)} aria-label={t('Токен доступа','Access token')}/></label>
   <button type="button" disabled={gpu.changing||gpu.state==='CONNECTING'} onClick={()=>void paste()}><Copy size={16}/>{t('Вставить ссылку из буфера','Paste link from clipboard')}</button>
   <label className="row tiny"><input type="checkbox" checked={remember} onChange={e=>setRemember(e.target.checked)}/> {gpu.provider==='colab'?t('Запомнить на этом телефоне (до конца сеанса Colab)','Remember on this phone (until the Colab session ends)'):t('Запомнить на этом телефоне: дальше подключение одной кнопкой','Remember on this phone: one-click connect next time')}</label>
   <p className="tiny muted">{t('Вставьте защищённую ссылку целиком: #token будет перенесён в поле токена. Без «Запомнить» токен действует только до отключения. Сохранённый токен хранится только в приложении на телефоне (файл 0600), не в браузере.','Paste the complete protected link: #token moves into the token field. Without «Remember» the token lasts until disconnect. A remembered token is kept only by the app on this phone (file 0600), never in the browser.')}</p>
   <button type="button" className={'primary'+(gpu.state==='CONNECTING'?' is-loading':'')} disabled={gpu.changing||gpu.state==='CONNECTING'||!value||!token} onClick={()=>{const raw=value.replace(/\/$/,'')+'/#token='+token;setDrafts({...drafts,[gpu.provider]:value});setToken('');void gpu.connect(raw,{remember}).then(()=>{setValue('');if(useDirect.getState().url)toast('ok',tk('gpu.connectedToast'))}).catch(()=>{})}}><Power size={18}/>{t('Подключиться','Connect')}</button>
   {notice&&<div className="notice">{notice}</div>}
   {gpu.secrets_warning&&<div className="notice">{gpu.secrets_warning}</div>}
   {gpu.error&&<div className="notice dangernotice" role="alert">{displayError}</div>}
  </section>
  <section className="panel stack"><SectionTitle icon={<Terminal size={20}/>}>{t('Диагностика','Diagnostics')}</SectionTitle>
   <div className="stat-list" role="list" aria-label={t('Компоненты','Components')}>
    {Object.entries(gpu.components||{frontend:'READY'}).map(([k,v])=><div key={k} role="listitem"><span className="k">{componentNames[k]||k}</span><span className={'v '+(v==='ERROR'?'bad':v==='READY'?'ok':'')}>{stateNames[v]||v}</span></div>)}
   </div>
   {gpu.models_error&&<p className="notice">{t('Список моделей не обновился: ','The model list was not refreshed: ')}{gpu.models_error}</p>}
   {phase==='ERROR'&&gpu.code==='AUTH_REJECTED'&&saved&&<p className="tiny">{t('Сохранённый токен больше не подходит. На сервере: ./check-cloudcompute.sh link → вставьте ссылку выше с «Запомнить».','The saved token no longer works. On the server: ./check-cloudcompute.sh link → paste it above with «Remember».')}</p>}
  </section>
  {gpu.provider==='cloudcompute'&&<GpuReadiness compact/>}
  {gpu.provider==='cloudcompute'&&<CloudComputeAPI/>}
  {gpu.provider==='cloudcompute'&&<section className="panel stack"><SectionTitle icon={<Server size={20}/>}>{t('Инстанс и оплата CloudCompute','CloudCompute instance and billing')}</SectionTitle>
   <p className="tiny">{t('Список, статусы, создание, переименование и удаление доступны через API выше. Запуск и остановку существующего GPU-инстанса выполняйте в панели CloudCompute: в опубликованном API для GPU-инстансов этих команд нет.','Use the API section above to list, monitor, create, rename and delete instances. Start and stop existing GPU instances in the CloudCompute dashboard: the published API has no such commands for GPU instances.')}</p>
   <div className="row"><a className="btn" href="https://app.cloudcompute.ru/" target="_blank" rel="noopener noreferrer"><ExternalLink size={16}/>{t('Открыть панель CloudCompute','Open CloudCompute dashboard')}</a><a href="https://cloudcompute.ru/" target="_blank" rel="noopener noreferrer">{t('Открыть сайт CloudCompute','Open CloudCompute')}</a></div>
   <ul className="tiny" style={{margin:0,paddingLeft:18,display:'flex',flexDirection:'column',gap:6}}>
    <li><b>{t('«Отключиться» на сайте','«Disconnect» here')}</b>{t(': движок и инстанс продолжают работать, оплата GPU идёт.',': the engine and the instance keep running, the GPU is billed.')}</li>
    <li><b>{t('Остановить движок','Stop the engine')}</b> (./stop-cloudcompute.sh){t(': освобождает видеопамять, оплата GPU-инстанса продолжается.',': frees VRAM, the GPU instance is still billed.')}</li>
    <li><b>{t('Остановить инстанс в панели','Stop the instance in the panel')}</b>{t(': оплата GPU прекращается, но хранение диска оплачивается — проверьте текущие условия в панели. Модели на диске сохраняются, если диск постоянный.',': GPU billing stops, disk storage is still billed — check the rate in the panel. Models stay if the disk is persistent.')}</li>
    <li><b>{t('Удалить инстанс','Delete the instance')}</b>{t(': оплата прекращается полностью, диск с моделями удаляется. Модели останутся в вашем Google Drive.',': billing stops completely, the disk with models is deleted. Models remain in your Google Drive.')}</li>
   </ul>
   <label className="field">{t('Тариф GPU, ₽/час (для расчёта)','GPU rate, RUB/hour (for the estimate)')}<input inputMode="decimal" value={tariff||''} placeholder="24.94" onChange={e=>{const v=Number(e.target.value.replace(',','.'));const next=Number.isFinite(v)&&v>0?v:0;setTariff(next);try{localStorage.setItem(TARIFF_KEY,String(next))}catch{}}}/></label>
   {gpu.url?<p className="tiny">{t(`Подключено ${minutes} мин`,`Connected ${minutes} min`)}{tariff?t(` ≈ ${(minutes/60*tariff).toFixed(2)} ₽ — это минимум: оплата идёт с момента запуска инстанса, а не с подключения.`,` ≈ ${(minutes/60*tariff).toFixed(2)} RUB — a minimum: billing runs since the instance started.`):''}</p>:<p className="tiny muted">{t('Не подключено. Если инстанс запущен, он оплачивается, даже когда сайт отключён.','Not connected. A running instance is billed even when the site is disconnected.')}</p>}
   {gpu.url&&idle>=15&&<div className="notice" role="alert">{t(`GPU простаивает ${idle} мин${tariff?` (≈ ${(idle/60*tariff).toFixed(2)} ₽)`:''}. Если генерация больше не нужна, остановите или удалите инстанс в панели CloudCompute.`,`The GPU has been idle for ${idle} min. Stop or delete the instance in the CloudCompute panel if you are done.`)}</div>}
  </section>}
  {logs&&<Modal title={tk('gpu.logsTitle')} onClose={()=>setLogs(false)} wide><p className="tiny muted">{tk('gpu.logsNote')}</p><div className="row"><ActionButton onAction={loadEvents}><RefreshCw size={16}/>{t('Обновить','Refresh')}</ActionButton><button type="button" disabled={!events} onClick={()=>{navigator.clipboard?.writeText(events).then(()=>toast('ok',tk('toast.copied')),()=>toast('bad',tk('toast.copyFailed')))}}><Copy size={16}/>{tk('common.copy')}</button></div><pre className="tiny card" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:'55dvh',overflow:'auto',margin:0}}>{events||tk('common.loading')}</pre></Modal>}
 </div>;
}
