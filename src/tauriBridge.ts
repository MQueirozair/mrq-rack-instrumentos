// Ponte "window.api" para a casca Tauri — equivalente ao electron/preload.ts,
// mas sem precisar de um processo de preload separado: aqui a gente monta o
// MESMO objeto `window.api` (shape idêntico ao MrqApi do Electron) usando as
// APIs JS do Tauri (invoke de comandos Rust + plugins oficiais). Isso permite
// que TODO o resto do app React (SetlistPanel, AudioEngine, etc.) continue
// chamando `window.api.xxx` sem nenhuma alteração, rodando tanto sob Electron
// quanto sob Tauri a partir do MESMO bundle compilado.
//
// Só é ativado quando o app está rodando dentro de um webview do Tauri
// (ver detecção em main.tsx). Em build Electron, o preload.js já cuidou de
// `window.api` antes deste módulo sequer existir no bundle de produção.

import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { listen } from '@tauri-apps/api/event';
import { open as openDialog, save as saveDialog, ask } from '@tauri-apps/plugin-dialog';
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener';
import { load as loadStore, type Store } from '@tauri-apps/plugin-store';
import { check as checkForUpdate, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import type { AppSettings, Library, RemoteStateSnapshot, RemoteCommand, OscArgValue, OscMessage, SyncBroadcastState } from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/types';
import type { MrqApi, UpdateStatusPayload } from '../electron/preload';

// ---------- Fechar com confirmação se a música ainda estiver tocando ----------
// Equivalente ao listener `mainWindow.on('close', ...)` do electron/main.ts:
// lá o processo principal decidia; aqui é o próprio front-end (via
// onCloseRequested, que intercepta tanto o botão customizado da titlebar
// quanto Alt+F4/fechar pela barra de tarefas) que pergunta antes de fechar.
let playbackActive = false;
let forceClose = false;

getCurrentWindow()
  .onCloseRequested(async (event) => {
    if (!forceClose && playbackActive) {
      event.preventDefault();
      const confirmed = await ask(
        'A música ainda está tocando. Tem certeza que quer fechar o MRQ - Multitracks Play?',
        {
          title: 'Música tocando',
          kind: 'warning',
          okLabel: 'Fechar mesmo assim',
          cancelLabel: 'Cancelar',
        }
      );
      if (!confirmed) return;
      forceClose = true;
    }
    // Atualização automática "sem clique": se uma versão nova já terminou de
    // baixar em segundo plano (ver updateReadyToInstall mais abaixo) e o
    // usuário nunca foi lá apertar "Instalar e reiniciar", aproveita o
    // fechamento do app — que ele já ia fazer de qualquer jeito — pra
    // instalar sozinho. Na próxima vez que abrir o MRQ já está na versão
    // nova, sem precisar baixar/instalar nada na mão.
    if (updateReadyToInstall && pendingUpdate && !installingOnQuit) {
      installingOnQuit = true;
      event.preventDefault();
      try {
        await pendingUpdate.install();
      } catch {
        /* se a instalação silenciosa falhar, não trava o fechamento */
      }
      forceClose = true;
      await getCurrentWindow().close();
    }
  })
  .catch(() => {
    /* noop */
  });

// ---------- Store (biblioteca / configurações) ----------
// Um único arquivo JSON persistente, mesma ideia do electron-store (porém em
// outro diretório — ver nota de migração abaixo).
let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  if (!storePromise) storePromise = loadStore('mrq-config.json', { autoSave: false });
  return storePromise;
}

// Mesmo merge raso com os valores padrão que existia em store:getSettings no
// main.ts do Electron: garante que campos novos adicionados em versões mais
// recentes (ex: "rack", ou campos novos dentro de cada RackLayer) nunca
// fiquem `undefined` em instalações com configurações salvas antigas.
function mergeSettingsWithDefaults(stored: Partial<AppSettings> | undefined): AppSettings {
  const storedRack = stored?.rack;
  const defaultLayers = DEFAULT_SETTINGS.rack.layers;
  const layers = (storedRack?.layers ?? defaultLayers).map((layer, i) => ({
    ...(defaultLayers[i] ?? defaultLayers[0]),
    ...layer,
  }));
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    rack: { ...DEFAULT_SETTINGS.rack, ...(storedRack ?? {}), layers },
  };
}

