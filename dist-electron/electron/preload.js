"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const api = {
    window: {
        minimize: () => electron_1.ipcRenderer.send('win:minimize'),
        maximize: () => electron_1.ipcRenderer.send('win:maximize'),
        close: () => electron_1.ipcRenderer.send('win:close'),
    },
    store: {
        getLibrary: () => electron_1.ipcRenderer.invoke('store:getLibrary'),
        saveLibrary: (library) => electron_1.ipcRenderer.invoke('store:saveLibrary', library),
        getSettings: () => electron_1.ipcRenderer.invoke('store:getSettings'),
        saveSettings: (settings) => electron_1.ipcRenderer.invoke('store:saveSettings', settings),
    },
    fs: {
        chooseSongFolder: () => electron_1.ipcRenderer.invoke('fs:chooseSongFolder'),
        scanFolderTracks: (folderPath) => electron_1.ipcRenderer.invoke('fs:scanFolderTracks', folderPath),
        toFileUrl: (filePath) => electron_1.ipcRenderer.invoke('fs:toFileUrl', filePath),
        openExternal: (url) => electron_1.ipcRenderer.invoke('fs:openExternal', url),
        chooseInstrumentFile: () => electron_1.ipcRenderer.invoke('fs:chooseInstrumentFile'),
        saveBinaryFile: (opts) => electron_1.ipcRenderer.invoke('fs:saveBinaryFile', opts.defaultName, Array.from(opts.data)),
        listDirNames: (dirPath) => electron_1.ipcRenderer.invoke('fs:listDirNames', dirPath),
        /** Diálogo genérico "escolher pasta", com título customizável — usado
         *  hoje pra pedir a pasta RAIZ de uma biblioteca Kontakt (Samples/
         *  .nkc/.nkr/.nkx) quando um .nki tem amostras que não resolveram perto
         *  do arquivo (ver NkiLayerVoice.resolveFromLibraryRoot). */
        chooseFolder: (title) => electron_1.ipcRenderer.invoke('fs:chooseFolder', title),
        /** Varre `rootDir` recursivamente (com limite de segurança) procurando
         *  arquivos cujo nome (sem diferenciar maiúsc./minúsc.) bata com algum
         *  de `fileNames` — devolve um mapa nome-em-minúsculas → caminho
         *  absoluto do primeiro arquivo achado com esse nome. Usado pra
         *  recuperar amostras de .nki que não estavam ao lado do arquivo nem
         *  numa pasta Samples/samples direta (bibliotecas com subpastas
         *  aninhadas, ex. por letra/instrumento). */
        findSampleFiles: (rootDir, fileNames) => electron_1.ipcRenderer.invoke('fs:findSampleFiles', rootDir, fileNames),
    },
    net: {
        localAddresses: () => electron_1.ipcRenderer.invoke('net:localAddresses'),
    },
    log: {
        append: (line) => electron_1.ipcRenderer.invoke('log:append', line),
        getPath: () => electron_1.ipcRenderer.invoke('log:getPath'),
        reveal: () => electron_1.ipcRenderer.invoke('log:reveal'),
        readTail: (maxChars) => electron_1.ipcRenderer.invoke('log:readTail', maxChars),
        clear: () => electron_1.ipcRenderer.invoke('log:clear'),
    },
    app: {
        getVersion: () => electron_1.ipcRenderer.invoke('app:getVersion'),
        /** Avisa o processo principal se a música está tocando ou não, pra ele poder confirmar
         *  antes de fechar a janela no meio de uma reprodução ao vivo. */
        reportPlaybackState: (isPlaying) => electron_1.ipcRenderer.send('app:playbackState', isPlaying),
    },
    update: {
        check: () => electron_1.ipcRenderer.invoke('update:check'),
        install: () => electron_1.ipcRenderer.invoke('update:install'),
        onStatus: (cb) => {
            const listener = (_e, payload) => cb(payload);
            electron_1.ipcRenderer.on('update:status', listener);
            return () => {
                electron_1.ipcRenderer.removeListener('update:status', listener);
            };
        },
    },
    remote: {
        getInfo: () => electron_1.ipcRenderer.invoke('remote:getInfo'),
        sendState: (snapshot) => electron_1.ipcRenderer.send('remote:state', snapshot),
        onCommand: (cb) => {
            const listener = (_e, cmd) => cb(cmd);
            electron_1.ipcRenderer.on('remote:command', listener);
            return () => {
                electron_1.ipcRenderer.removeListener('remote:command', listener);
            };
        },
    },
    // OSC e MRQ Sync (ver src-tauri/src/osc.rs e sync.rs): só implementados de
    // fato no lado Tauri (src/tauriBridge.ts) — mantidos aqui só pra MrqApi
    // continuar com o mesmo formato nos dois lados, já que esta casca Electron
    // é legada e não faz mais parte do build publicado (ver tauri.conf.json).
    osc: {
        send: (address, args) => electron_1.ipcRenderer.invoke('osc:send', address, args),
        isEnabled: () => electron_1.ipcRenderer.invoke('osc:isEnabled'),
        onMessage: (cb) => {
            const listener = (_e, msg) => cb(msg);
            electron_1.ipcRenderer.on('osc:message', listener);
            return () => {
                electron_1.ipcRenderer.removeListener('osc:message', listener);
            };
        },
    },
    sync: {
        broadcastState: (state) => electron_1.ipcRenderer.send('sync:broadcastState', state),
        onState: (cb) => {
            const listener = (_e, state) => cb(state);
            electron_1.ipcRenderer.on('sync:state', listener);
            return () => {
                electron_1.ipcRenderer.removeListener('sync:state', listener);
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
        modelReady: () => Promise.resolve(false),
        downloadModel: () => Promise.reject(new Error('reconhecimento por voz não disponível nesta casca')),
        deleteModel: () => Promise.resolve(),
        onDownloadProgress: (_cb) => () => { },
        transcribeWav: (_wavBytes, _language) => Promise.reject(new Error('reconhecimento por voz não disponível nesta casca')),
    },
};
electron_1.contextBridge.exposeInMainWorld('api', api);
//# sourceMappingURL=preload.js.map