"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const node_path_1 = __importDefault(require("node:path"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const electron_store_1 = __importDefault(require("electron-store"));
const electron_updater_1 = require("electron-updater");
const types_1 = require("../shared/types");
const remoteServer_1 = require("./remoteServer");
const isDev = !electron_1.app.isPackaged;
const UPDATE_REPO_OWNER = 'MQueirozair';
const UPDATE_REPO_NAME = 'mrq-multitracks-play';
// Protocolo customizado para servir arquivos de áudio locais sem copiar nada
// e sem os bloqueios de CORS/segurança do file:// puro.
electron_1.protocol.registerSchemesAsPrivileged([
    {
        scheme: 'mrqfile',
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            bypassCSP: true,
            stream: true,
            corsEnabled: true,
        },
    },
]);
// Lista ampla de extensões de áudio reconhecidas ao escanear uma pasta de
// multitracks. É intencionalmente generosa: preferimos mostrar a faixa na
// mixer e, se o navegador não conseguir decodificar aquele formato
// específico, dar um erro claro e específico (ver AudioEngine.loadSong) do
// que simplesmente "esconder" o arquivo da lista sem nenhuma explicação.
const AUDIO_EXTENSIONS = new Set([
    '.wav',
    '.wave',
    '.mp3',
    '.flac',
    '.aiff',
    '.aif',
    '.aifc',
    '.ogg',
    '.oga',
    '.opus',
    '.m4a',
    '.mp4',
    '.m4b',
    '.aac',
    '.wma',
    '.webm',
    '.caf',
    '.3gp',
]);
const store = new electron_store_1.default({
    defaults: {
        library: { songs: [], scenes: [] },
        settings: types_1.DEFAULT_SETTINGS,
    },
});
let mainWindow = null;
/** espelho, no processo principal, do engineState.isPlaying do renderer — usado só pra decidir se confirma antes de fechar a janela. */
let playbackActive = false;
/** true depois que o usuário confirma "fechar mesmo assim", pra não reabrir o diálogo de novo no fechamento disparado por close() aqui mesmo. */
let forceClose = false;
let remoteServer = null;
// ---------- Log de diagnóstico persistente ----------
// Fica em disco (fora da pasta de instalação) para sobreviver a updates e
// poder ser enviado pelo usuário quando algo falha, sem precisar de DevTools.
const logDir = node_path_1.default.join(electron_1.app.getPath('userData'), 'logs');
const logFilePath = node_path_1.default.join(logDir, 'mrq-debug.log');
function ensureLogDir() {
    try {
        node_fs_1.default.mkdirSync(logDir, { recursive: true });
    }
    catch { /* noop */ }
}
// Fila de log 100% assíncrona: carregar uma música com várias faixas pode
// gerar dezenas de linhas de diagnóstico em sequência (uma por faixa). Antes,
// cada linha fazia uma gravação de disco SÍNCRONA (fs.appendFileSync +
// fs.statSync) no processo principal do Electron — isso bloqueava o loop de
// eventos principal a cada faixa carregada, deixando o app visivelmente
// travado/lento justamente na hora de abrir uma música para tocar ao vivo.
// Agora as linhas só se acumulam em memória e são gravadas em lote, em
// segundo plano, sem nunca travar a thread principal.
let logQueue = [];
let logFlushTimer = null;
let logWritesSinceSizeCheck = 0;
function scheduleLogFlush() {
    if (logFlushTimer)
        return;
    logFlushTimer = setTimeout(() => {
        logFlushTimer = null;
        void flushLogQueue();
    }, 150);
}
async function flushLogQueue() {
    if (logQueue.length === 0)
        return;
    const batch = logQueue;
    logQueue = [];
    try {
        ensureLogDir();
        await node_fs_1.default.promises.appendFile(logFilePath, batch.join(''), 'utf8');
        // Checa o tamanho só a cada ~200 gravações (não em toda linha) — evita um
        // stat() de disco extra a cada faixa carregada, que também é bloqueante
        // em volume alto.
        logWritesSinceSizeCheck += 1;
        if (logWritesSinceSizeCheck >= 200) {
            logWritesSinceSizeCheck = 0;
            const stat = await node_fs_1.default.promises.stat(logFilePath);
            if (stat.size > 5 * 1024 * 1024) {
                const content = await node_fs_1.default.promises.readFile(logFilePath, 'utf8');
                await node_fs_1.default.promises.writeFile(logFilePath, `[...log truncado...]\n${content.slice(-2 * 1024 * 1024)}`, 'utf8');
            }
        }
    }
    catch (err) {
        console.error('[log] falha ao gravar log de diagnóstico', err);
    }
}
function appendLog(line) {
    const ts = new Date().toISOString();
    logQueue.push(`[${ts}] ${line}\n`);
    scheduleLogFlush();
}
function createWindow() {
    mainWindow = new electron_1.BrowserWindow({
        width: 1360,
        height: 860,
        minWidth: 1040,
        minHeight: 660,
        backgroundColor: '#0b0b0d',
        autoHideMenuBar: true,
        frame: false,
        titleBarStyle: 'hidden',
        webPreferences: {
            preload: node_path_1.default.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });
    // Concede permissão de MIDI/áudio automaticamente (app local, confiável).
    mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
        if (['midi', 'midiSysex', 'media', 'audioCapture'].includes(permission)) {
            callback(true);
            return;
        }
        callback(false);
    });
    if (isDev && process.env.VITE_DEV_SERVER_URL) {
        mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
        mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
    else {
        mainWindow.loadFile(node_path_1.default.join(__dirname, '../../dist/index.html'));
    }
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
    // Evita fechar o app sem querer no meio de uma música tocando ao vivo: o
    // renderer avisa (via IPC) sempre que play/pause/stop muda o estado, e se o
    // usuário tentar fechar a janela enquanto ainda está tocando, confirmamos
    // antes de deixar fechar de verdade.
    mainWindow.on('close', (e) => {
        if (forceClose || !playbackActive)
            return;
        e.preventDefault();
        electron_1.dialog
            .showMessageBox(mainWindow, {
            type: 'warning',
            buttons: ['Cancelar', 'Fechar mesmo assim'],
            defaultId: 0,
            cancelId: 0,
            title: 'Música tocando',
            message: 'A música ainda está tocando. Tem certeza que quer fechar o MRQ - Multitracks Play?',
        })
            .then((result) => {
            if (result.response === 1) {
                forceClose = true;
                mainWindow?.close();
            }
        })
            .catch(() => { });
    });
    remoteServer = new remoteServer_1.RemoteServer({
        getPort: () => store.get('settings').remote.port,
        getPin: () => store.get('settings').remote.pin,
        onCommand: (cmd) => {
            mainWindow?.webContents.send('remote:command', cmd);
        },
    });
    if (store.get('settings').remote.enabled) {
        remoteServer.start().catch((err) => console.error('[remote] falha ao iniciar', err));
    }
}
// ---------- Auto-atualização (electron-updater + GitHub Releases privado) ----------
function sendUpdateStatus(payload) {
    mainWindow?.webContents.send('update:status', payload);
}
let updaterConfigured = false;
function setupAutoUpdater() {
    if (isDev) {
        appendLog('[autoUpdater] ignorado em modo dev');
        return;
    }
    if (updaterConfigured)
        return;
    updaterConfigured = true;
    electron_updater_1.autoUpdater.logger = {
        info: (m) => appendLog(`[autoUpdater] ${m}`),
        warn: (m) => appendLog(`[autoUpdater][warn] ${m}`),
        error: (m) => appendLog(`[autoUpdater][erro] ${m}`),
        debug: () => { },
    };
    electron_updater_1.autoUpdater.autoDownload = true;
    electron_updater_1.autoUpdater.autoInstallOnAppQuit = true;
    try {
        electron_updater_1.autoUpdater.setFeedURL({
            provider: 'github',
            owner: UPDATE_REPO_OWNER,
            repo: UPDATE_REPO_NAME,
        });
    }
    catch (err) {
        appendLog(`[autoUpdater] falha ao configurar feed: ${err instanceof Error ? err.stack : err}`);
    }
    electron_updater_1.autoUpdater.on('checking-for-update', () => sendUpdateStatus({ status: 'checking' }));
    electron_updater_1.autoUpdater.on('update-available', (info) => sendUpdateStatus({ status: 'available', version: info.version }));
    electron_updater_1.autoUpdater.on('update-not-available', (info) => sendUpdateStatus({ status: 'not-available', version: info.version }));
    electron_updater_1.autoUpdater.on('download-progress', (p) => sendUpdateStatus({ status: 'downloading', percent: p.percent }));
    electron_updater_1.autoUpdater.on('update-downloaded', (info) => sendUpdateStatus({ status: 'downloaded', version: info.version }));
    electron_updater_1.autoUpdater.on('error', (err) => {
        appendLog(`[autoUpdater] erro: ${err instanceof Error ? err.stack : err}`);
        sendUpdateStatus({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    });
    // Checagem automática ao abrir o app, e depois a cada 4 horas.
    electron_updater_1.autoUpdater.checkForUpdates().catch((err) => appendLog(`[autoUpdater] falha ao checar: ${err}`));
    setInterval(() => {
        electron_updater_1.autoUpdater.checkForUpdates().catch((err) => appendLog(`[autoUpdater] falha ao checar: ${err}`));
    }, 4 * 60 * 60 * 1000);
}
electron_1.ipcMain.handle('update:check', () => {
    if (isDev)
        return { status: 'dev' };
    return electron_updater_1.autoUpdater.checkForUpdates().then(() => ({ status: 'ok' })).catch((err) => ({ status: 'error', message: String(err) }));
});
electron_1.ipcMain.handle('update:install', () => {
    electron_updater_1.autoUpdater.quitAndInstall();
    return true;
});
electron_1.ipcMain.handle('app:getVersion', () => electron_1.app.getVersion());
electron_1.ipcMain.on('app:playbackState', (_e, isPlaying) => {
    playbackActive = isPlaying;
});
process.on('uncaughtException', (err) => {
    appendLog(`UNCAUGHT EXCEPTION (main): ${err?.stack || err}`);
});
process.on('unhandledRejection', (reason) => {
    appendLog(`UNHANDLED REJECTION (main): ${reason instanceof Error ? reason.stack : String(reason)}`);
});
electron_1.app.whenReady().then(() => {
    appendLog(`=== MRQ iniciado === versão=${electron_1.app.getVersion()} plataforma=${process.platform} arch=${process.arch} electron=${process.versions.electron} chrome=${process.versions.chrome}`);
    // Protocolo "mrqfile" usando a API legada protocol.registerFileProtocol —
    // obrigatório porque protocol.handle()/net.fetch() só existem a partir do
    // Electron 25, e este app agora usa Electron 19 (requisito: suporte a
    // macOS Sierra 10.12, que o Electron 20+ já não roda mais). A função
    // registerFileProtocol recebe (request, callback) e o callback aceita
    // diretamente um caminho de arquivo local (não uma URL file://).
    electron_1.protocol.registerFileProtocol('mrqfile', (request, callback) => {
        try {
            // Formato da URL: mrqfile://local-file/<caminho inteiro em encodeURIComponent>
            // Usamos um host FIXO ("local-file") e codificamos o caminho inteiro como um
            // único bloco opaco (sem barras/dois-pontos "soltos"). Isso é necessário
            // porque esquemas "standard" no Chromium tratam tudo logo após "//" como
            // autoridade (host:porta) até a próxima "/" — e em caminhos do Windows como
            // "I:/Música/arquivo.wav", o ":" era interpretado como separador de porta,
            // fazendo o Chromium APAGAR a letra da unidade (virava "i/Música/arquivo.wav",
            // sem a unidade "I:"). Codificando tudo com encodeURIComponent isso nunca
            // mais acontece, pois não sobra nenhum "/" ou ":" cru na URL.
            const url = new URL(request.url);
            const encoded = url.pathname.replace(/^\/+/, '');
            const filePath = decodeURIComponent(encoded);
            appendLog(`[mrqfile] request.url="${request.url}" filePath="${filePath}"`);
            callback({ path: filePath });
        }
        catch (err) {
            appendLog(`[mrqfile] ERRO ao resolver "${request.url}": ${err instanceof Error ? err.stack : err}`);
            callback({ error: -6 }); // net::ERR_FILE_NOT_FOUND
        }
    });
    createWindow();
    setupAutoUpdater();
    electron_1.app.on('activate', () => {
        if (electron_1.BrowserWindow.getAllWindows().length === 0)
            createWindow();
    });
});
electron_1.app.on('window-all-closed', () => {
    remoteServer?.stop();
    if (process.platform !== 'darwin')
        electron_1.app.quit();
});
// garante que nenhuma linha de log pendente (gravação em lote assíncrona)
// se perca quando o app fecha
electron_1.app.on('before-quit', () => {
    if (logFlushTimer)
        clearTimeout(logFlushTimer);
    logFlushTimer = null;
    if (logQueue.length > 0) {
        try {
            ensureLogDir();
            node_fs_1.default.appendFileSync(logFilePath, logQueue.join(''), 'utf8');
            logQueue = [];
        }
        catch { /* noop */ }
    }
});
// ---------- IPC: janela ----------
electron_1.ipcMain.on('win:minimize', () => mainWindow?.minimize());
electron_1.ipcMain.on('win:maximize', () => {
    if (!mainWindow)
        return;
    if (mainWindow.isMaximized())
        mainWindow.unmaximize();
    else
        mainWindow.maximize();
});
electron_1.ipcMain.on('win:close', () => mainWindow?.close());
// ---------- IPC: biblioteca / configurações ----------
electron_1.ipcMain.handle('store:getLibrary', () => store.get('library'));
electron_1.ipcMain.handle('store:saveLibrary', (_e, library) => {
    store.set('library', library);
    return true;
});
electron_1.ipcMain.handle('store:getSettings', () => {
    // Faz merge raso com os valores padrão: o `defaults` do electron-store só entra em
    // ação quando a chave inteira "settings" não existe (1º uso). Em instalações que já
    // tinham configurações salvas de versões antigas, campos novos adicionados depois
    // (ex: "rack", e os campos novos de cada RackLayer no painel "Editar") ficariam
    // `undefined` e quebrariam a tela que os usa — por isso o merge é feito também
    // dentro de cada item de `rack.layers`, não só no nível de `rack`.
    const stored = store.get('settings');
    const storedRack = stored?.rack;
    const defaultLayers = types_1.DEFAULT_SETTINGS.rack.layers;
    const layers = (storedRack?.layers ?? defaultLayers).map((layer, i) => ({
        ...(defaultLayers[i] ?? defaultLayers[0]),
        ...layer,
    }));
    return {
        ...types_1.DEFAULT_SETTINGS,
        ...stored,
        rack: { ...types_1.DEFAULT_SETTINGS.rack, ...(storedRack ?? {}), layers },
    };
});
electron_1.ipcMain.handle('store:saveSettings', (_e, settings) => {
    store.set('settings', settings);
    if (remoteServer) {
        if (settings.remote.enabled)
            remoteServer.start().catch(() => { });
        else
            remoteServer.stop();
    }
    return true;
});
// ---------- IPC: arquivos ----------
electron_1.ipcMain.handle('fs:chooseSongFolder', async () => {
    // Atalho apenas para testes automatizados (E2E) em ambientes sem interação
    // gráfica real, ex: sandbox CI. Nunca ativado em uso normal do app.
    if (process.env.MRQ_TEST_FOLDER)
        return process.env.MRQ_TEST_FOLDER;
    const result = await electron_1.dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: 'Escolha a pasta da música (multitracks)',
    });
    if (result.canceled || result.filePaths.length === 0)
        return null;
    return result.filePaths[0];
});
async function scanDirAudioFiles(dir) {
    const entries = await node_fs_1.default.promises.readdir(dir, { withFileTypes: true });
    return entries
        .filter((e) => e.isFile() && AUDIO_EXTENSIONS.has(node_path_1.default.extname(e.name).toLowerCase()))
        .map((e) => ({
        name: node_path_1.default.basename(e.name, node_path_1.default.extname(e.name)),
        filePath: node_path_1.default.join(dir, e.name),
    }));
}
async function listSubdirs(dir) {
    const entries = await node_fs_1.default.promises.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => node_path_1.default.join(dir, e.name));
}
function sortTracks(tracks) {
    return [...tracks].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}
