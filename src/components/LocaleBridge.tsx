'use client';
import {useEffect} from 'react';
import {useStudio} from '@/stores/studio';
import {translate} from '@/lib/i18n';
const originals=new WeakMap<Node,string>();
const attrs=new WeakMap<Element,Map<string,string>>();
/** Keeps legacy components translated while retaining their stable event/state handlers. */
export function LocaleBridge(){const language=useStudio(s=>s.language);useEffect(()=>{document.documentElement.lang=language==='English'?'en':'ru';let queued=false;
function walk(){const root=document.body;const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let n:Node|null;while((n=walker.nextNode())){const parent=n.parentElement;if(!parent||parent.closest('script,style,textarea,option[data-untranslated]'))continue;let raw=originals.get(n)??n.textContent??'';if(originals.has(n)&&n.textContent!==raw&&n.textContent!==translate(raw,language))raw=n.textContent??'';originals.set(n,raw);const target=translate(raw,language);if(n.textContent!==target)n.textContent=target;}root.querySelectorAll('[placeholder],[aria-label],[title]').forEach(el=>{let map=attrs.get(el);if(!map){map=new Map();attrs.set(el,map)}for(const name of ['placeholder','aria-label','title']){const v=el.getAttribute(name);if(v===null)continue;if(!map.has(name))map.set(name,v);const target=translate(map.get(name)!,language);if(v!==target)el.setAttribute(name,target)}})}
function schedule(){if(queued)return;queued=true;queueMicrotask(()=>{queued=false;walk()})}walk();const observer=new MutationObserver(schedule);observer.observe(document.body,{childList:true,subtree:true,characterData:true});return()=>observer.disconnect()},[language]);return null}
