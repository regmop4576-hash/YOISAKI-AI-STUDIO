'use client';
import {useEffect,useState} from 'react';
import {Head} from '@/components/Common';
import {useDirect,type Provider} from '@/lib/engine/direct';
import {useStudio} from '@/stores/studio';
import {STUDIO_VERSION} from '@/lib/release';

export default function Page(){
 const gpu=useDirect();const english=useStudio(x=>x.language)==='English';
 const t=(ru:string,en:string)=>english?en:ru;
 const [value,setValue]=useState(gpu.endpoints[gpu.provider]);const [token,setToken]=useState('');
 const [drafts,setDrafts]=useState(gpu.endpoints);
 useEffect(()=>{setValue(gpu.endpoints[gpu.provider]);setToken('');setDrafts(gpu.endpoints)},[gpu.provider]);
 const providerLabel=gpu.provider==='colab'?'Google Colab':'CloudCompute';
 const label=gpu.provider==='colab'?t('URL туннеля Colab','Colab tunnel URL'):t('URL сервера CloudCompute','CloudCompute server URL');
 const names:Record<string,string>={OFFLINE:t('ОТКЛЮЧЁН','OFFLINE'),CONNECTING:t('ПОДКЛЮЧЕНИЕ','CONNECTING'),READY:t('ПОДКЛЮЧЁН','CONNECTED'),BUSY:t('ЗАНЯТ','BUSY'),LOADING:t('ЗАГРУЗКА','LOADING'),ERROR:t('ОШИБКА','ERROR')};
 const noData=t('Нет данных','No data');
 const change=(raw:string)=>{
  const hash=raw.indexOf('#');
  // A pasted protected link is immediately split. The token stays in a password input only.
  if(hash>=0){setValue(raw.slice(0,hash));setToken(new URLSearchParams(raw.slice(hash+1)).get('token')||'')}
  else setValue(raw);
 };
 async function select(provider:Provider){
  if(provider===gpu.provider)return;
  setToken('');
  await gpu.selectProvider(provider,value||drafts[gpu.provider]).catch(()=>{});
 }
 const displayError=english?({AUTH_REJECTED:'The GPU rejected the token. Paste a fresh protected link.',INVALID_URL:'Use a public HTTPS server URL on port 443 without a path or query.',INVALID_TOKEN:'Paste the complete protected link or its 64-character token.',ENGINE_UPGRADE_REQUIRED:'This server requires YOISAKI ENGINE 1.7.0 with ControlNet, SDPose and Img2Img.',GPU_NOT_READY:'The engine responded, but the GPU is not ready.',DNS_ERROR:'Server name could not be resolved. Check the URL.',DNS_TIMEOUT:'DNS lookup timed out. Check your network.',PRIVATE_DESTINATION:'The server resolves to a private or reserved address. Use a public HTTPS endpoint.',TLS_ERROR:'The HTTPS certificate or secure connection is invalid.',TUNNEL_UNAVAILABLE:'The server or tunnel is unavailable.',REDIRECT_REJECTED:'Redirects are blocked. Paste the direct HTTPS endpoint.',INVALID_RESPONSE:'The server returned an invalid engine response.',UPSTREAM_INTERRUPTED:'The GPU connection was interrupted.',PROVIDER_CHANGED:'Select the provider before connecting.',CONNECTION_TIMEOUT:'The GPU request timed out. Check the server and tunnel.'} as Record<string,string>)[gpu.code||'']||`Connection failed (${gpu.code||'NETWORK_ERROR'}). Check the selected server, URL and token; retry the connection.`:gpu.error;
 return <div className="page stack" data-localized="true">
  <Head statusLabel={names[gpu.state]} title={t('GPU-движок','GPU engine')} detail={t('Выберите провайдера GPU','Choose a GPU provider')}/>
  <div className="panel stack">
   <div className="grid2" role="group" aria-label={t('Провайдер GPU','GPU provider')}>
    {(['colab','cloudcompute'] as Provider[]).map(p=><button key={p} type="button" aria-pressed={gpu.provider===p} className={gpu.provider===p?'primary':''} disabled={gpu.changing} onClick={()=>void select(p)}>{p==='colab'?'Google Colab':'CloudCompute'}</button>)}
   </div>
   <p className="tiny muted">{gpu.provider==='colab'?t('Бесплатный GPU через Google Colab','Free GPU through Google Colab'):t('Облачный GPU через CloudCompute.ru','Cloud GPU through CloudCompute.ru')}</p>
   <h2>{t('Подключение','Connect to')} {providerLabel}</h2>
   <label className="field">{label}<input type="url" autoComplete="off" spellCheck={false} value={value} disabled={gpu.changing||gpu.state==='CONNECTING'} onChange={e=>change(e.target.value)} placeholder="https://example.trycloudflare.com" aria-label={label}/></label>
   <label className="field">{t('Токен доступа','Access token')}<input type="password" autoComplete="off" spellCheck={false} value={token} disabled={gpu.changing||gpu.state==='CONNECTING'} onChange={e=>setToken(e.target.value)} aria-label={t('Токен доступа','Access token')}/></label>
   <p className="tiny muted">{t('Вставьте защищённую ссылку целиком: #token будет перенесён в поле токена. Адрес сохраняется, токен — только до отключения. После смены провайдера или перезапуска введите его заново.','Paste the complete protected link: #token moves into the token field. The address is saved; the token lasts only until disconnect. Enter it again after switching providers or restarting.')}</p>
   <div className="row"><button className="primary" disabled={gpu.changing||gpu.state==='CONNECTING'||!value||!token} onClick={()=>{const raw=value.replace(/\/$/,'')+'/#token='+token;setDrafts({...drafts,[gpu.provider]:value});setToken('');void gpu.connect(raw).then(()=>setValue('')).catch(()=>{})}}>{t('Подключиться','Connect')}</button>
    <button disabled={gpu.changing||(!gpu.url&&gpu.state!=='CONNECTING')} onClick={()=>{setToken('');void gpu.disconnect().then(()=>setValue(useDirect.getState().endpoints[gpu.provider]))}}>{t('Отключиться','Disconnect')}</button>
    <button disabled={gpu.changing||!gpu.url} onClick={()=>void gpu.refresh(true)}>{t('Обновить','Refresh')}</button></div>
   <span className="status" role="status">{names[gpu.state]}</span>
   {gpu.error&&<div className="notice dangernotice" role="alert">{displayError}</div>}
  </div>
  <div className="panel stack"><h2>{t('Состояние GPU','GPU status')}</h2>
   <p className="tiny muted">YOISAKI AI STUDIO v{STUDIO_VERSION} · {gpu.compatibility||'NOT_CONNECTED'}</p>
   <div className="grid2">
    <div>{t('Провайдер','Provider')}: {providerLabel}</div><div>{t('Статус','Status')}: {names[gpu.state]}</div>
    <div>GPU: {gpu.info?.gpu_name||noData}</div><div>VRAM: {gpu.info?.vram_available_mb!=null&&gpu.info?.vram_total_mb!=null?`${gpu.info.vram_available_mb} / ${gpu.info.vram_total_mb} MB`:noData}</div>
    <div>{t('Версия студии','Studio version')}: {STUDIO_VERSION}</div><div>{t('Версия движка','Engine version')}: {gpu.info?.engine_version||noData}</div><div>{t('Версия API','API version')}: {gpu.info?.api_version||noData}</div><div>{t('Моделей','Models')}: {gpu.info?gpu.models.length:noData}</div>
   </div>
   {!gpu.info&&<p className="notice">{t('Подключите выбранный GPU-сервер защищённой ссылкой. Автоматического подключения нет.','Connect the selected GPU server using its protected link. Connections are never started automatically.')}</p>}
  </div>
 </div>
}