async function applyRemoteConfigFromSettings(settings: AppSettings) {
  try {
    await invoke('remote_configure', {
      enabled: settings.remote.enabled,
      port: settings.remote.port,
      pin: settings.remote.pin,
    });
  } catch (err) {
    console.error('[remote] falha ao configurar servidor remoto', err);
  }
}

async function applyOscConfigFromSettings(settings: AppSettings) {
  try {
    await invoke('osc_configure', {
      enabled: settings.osc.enabled,
      listenPort: settings.osc.listenPort,
      sendHost: settings.osc.sendHost,
      sendPort: settings.osc.sendPort,
    });
  } catch (err) {
    console.error('[osc] falha ao configurar ponte OSC', err);
  }
}

async function applySyncConfigFromSettings(settings: AppSettings) {
  try {
    await invoke('sync_configure', {
      enabled: settings.sync.enabled,
      role: settings.sync.role,
      port: settings.sync.port,
    });
  } catch (err) {
    console.error('[sync] falha ao configurar o MRQ Sync', err);
  }
}

// Validação mínima do formato antes de gravar no store: o app React não tem
// nenhum error boundary, então um Song com campos faltando (ex.: de uma
// versão bem antiga do config.json, ou um arquivo corrompido) derruba a
// árvore de componentes inteira na renderização — tela em branco pra sempre,
// já que os dados ruins ficariam permanentemente salvos no store do Tauri e
// seriam recarregados (e travariam de novo) em toda abertura seguinte do
// app. Então: só aceitamos a biblioteca legada se ela tiver, no mínimo, o
// formato básico esperado; caso contrário descartamos silenciosamente (o
// usuário começa com a biblioteca vazia, igual a uma instalação nova — bem
// melhor do que um app que não abre mais).
function isPlausibleLibrary(value: unknown): value is Library {
  if (!value || typeof value !== 'object') return false;
  const lib = value as Partial<Library>;
  if (!Array.isArray(lib.songs)) return false;
  return lib.songs.every(
    (s) =>
      s &&
      typeof s === 'object' &&
      typeof (s as { id?: unknown }).id === 'string' &&
      typeof (s as { title?: unknown }).title === 'string' &&
      Array.isArray((s as { tracks?: unknown }).tracks)
  );
}

function isPlausibleSettings(value: unknown): value is Partial<AppSettings> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Migração única de uma instalação ANTERIOR em Electron: o Tauri guarda
// configurações/biblioteca num diretório de dados diferente do que o
// electron-store usava, então sem isso quem já usa o MRQ perderia a
// biblioteca inteira (e as configs) ao trocar pra versão Tauri. Só roda
// quando o store do Tauri ainda está vazio (primeira execução de verdade),
// pra nunca sobrescrever dados mais novos já salvos pelo próprio Tauri.
async function migrateFromElectronIfNeeded(store: Store): Promise<void> {
  const alreadyHasSettings = (await store.has('settings')) || (await store.has('library'));
  if (alreadyHasSettings) return;
  try {
    const legacyRaw = await invoke<string | null>('find_legacy_electron_config');
    if (!legacyRaw) return;
    const legacy = JSON.parse(legacyRaw) as { settings?: unknown; library?: unknown };
    let migratedSomething = false;
    if (isPlausibleSettings(legacy.settings)) {
      await store.set('settings', legacy.settings);
      migratedSomething = true;
    } else if (legacy.settings) {
      console.warn('[migração] configurações da instalação Electron anterior com formato inesperado, ignoradas.');
    }
    if (isPlausibleLibrary(legacy.library)) {
      await store.set('library', legacy.library);
      migratedSomething = true;
    } else if (legacy.library) {
      console.warn('[migração] biblioteca da instalação Electron anterior com formato inesperado, ignorada.');
    }
    if (migratedSomething) {
      await store.save();
      console.info('[migração] configurações/biblioteca importadas da instalação Electron anterior.');
    }
  } catch (err) {
    console.error('[migração] falha ao importar dados da instalação Electron anterior', err);
  }
}

