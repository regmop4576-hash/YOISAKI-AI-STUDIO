import type {EngineAdapter} from './types';import {OfflineEngine} from './mock';
export const engineClient:EngineAdapter = new OfflineEngine();
