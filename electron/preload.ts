import { contextBridge, ipcRenderer } from 'electron';
import type { AppSettings, Library, RemoteStateSnapshot, RemoteCommand, OscArgValue, OscMessage, SyncBroadcastState } from '../shared/types';

export interface UpdateStatusPayload {
  status: 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error' | 'dev' | 'ok';
  version?: string;
  percent?: number;
  message?: string;
}

export interface TranscriptSegmentPayload {
  startMs: number;
  endMs: number;
  text: string;
}

const api = {
  window: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close'),
  },
  store: {
    getLibrary: (): Promise<Library> => ipcRenderer.invoke('store:getLibrary'),
    saveLibrary: (library: Library): Promise<boolean> => ipcRenderer.invoke('store:saveLibrary', library),
    getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('store:getSettings'),
    saveSettings: (settings: AppSettings): Promise<boolean> => ipcRenderer.invoke('store:saveSettings', settings),
  },
  fs: {
    chooseSongFolder: (): Promise<string | null> => ipcRenderer.invoke('fs:chooseSongFolder'),
    scanFolderTracks: (folderPath: string): Promise<{ name: string; filePath: string }[]> =>
      ipcRenderer.invoke('fs:scanFolderTracks', folderPath),
    toFileUrl: (filePath: string): Promise<string> => ipcRenderer.invoke('fs:toFileUrl', filePath),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('fs:openExternal', url),
    chooseInstrumentFile: (): Promise<string | null> => ipcRenderer.invoke('fs:chooseInstrumentFile'),
    saveBinaryFile: (opts: { defaultName: string; data: Uint8Array }): Promise<string | null> =>
      ipcRenderer.invoke('fs:saveBinaryFile', opts.defaultName, Array.from(opts.data)),
    listDirNames: (dirPath: string): Promise<string[]> => ipcRenderer.invoke('fs:listDirNames', dirPath),
    /** Diálogo genérico "escolher pasta", com título customizável — usado
     *  hoje pra pedir a pasta RAIZ de uma biblioteca Kontakt (Samples/
     *  .nkc/.nkr/.nkx) quando um .nki tem amostras que não resolveram perto
     *  do arquivo (ver NkiLayerVoice.resolveFromLibraryRoot). */
    chooseFolder: (title: string): Promise<string | null> => ipcRenderer.invoke('fs:chooseFolder', title),
    /** Varre `rootDir` recursivamente (com limite de segurança) procurando
     *  arquivos cujo nome (sem diferenciar maiúsc./minúsc.) bata com algum
     *  de `fileNames` — devolve um mapa nome-em-minúsculas → caminho
     *  absoluto do primeiro arquivo achado com esse nome. Usado pra
     *  recuperar amostras de .nki que não estavam ao lado do arquivo nem
     *  numa pasta Samples/samples direta (bibliotecas com subpastas
     *  aninhadas, ex. por letra/instrumento). */
    findSampleFiles: (rootDir: string, fileNames: string[]): Promise<Record<string, string>> =>
      ipcRenderer.invoke('fs:findSampleFiles', rootDir, fileNames),
  },
  net: {
    localAddresses: (): Promise<string[]> => ipcRenderer.invoke('net:localAddresses'),
  },
  log: {
    append: (line: string): Promise<boolean> => ipcRenderer.invoke('log:append', line),
    getPath: (): Promise<string> => ipcRenderer.invoke('log:getPath'),
    reveal: (): Promise<string> => ipcRenderer.invoke('log:reveal'),
    readTail: (maxChars?: number): Promise<string> => ipcRenderer.invoke('log:readTail', maxChars),
    clear: (): Promise<boolean> => ipcRenderer.invoke('log:clear'),
  },
  app: {
    getVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),
    /** Avisa o processo principal se a música está tocando ou não, pra ele poder confirmar
     *  antes de fechar a janela no meio de uma reprodução ao vivo. */
    reportPlaybackState: (isPlaying: boolean) => ipcRenderer.send('app:playbackState', isPlaying),
  },
  update: {
    check: (): Promise<UpdateStatusPayload> => ipcRenderer.invoke('update:check'),
    install: (): Promise<boolean> => ipcRenderer.invoke('update:install'),
    onStatus: (cb: (payload: UpdateStatusPayload) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: UpdateStatusPayload) => cb(payload);
      ipcRenderer.on('update:status', listener);
      return () => {
        ipcRenderer.removeListener('update:status', listener);
      };
    },
  },
  remote: {
    getInfo: (): Promise<{ port: number; pin: string; enabled: boolean }> => ipcRenderer.invoke('remote:getInfo'),
    sendState: (snapshot: RemoteStateSnapshot) => ipcRenderer.send('remote:state', snapshot),
    onCommand: (cb: (cmd: RemoteCommand) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, cmd: RemoteCommand) => cb(cmd);
      ipcRenderer.on('remote:command', listener);
      return () => {
        ipcRenderer.removeListener('remote:command', listener);
      };
    },
  },
  // OSC e MRQ Sync (ver src-tauri/src/osc.rs e sync.rs): só implementados de
  // fato no lado Tauri (src/tauriBridge.ts) — mantidos aqui só pra MrqApi
  // continuar com o mesmo formato nos dois lados, já que esta casca Electron
  // é legada e não faz mais parte do build publicado (ver tauri.conf.json).
  osc: {
    send: (address: string, args: OscArgValue[]): Promise<boolean> => ipcRenderer.invoke('osc:send', address, args),
    isEnabled: (): Promise<boolean> => ipcRenderer.invoke('osc:isEnabled'),
    onMessage: (cb: (msg: OscMessage) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, msg: OscMessage) => cb(msg);
      ipcRenderer.on('osc:message', listener);
      return () => {
        ipcRenderer.removeListener('osc:message', listener);
      };
    },
  },
  sync: {
    broadcastState: (state: SyncBroadcastState) => ipcRenderer.send('sync:broadcastState', state),
    onState: (cb: (state: SyncBroadcastState) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, state: SyncBroadcastState) => cb(state);
      ipcRenderer.on('sync:state', listener);
      return () => {
        ipcRenderer.removeListener('sync:state', listener);
      };
    },
  },
  // Reconhecimento de partes por voz (whisper.cpp local, ver src-tauri/src/speech.rs):
  // só implementado de fato no lado Tauri — mantido aqui só pra MrqApi
  // continuar com o mesmo formato nos dois lados (casca Electron legada,
  // fora do build publicado). `setPartsFromRecognition` em useStore.ts já
  // cai de volta pro método por áudio (PartRecognition.ts) quando
  // `modelReady()` nunca fica true.
  speech: {
    modelReady: (): Promise<boolean> => Promise.resolve(false),
    downloadModel: (): Promise<void> => Promise.reject(new Error('reconhecimento por voz não disponível nesta casca')),
    deleteModel: (): Promise<void> => Promise.resolve(),
    onDownloadProgress: (_cb: (p: { received: number; total: number }) => void) => () => {},
    transcribeWav: (_wavBytes: Uint8Array, _language?: string): Promise<TranscriptSegmentPayload[]> =>
      Promise.reject(new Error('reconhecimento por voz não disponível nesta casca')),
  },
};

export type MrqApi = typeof api;

contextBridge.exposeInMainWorld('api', api);