// Ao abrir o app: migra dados de uma instalação Electron anterior (se for a
// primeira vez) e, se o controle remoto estiver habilitado nas configurações
// salvas, já sobe o servidor — mesmo comportamento do `createWindow()` do
// Electron (`if (store.get('settings').remote.enabled) remoteServer.start()`).
//
// IMPORTANTE: isso é exportado como uma Promise (`ready`) que main.tsx
// AGUARDA antes de renderizar qualquer componente React. Sem isso existe uma
// corrida real: componentes como o TitleBar chamam window.api.remote.getInfo()
// uma única vez, no mount — se isso rodasse antes da migração escrever as
// configurações no store, a tela mostraria a porta/PIN padrão em vez dos
// valores de verdade (ou os recém-migrados). No Electron essa corrida nunca
// existiu porque o electron-store já estava carregado, de forma síncrona, bem
// antes do processo de renderer sequer começar a rodar JS.
export const ready: Promise<void> = (async () => {
  try {
    const store = await getStore();
    await migrateFromElectronIfNeeded(store);
    const stored = (await store.get<AppSettings>('settings')) ?? undefined;
    const settings = mergeSettingsWithDefaults(stored);
    await applyRemoteConfigFromSettings(settings);
    await applyOscConfigFromSettings(settings);
    await applySyncConfigFromSettings(settings);
  } catch (err) {
    console.error('[remote] falha ao inicializar a partir das configurações salvas', err);
  }
})();

// ---------- Diálogos de arquivo ----------
const INSTRUMENT_FILTERS = [
  {
    name: 'Todos os instrumentos suportados',
    extensions: [
      'sf2', 'sf3', 'syx', 'wav', 'wave', 'aiff', 'aif', 'flac', 'ogg', 'mp3', 'npno', 'nsmp', 'nsmp3', 'nsmp4', 'nki', 'exs', 'sfz', 'mrqi', 'mrq',
    ],
  },
  { name: 'SoundFont (.sf2, .sf3)', extensions: ['sf2', 'sf3'] },
  { name: 'Banco DX7 (.syx)', extensions: ['syx'] },
  { name: 'Amostra de áudio (.wav, .aiff, .flac, .ogg, .mp3)', extensions: ['wav', 'wave', 'aiff', 'aif', 'flac', 'ogg', 'mp3'] },
  { name: 'Nord Piano Library (.npno)', extensions: ['npno'] },
  { name: 'Nord Sample Library (.nsmp, .nsmp3, .nsmp4)', extensions: ['nsmp', 'nsmp3', 'nsmp4'] },
  { name: 'Kontakt 1-4 (.nki, sem criptografia)', extensions: ['nki'] },
  { name: 'Logic EXS24 (.exs)', extensions: ['exs'] },
  { name: 'SFZ (.sfz) — inclui exportações do Kontakt 5-8', extensions: ['sfz'] },
  { name: 'MRQ Instrument — formato leve do Rack (.mrqi)', extensions: ['mrqi'] },
  { name: 'MRQ Instrument — convertido pelo MRQ Instrument Converter (.mrq)', extensions: ['mrq'] },
  { name: 'Todos os arquivos', extensions: ['*'] },
];

const MRQI_SAVE_FILTERS = [{ name: 'MRQ Instrument (.mrqi)', extensions: ['mrqi'] }];

// ---------- Auto-atualização (tauri-plugin-updater + GitHub Releases) ----------
// Equivalente ao setupAutoUpdater() do electron/main.ts: autoDownload=true
// (baixa assim que encontra uma versão nova) e checagem automática ao abrir
// + a cada 4 horas. A instalação final acontece de duas formas, pra não
// obrigar o usuário a sempre baixar/instalar tudo na mão:
// 1) Clicando em "Instalar e reiniciar" (pill na titlebar ou Ajustes →
//    Atualização) — aplica e relança o app na hora.
// 2) Automático "sem clique": se ele simplesmente fechar o app normalmente
//    com uma versão já baixada e pronta, o onCloseRequested abaixo aproveita
//    o fechamento (que já ia acontecer) pra instalar sozinho — na próxima
//    vez que abrir já está na versão nova (ver updateReadyToInstall).
const updateStatusListeners = new Set<(payload: UpdateStatusPayload) => void>();
let pendingUpdate: Update | null = null;
// true assim que o download termina (evento 'Finished') — usado tanto pelo
// indicador da titlebar quanto pelo auto-instalar-ao-fechar acima.
let updateReadyToInstall = false;
let installingOnQuit = false;

