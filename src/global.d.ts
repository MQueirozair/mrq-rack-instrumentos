import type { MrqApi } from '../electron/preload';

declare global {
  interface Window {
    api: MrqApi;
  }
  interface AudioContext {
    setSinkId?: (sinkId: string) => Promise<void>;
  }
}

export {};