electron_1.ipcMain.handle('fs:scanFolderTracks', async (_e, folderPath) => {
    const direct = await scanDirAudioFiles(folderPath);
    if (direct.length > 0)
        return sortTracks(direct);
    // Pasta escolhida sem áudio direto nela — comum quando o pacote de
    // multitracks vem com os arquivos dentro de uma subpasta ("WAV", "Tracks",
    // "Audio" etc). Procura até 2 níveis abaixo, mas só quando a pasta tem
    // poucas subpastas (pasta de UMA música, não uma biblioteca inteira).
    const subdirs = await listSubdirs(folderPath);
    if (subdirs.length === 0 || subdirs.length > 8)
        return [];
    const found = [];
    for (const sub of subdirs) {
        const here = await scanDirAudioFiles(sub);
        if (here.length === 0) {
            const innerDirs = await listSubdirs(sub).catch(() => []);
            for (const inner of innerDirs) {
                found.push(...(await scanDirAudioFiles(inner)));
            }
        }
        else {
            found.push(...here);
        }
    }
    return sortTracks(found);
});
electron_1.ipcMain.handle('fs:toFileUrl', (_e, filePath) => {
    return 'mrqfile://local-file/' + encodeURIComponent(filePath);
});
// Seletor de arquivo de instrumento para o Rack ao vivo (6 camadas). Aceita
// SoundFont (.sf2/.sf3), banco/voz DX7 (.syx), amostra de áudio do usuário
// (.wav/.aiff/.flac/.ogg), biblioteca de piano Nord (.npno), patch legado do
// Kontakt 1-4 (.nki), instrumento Logic EXS24 (.exs) e instrumento SFZ
// (.sfz) num único diálogo — o formato real é detectado pela extensão
// escolhida, não pelo filtro usado. Todos esses formatos são decodificados
// de verdade (ver Sf2LayerVoice/Dx7LayerVoice/NpnoLayerVoice/NkiLayerVoice/
// ExsLayerVoice/SfzLayerVoice); o .nki especificamente só funciona com
// patches do Kontakt 1 a 4 sem criptografia (anteriores à versão 4.2.2) que
// referenciam amostras externas — ver o comentário em NkiLayerVoice.ts para
// o porquê. O .exs NUNCA foi criptografado pela Apple, então qualquer
// instrumento EXS24 que referencie arquivos de amostra externos é suportado
// (ver ExsFile.ts/ExsLayerVoice.ts). O .sfz continua sendo a ponte
// recomendada pra usar instrumentos do Kontakt 5/6/7/8: exporte-os como
// .sfz de dentro do próprio Kontakt licenciado (Creator Tools/KSP) e
// carregue o resultado aqui — ver HelpPanel.tsx para o passo a passo.
electron_1.ipcMain.handle('fs:chooseInstrumentFile', async () => {
    // Atalho apenas para testes automatizados (E2E) em ambientes sem interação gráfica
    // real, ex: sandbox CI — mesmo padrão do MRQ_TEST_FOLDER acima. Nunca ativado em uso normal.
    if (process.env.MRQ_TEST_INSTRUMENT_FILE)
        return process.env.MRQ_TEST_INSTRUMENT_FILE;
    const result = await electron_1.dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        title: 'Escolha o arquivo do instrumento',
        filters: [
            { name: 'Todos os instrumentos suportados', extensions: ['sf2', 'sf3', 'syx', 'wav', 'wave', 'aiff', 'aif', 'flac', 'ogg', 'mp3', 'npno', 'nsmp', 'nsmp3', 'nsmp4', 'nki', 'exs', 'sfz', 'mrqi'] },
            { name: 'SoundFont (.sf2, .sf3)', extensions: ['sf2', 'sf3'] },
            { name: 'Banco DX7 (.syx)', extensions: ['syx'] },
            { name: 'Amostra de áudio (.wav, .aiff, .flac, .ogg, .mp3)', extensions: ['wav', 'wave', 'aiff', 'aif', 'flac', 'ogg', 'mp3'] },
            { name: 'Nord Piano Library (.npno)', extensions: ['npno'] },
            { name: 'Nord Sample Library (.nsmp, .nsmp3, .nsmp4)', extensions: ['nsmp', 'nsmp3', 'nsmp4'] },
            { name: 'Kontakt 1-4 (.nki, sem criptografia)', extensions: ['nki'] },
            { name: 'Logic EXS24 (.exs)', extensions: ['exs'] },
            { name: 'SFZ (.sfz) — inclui exportações do Kontakt 5-8', extensions: ['sfz'] },
            { name: 'MRQ Instrument — formato leve do Rack (.mrqi)', extensions: ['mrqi'] },
            { name: 'Todos os arquivos', extensions: ['*'] },
        ],
    });
    if (result.canceled || result.filePaths.length === 0)
        return null;
    return result.filePaths[0];
});
electron_1.ipcMain.handle('fs:openExternal', (_e, url) => electron_1.shell.openExternal(url));
/** Equivalente Electron de save_binary_file (src-tauri/src/fsops.rs) — usado
 *  hoje pela exportação de camadas do Rack para `.mrqi` (ver mrqiExport.ts). */
