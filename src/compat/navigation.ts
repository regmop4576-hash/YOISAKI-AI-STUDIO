import {useSyncExternalStore} from 'react';
export function navigate(path:string){history.pushState(null,'',path);window.dispatchEvent(new PopStateEvent('popstate'));window.scrollTo(0,0)}
export function usePathname(){return useSyncExternalStore(cb=>{window.addEventListener('popstate',cb);return()=>window.removeEventListener('popstate',cb)},()=>location.pathname)}