function emitUpdateStatus(payload: UpdateStatusPayload) {
  updateStatusListeners.forEach((cb) => cb(payload));
}

async function performUpdateCheck(): Promise<UpdateStatusPayload> {
  if (import.meta.env.DEV) return { status: 'dev' };
  emitUpdateStatus({ status: 'checking' });
  try {
    const update = await checkForUpdate();
    if (!update) {
      emitUpdateStatus({ status: 'not-available' });
      return { status: 'not-available' };
    }
    pendingUpdate = update;
    emitUpdateStatus({ status: 'available', version: update.version });

    let totalBytes = 0;
    let downloadedBytes = 0;
    await update.download((event) => {
      if (event.event === 'Started') {
        totalBytes = event.data.contentLength ?? 0;
      } else if (event.event === 'Progress') {
        downloadedBytes += event.data.chunkLength;
        const percent = totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : undefined;
        emitUpdateStatus({ status: 'downloading', percent });
      } else if (event.event === 'Finished') {
        updateReadyToInstall = true;
        emitUpdateStatus({ status: 'downloaded', version: update.version });
      }
    });
    return { status: 'ok' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitUpdateStatus({ status: 'error', message });
    return { status: 'error', message };
  }
}

async function installPendingUpdate(): Promise<boolean> {
  if (!pendingUpdate) return false;
  await pendingUpdate.install();
  // No Windows o próprio install() já encerra o app (o processo nem chega a
  // executar a linha abaixo). No macOS/Linux é preciso relançar manualmente.
  try {
    await relaunch();
  } catch {
    /* noop */
  }
  return true;
}

if (!import.meta.env.DEV) {
  void performUpdateCheck();
  setInterval(() => void performUpdateCheck(), 4 * 60 * 60 * 1000);
}

// ---------- Objeto window.api, shape idêntico ao MrqApi (electron/preload.ts) ----------
const api: MrqApi = {
  window: {
    minimize: () => {
      void getCurrentWindow().minimize();
    },
    maximize: () => {
      void getCurrentWindow().toggleMaximize();
    },
    close: () => {
      void getCurrentWindow().close();
    },
  },
  store: {
    getLibrary: async (): Promise<Library> => {
      const store = await getStore();
      const library = await store.get<Library>('library');
      return library ?? { songs: [], scenes: [] };
    },
    saveLibrary: async (library: Library): Promise<boolean> => {
      const store = await getStore();
      await store.set('library', library);
      await store.save();
      return true;
    },
    getSettings: async (): Promise<AppSettings> => {
      const store = await getStore();
      const stored = (await store.get<AppSettings>('settings')) ?? undefined;
      return mergeSettingsWithDefaults(stored);
    },
    saveSettings: async (settings: AppSettings): Promise<boolean> => {
      const store = await getStore();
      await store.set('settings', settings);
      await store.save();
      await applyRemoteConfigFromSettings(settings);
      await applyOscConfigFromSettings(settings);
      await applySyncConfigFromSettings(settings);
      return true;
    },
  },
  fs: {
    chooseSongFolder: async (): Promise<string | null> => {
      const result = await openDialog({ directory: true, title: 'Escolha a pasta da música (multitracks)' });
      if (!result) return null;
      return Array.isArray(result) ? result[0] ?? null : result;
    },
    scanFolderTracks: (folderPath: string) =>
      invoke<{ name: string; filePath: string }[]>('scan_folder_tracks', { folderPath }),
    // IMPORTANTE: NÃO montar a URL "mrqfile://..." manualmente aqui. O Chromium
    // (motor do WebView2, usado no Windows) só permite fetch() para um conjunto
    // fixo de esquemas (http, https, data, etc.) — qualquer protocolo custom
    // literal como "mrqfile://" é rejeitado na hora com "Failed to fetch", ANTES
    // de qualquer verificação de CORS (por isso o cabeçalho Access-Control-*
    // no handler Rust não resolvia nada). No Windows/Android o Tauri espera
    // que a URL do protocolo custom seja "http://<scheme>.localhost/<path>" —
    // é exatamente isso que convertFileSrc() monta automaticamente pra cada
    // plataforma (mrqfile://localhost/<path> no macOS/Linux, que o WebKit aceita
    // de boa via fetch()). Ver: https://v2.tauri.app/reference/javascript/api/namespacecore/#convertfilesrc
    toFileUrl: async (filePath: string): Promise<string> => convertFileSrc(filePath, 'mrqfile'),
    openExternal: (url: string) => openUrl(url),
    chooseInstrumentFile: async (): Promise<string | null> => {
      const result = await openDialog({
        multiple: false,
        title: 'Escolha o arquivo do instrumento',
        filters: INSTRUMENT_FILTERS,
      });
      if (!result) return null;
      return Array.isArray(result) ? result[0] ?? null : result;
    },
    /** Abre o diálogo "Salvar como" e grava `data` no caminho escolhido;
     *  devolve o caminho salvo, ou null se o usuário cancelar. Usado hoje
     *  pela exportação de camadas do Rack para `.mrqi` (ver mrqiExport.ts). */
    saveBinaryFile: async (opts: { defaultName: string; data: Uint8Array }): Promise<string | null> => {
      const path = await saveDialog({
        title: 'Salvar instrumento .mrqi',
        defaultPath: opts.defaultName,
        filters: MRQI_SAVE_FILTERS,
      });
      if (!path) return null;
      // Vai como argumento JSON normal (number[]), não como "raw payload"
      // binário do Tauri (invoke(cmd, uint8array)) — esse modo raw passa
      // metadados extras (como o caminho de destino) por cabeçalhos HTTP,
      // que não aceitam com segurança nomes de arquivo com acentuação (muito
      // comuns aqui, ex. "Partitura Não-Violão.mrqi"). Pra um arquivo de
      // instrumento de tamanho moderado, exportado manualmente de vez em
      // quando (não é um caminho "quente"), o overhead de serializar como
      // array JSON é aceitável; ver src-tauri/src/fsops.rs::save_binary_file.
      await invoke('save_binary_file', { path, data: Array.from(opts.data) });
      return path;
    },
    /** Lista os nomes (não os caminhos completos) de todas as entradas
     *  diretas de uma pasta — usado hoje só pelo NkiLayerVoice pra resolver,
     *  sem diferenciar maiúsculas/minúsculas, caminhos de amostra de um
     *  `.nki` contra os arquivos de verdade no disco (ver
     *  src-tauri/src/fsops.rs::list_dir_entry_names). Lança se a pasta não
     *  existir/não puder ser lida — quem chama já trata isso como "sem
     *  resultado", não precisa de um caso especial aqui.
     */
    listDirNames: (dirPath: string): Promise<string[]> => invoke<string[]>('list_dir_entry_names', { dir: dirPath }),
    /** Diálogo genérico "escolher pasta", com título customizável — usado
     *  hoje pra pedir a pasta RAIZ de uma biblioteca Kontakt (Samples/
     *  .nkc/.nkr/.nkx) quando um .nki tem amostras que não resolveram perto
     *  do arquivo (ver NkiLayerVoice.resolveFromLibraryRoot). */
    chooseFolder: async (title: string): Promise<string | null> => {
      const result = await openDialog({ directory: true, title });
      if (!result) return null;
      return Array.isArray(result) ? result[0] ?? null : result;
    },
    /** Varre `rootDir` recursivamente (com limite de segurança, ver
     *  src-tauri/src/fsops.rs::find_sample_files) procurando arquivos cujo
     *  nome bata com algum de `fileNames` — devolve um mapa nome-em-
     *  -minúsculas → caminho absoluto do primeiro arquivo achado com esse
     *  nome. */
    findSampleFiles: (rootDir: string, fileNames: string[]): Promise<Record<string, string>> =>
      invoke<Record<string, string>>('find_sample_files', { rootDir, fileNames }),
  },
  net: {
    localAddresses: () => invoke<string[]>('local_addresses'),
  },
  log: {
    append: (line: string) => invoke<boolean>('log_append', { line }),
    getPath: () => invoke<string>('log_get_path'),
    reveal: async (): Promise<string> => {
      await invoke('log_read_tail', { maxChars: 1 }); // força o flush da fila antes de abrir a pasta
      const path = await invoke<string>('log_get_path');
      await revealItemInDir(path);
      return path;
    },
    readTail: (maxChars?: number) => invoke<string>('log_read_tail', { maxChars }),
    clear: () => invoke<boolean>('log_clear'),
  },
  app: {
    getVersion: () => getVersion(),
    reportPlaybackState: (isPlaying: boolean) => {
      playbackActive = isPlaying;
    },
  },
  update: {
    check: () => performUpdateCheck(),
    install: () => installPendingUpdate(),
    onStatus: (cb: (payload: UpdateStatusPayload) => void) => {
      updateStatusListeners.add(cb);
      return () => {
        updateStatusListeners.delete(cb);
      };
    },
  },
  remote: {
    getInfo: async () => {
      const store = await getStore();
      const stored = (await store.get<AppSettings>('settings')) ?? undefined;
      const settings = mergeSettingsWithDefaults(stored);
      return { port: settings.remote.port, pin: settings.remote.pin, enabled: settings.remote.enabled };
    },
    sendState: (snapshot: RemoteStateSnapshot) => {
      void invoke('remote_broadcast_state', { snapshot });
    },
    onCommand: (cb: (cmd: RemoteCommand) => void) => {
      let unlisten: (() => void) | null = null;
      let cancelled = false;
      listen<RemoteCommand>('remote:command', (event) => cb(event.payload)).then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
      return () => {
        cancelled = true;
        unlisten?.();
      };
    },
  },
  osc: {
    send: (address: string, args: OscArgValue[]) => invoke<void>('osc_send', { address, args }).then(() => true).catch(() => false),
    isEnabled: () => invoke<boolean>('osc_is_enabled'),
    onMessage: (cb: (msg: OscMessage) => void) => {
      let unlisten: (() => void) | null = null;
      let cancelled = false;
      listen<OscMessage>('osc:message', (event) => cb(event.payload)).then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
      return () => {
        cancelled = true;
        unlisten?.();
      };
    },
  },
  sync: {
    broadcastState: (state: SyncBroadcastState) => {
      void invoke('sync_broadcast_state', { state: { is_playing: state.isPlaying, bpm: state.bpm, key: state.key, song_title: state.songTitle } });
    },
    onState: (cb: (state: SyncBroadcastState) => void) => {
      let unlisten: (() => void) | null = null;
      let cancelled = false;
      listen<{ is_playing: boolean; bpm: number; key: string; song_title: string }>('sync:state', (event) => {
        const p = event.payload;
        cb({ isPlaying: p.is_playing, bpm: p.bpm, key: p.key, songTitle: p.song_title });
      }).then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
      return () => {
        cancelled = true;
        unlisten?.();
      };
    },
  },
  speech: {
    modelReady: () => invoke<boolean>('speech_model_ready'),
    downloadModel: () => invoke<void>('speech_download_model'),
    deleteModel: () => invoke<void>('speech_delete_model'),
    onDownloadProgress: (cb: (p: { received: number; total: number }) => void) => {
      let unlisten: (() => void) | null = null;
      let cancelled = false;
      listen<{ received: number; total: number }>('speech:download-progress', (event) => cb(event.payload)).then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
      return () => {
        cancelled = true;
        unlisten?.();
      };
    },
    transcribeWav: (wavBytes: Uint8Array, language?: string) =>
      invoke<{ start_ms: number; end_ms: number; text: string }[]>('speech_transcribe_wav', {
        wavBytes: Array.from(wavBytes),
        language,
      }).then((segments) => segments.map((s) => ({ startMs: s.start_ms, endMs: s.end_ms, text: s.text }))),
  },
};

window.api = api;