electron_1.ipcMain.handle('fs:saveBinaryFile', async (_e, defaultName, data) => {
    const result = await electron_1.dialog.showSaveDialog(mainWindow, {
        title: 'Salvar instrumento .mrqi',
        defaultPath: defaultName,
        filters: [{ name: 'MRQ Instrument (.mrqi)', extensions: ['mrqi'] }],
    });
    if (result.canceled || !result.filePath)
        return null;
    await node_fs_1.default.promises.writeFile(result.filePath, Buffer.from(data));
    return result.filePath;
});
/** Equivalente Electron de list_dir_entry_names (src-tauri/src/fsops.rs) —
 *  usado pelo NkiLayerVoice pra resolver, sem diferenciar maiúsculas/
 *  minúsculas, caminhos de amostra de um `.nki` contra os arquivos de
 *  verdade no disco (necessário sobretudo no Linux, onde o sistema de
 *  arquivos é case-sensitive — no Windows/macOS a busca exata já bastava). */
electron_1.ipcMain.handle('fs:listDirNames', async (_e, dirPath) => node_fs_1.default.promises.readdir(dirPath));
/** Diálogo genérico "escolher pasta" com título customizável — ver
 *  fs:chooseFolder em preload.ts pro caso de uso (pedir a pasta raiz de uma
 *  biblioteca Kontakt quando amostras de um .nki não resolveram sozinhas). */
