'use client';
import {useEffect} from 'react';import {useDirect} from '@/lib/engine/direct';
export function useEngineStatus(){const state=useDirect(x=>x.state),info=useDirect(x=>x.info),refresh=useDirect(x=>x.refresh);useEffect(()=>{const saved=sessionStorage.getItem('yoisaki-direct');if(saved){try{const data=JSON.parse(saved);useDirect.getState().connect(data.url+'/#token='+data.token).catch(()=>{})}catch{}}const timer=setInterval(()=>refresh(),12000);return()=>clearInterval(timer)},[refresh]);return state==='OFFLINE'||state==='ERROR'?null:{state,telemetry:info||{}}}
