'use client';
import {useDirect} from '@/lib/engine/direct';
export function useEngineStatus(){const state=useDirect(x=>x.state),info=useDirect(x=>x.info);return state==='OFFLINE'||state==='ERROR'?null:{state,telemetry:info||{}}}
