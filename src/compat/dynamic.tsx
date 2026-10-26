import {lazy,Suspense,ComponentType} from 'react';
export default function dynamic(loader:()=>Promise<ComponentType>){const C=lazy(async()=>({default:await loader()}));return function Dynamic(){return <Suspense fallback={<p className="notice">Загрузка редактора…</p>}><C/></Suspense>}}
