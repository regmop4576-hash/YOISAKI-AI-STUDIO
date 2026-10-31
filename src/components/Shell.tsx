'use client';
// v1.9.0 PIXEL FANTASY shell: night-city header, live GPU chip (real /api/gpu/status state), bottom navigation on
// phones, sidebar on wide screens, a drawer with every section and Settings. Decorations are CSS backgrounds only.
import {useEffect,useState,type ReactNode} from 'react';
import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {WandSparkles,Paintbrush,Boxes,Images,Cpu,Settings,Menu,X} from './icons';
import {STUDIO_VERSION,STUDIO_EDITION} from '@/lib/release';
import {useStudio} from '@/stores/studio';
import {useI18n,type MessageKey} from '@/i18n';
import {LocaleBridge} from './LocaleBridge';
import {Toasts,useGpuLabel,Mascot} from './ui';
const links:[string,MessageKey,typeof WandSparkles][]=[['/generate','nav.generate',WandSparkles],['/edit','nav.editor',Paintbrush],['/models','nav.models',Boxes],['/gallery','nav.gallery',Images],['/engine','nav.gpu',Cpu]];
/** Applies interface preferences to <html> (motion, decorations, font, text size, language). */
function useUiClasses(){const ui=useStudio(s=>s.ui);const {lang}=useI18n();useEffect(()=>{const c=document.documentElement.classList;c.toggle('motion-off',ui.motion==='off');c.toggle('decor-compact',ui.decor==='compact');c.toggle('text-pixel',ui.pixelText);c.toggle('text-large',ui.largeText);document.documentElement.lang=lang},[ui,lang])}
export function Shell({children}:{children:ReactNode}){
 const pathname=usePathname();const {t}=useI18n();const [drawer,setDrawer]=useState(false);const gpu=useGpuLabel();useUiClasses();
 useEffect(()=>{setDrawer(false)},[pathname]);
 const active=(href:string)=>pathname.startsWith(href);
 return <div className="layout"><LocaleBridge/>
  <header className="app-header" data-localized="true">
   <div className="sky-stars" aria-hidden/><div className="sky-moon" aria-hidden/><div className="sky-city" aria-hidden/><div className="sky-glow" aria-hidden/>
   <div className="hdr-bar"><button type="button" className="icon" aria-label={t('nav.menu')} aria-expanded={drawer} onClick={()=>setDrawer(true)}><Menu size={22}/></button>
    <Link href="/engine" className="gpu-chip" data-tone={gpu.tone} aria-label={t('nav.gpuStatus')+': '+gpu.label} title={gpu.label}><Cpu size={18}/><span className="dot" aria-hidden/><span className="gpu-chip-text">{gpu.label}</span></Link></div>
   <Link href="/generate" className="brand-title" aria-label="YOISAKI AI STUDIO" style={{pointerEvents:'auto',textDecoration:'none'}}><b>YOISAKI</b><span>AI STUDIO</span></Link>
  </header>
  <aside className="sidebar" data-localized="true"><nav aria-label={t('nav.main')}>{links.map(([href,key,Icon])=><Link key={href} href={href} className={active(href)?'active':''} aria-current={active(href)?'page':undefined}><Icon size={20}/>{t(key)}</Link>)}<Link href="/settings" className={active('/settings')?'active':''} aria-current={active('/settings')?'page':undefined}><Settings size={20}/>{t('nav.settings')}</Link></nav>
   <div className="mascot"><Mascot size={120} alt={t('brand.mascot')}/><span>{t('brand.version',{v:STUDIO_VERSION})}<br/>{STUDIO_EDITION}</span></div></aside>
  <main className="content">{children}</main>
  <nav className="bottomnav" aria-label={t('nav.mobile')} data-localized="true">{links.map(([href,key,Icon])=><Link key={href} href={href} className={active(href)?'active':''} aria-current={active(href)?'page':undefined}><Icon size={22}/><span>{t(key)}</span></Link>)}</nav>
  {drawer&&<div className="drawer-back" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)setDrawer(false)}} onKeyDown={e=>{if(e.key==='Escape')setDrawer(false)}}><div className="drawer" role="dialog" aria-modal="true" aria-label={t('nav.menu')} data-localized="true">
   <div className="row" style={{justifyContent:'space-between'}}><div className="drawer-brand"><Mascot size={64} variant="avatar" alt={t('brand.mascot')}/><b>YOISAKI<br/>AI STUDIO</b></div><button type="button" className="icon" aria-label={t('common.close')} onClick={()=>setDrawer(false)} autoFocus><X size={20}/></button></div>
   <nav aria-label={t('nav.main')}>{links.map(([href,key,Icon])=><Link key={href} href={href} className={active(href)?'active':''}><Icon size={20}/>{t(key)}</Link>)}<Link href="/settings" className={active('/settings')?'active':''}><Settings size={20}/>{t('nav.settings')}</Link></nav>
   <div className="card tiny stack" style={{gap:4}}><span className="gold">{t('brand.version',{v:STUDIO_VERSION})} · {STUDIO_EDITION}</span><span className="muted">{t('brand.storage')}</span></div>
  </div></div>}
  <Toasts/>
 </div>;
}