electron_1.ipcMain.handle('fs:chooseFolder', async (_e, title) => {
    if (process.env.MRQ_TEST_FOLDER)
        return process.env.MRQ_TEST_FOLDER;
    const result = await electron_1.dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: title || 'Escolha a pasta',
    });
    if (result.canceled || result.filePaths.length === 0)
        return null;
    return result.filePaths[0];
});
/** Limites de segurança pra varredura recursiva de find_sample_files — uma
 *  biblioteca de amostras legítima tem no máximo alguns milhares de
 *  arquivos; estes limites só existem pra não travar o app se o usuário
 *  apontar sem querer pra uma pasta gigante (ex. a raiz do disco inteiro). */
const FIND_SAMPLE_FILES_MAX_ENTRIES = 200_000;
const FIND_SAMPLE_FILES_MAX_DEPTH = 16;
/** Equivalente Electron de find_sample_files (src-tauri/src/fsops.rs) — ver
 *  fs:findSampleFiles em preload.ts. Varre `rootDir` recursivamente (com os
 *  limites acima) e devolve, pra cada nome em `fileNames` que foi
 *  encontrado em algum lugar da árvore, o caminho absoluto do primeiro
 *  arquivo com esse nome (sem diferenciar maiúsculas/minúsculas). */
electron_1.ipcMain.handle('fs:findSampleFiles', async (_e, rootDir, fileNames) => {
    const wanted = new Set(fileNames.map((n) => n.toLowerCase()));
    const found = {};
    let visited = 0;
    async function walk(dir, depth) {
        if (wanted.size === Object.keys(found).length)
            return; // já achou tudo
        if (depth > FIND_SAMPLE_FILES_MAX_DEPTH || visited > FIND_SAMPLE_FILES_MAX_ENTRIES)
            return;
        let entries;
        try {
            entries = await node_fs_1.default.promises.readdir(dir, { withFileTypes: true });
        }
        catch {
            return; // pasta sem permissão de leitura/sumiu no meio da varredura — ignora, não é fatal
        }
        for (const entry of entries) {
            visited += 1;
            if (visited > FIND_SAMPLE_FILES_MAX_ENTRIES)
                return;
            const fullPath = node_path_1.default.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(fullPath, depth + 1);
            }
            else if (entry.isFile()) {
                const lower = entry.name.toLowerCase();
                if (wanted.has(lower) && !(lower in found))
                    found[lower] = fullPath;
            }
        }
    }
    await walk(rootDir, 0);
    return found;
});
// ---------- IPC: log de diagnóstico ----------
electron_1.ipcMain.handle('log:append', (_e, line) => {
    appendLog(String(line));
    return true;
});
electron_1.ipcMain.handle('log:getPath', () => logFilePath);
electron_1.ipcMain.handle('log:reveal', async () => {
    ensureLogDir();
    if (logFlushTimer)
        clearTimeout(logFlushTimer);
    logFlushTimer = null;
    await flushLogQueue();
    if (!node_fs_1.default.existsSync(logFilePath))
        node_fs_1.default.writeFileSync(logFilePath, '', 'utf8');
    electron_1.shell.showItemInFolder(logFilePath);
    return logFilePath;
});
electron_1.ipcMain.handle('log:readTail', async (_e, maxChars = 200000) => {
    try {
        // garante que linhas ainda na fila (gravação assíncrona em lote) apareçam
        if (logFlushTimer)
            clearTimeout(logFlushTimer);
        logFlushTimer = null;
        await flushLogQueue();
        if (!node_fs_1.default.existsSync(logFilePath))
            return '';
        const content = node_fs_1.default.readFileSync(logFilePath, 'utf8');
        return content.length > maxChars ? content.slice(-maxChars) : content;
    }
    catch {
        return '';
    }
});
electron_1.ipcMain.handle('log:clear', async () => {
    try {
        if (logFlushTimer)
            clearTimeout(logFlushTimer);
        logFlushTimer = null;
        logQueue = [];
        node_fs_1.default.writeFileSync(logFilePath, '', 'utf8');
    }
    catch { /* noop */ }
    return true;
});
electron_1.ipcMain.handle('net:localAddresses', () => {
    const nets = node_os_1.default.networkInterfaces();
    const addresses = [];
    for (const name of Object.keys(nets)) {
        for (const iface of nets[name] ?? []) {
            if (iface.family === 'IPv4' && !iface.internal)
                addresses.push(iface.address);
        }
    }
    return addresses;
});
// ---------- IPC: remoto (estado vindo do renderer para difundir ao celular) ----------
electron_1.ipcMain.on('remote:state', (_e, snapshot) => {
    remoteServer?.broadcastState(snapshot);
});
electron_1.ipcMain.handle('remote:getInfo', () => {
    const settings = store.get('settings');
    return { port: settings.remote.port, pin: settings.remote.pin, enabled: settings.remote.enabled };
});
//# sourceMappingURL=main.js.map