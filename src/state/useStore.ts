import { create } from 'zustand';
import type {
  AppSettings,
  ArrangementTemplate,
  InstrumentRackState,
  Library,
  MidiBinding,
  PartType,
  RackLayer,
  Scene,
  Song,
  SongArrangement,
  SongPart,
  SongTrack,
  TrackRole,
} from '../../shared/types';
import { DEFAULT_SETTINGS, DEFAULT_RACK_STATE, PART_COLORS, migrateRackLayers } from '../../shared/types';
import { newId } from '../lib/id';
import { engine, padEngine } from '../audio/engineInstance';
import { combinePeaks, computePeaks, decodeForAnalysis, yieldToBrowser } from '../audio/waveform';
import { detectBpm, detectKey } from '../audio/KeyBpmDetection';
import { recognizeParts, type RecognitionSensitivity } from '../audio/PartRecognition';
import { recognizePartsFromSpeech } from '../audio/SpeechPartRecognition';
import type { EngineState } from '../audio/AudioEngine';
import { rackEngine } from '../audio/rack/RackEngine';
import { detectChord } from '../midi/chordDetect';
import { sendMidiProgramChange } from '../midi/midiController';

export type NavId =
  | 'library'
  | 'setlist'
  | 'arrange'
  | 'tracks'
  | 'tempo'
  | 'chord'
  | 'outputs'
  | 'key'
  | 'guide'
  | 'midi'
  | 'rack'
  | 'converter'
  | 'help';

interface Toast {
  id: string;
  message: string;
  kind: 'info' | 'error';
}

interface StoreState {
  ready: boolean;
  library: Library;
  settings: AppSettings;
  currentSong: Song | null;
  nav: NavId;
  secondaryPanelCollapsed: boolean;
  /** "Modo Palco — Telão": overlay de cifra em tela cheia pra monitor/TV secundário (ver TeleprompterOverlay.tsx) */
  teleprompterOpen: boolean;
  engineState: EngineState;
  toasts: Toast[];
  recognizing: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** espelho reativo de padEngine.playing, pra UI poder reagir (a classe do motor não dispara re-render sozinha) */
  padActive: boolean;
  /** histórico (em memória, desta sessão) das partes/músicas tocadas, mais recente primeiro — ver "Histórico de execução" */
  playLog: { songTitle: string; partName: string; at: number }[];
  /** id da cena aberta no painel de Setlist — fica no estado global (não só local do painel) para que
   *  outras telas (ex.: prévia da próxima música no cabeçalho) também saibam qual cena está em uso. */
  activeSceneId: string | null;
  /** título da música sendo aberta/importada no momento, ou null quando nada está em andamento.
   *  Usado para mostrar um indicador visual claro enquanto as faixas são decodificadas — sem isso,
   *  clicar numa música grande (muitas faixas) parecia "não abrir nada", quando na verdade só estava
   *  carregando em silêncio sem nenhum retorno visual. */
  loadingSongTitle: string | null;
  /** id da música (já existente na biblioteca) sendo carregada — só usado para evitar 2 cliques
   *  disparando 2 carregamentos da mesma música em paralelo; não se aplica ao fluxo de importação
   *  (que ainda não tem um id de biblioteca nas etapas iniciais de escaneamento/detecção). */
  loadingSongId: string | null;
  /** último estado recebido via "MRQ Sync" de quem está no papel de Líder na rede local (null = nada recebido/sync desligado) */
  syncLeaderState: { isPlaying: boolean; bpm: number; key: string; songTitle: string } | null;
  /** ids das partes selecionadas na tela "Ajustes de partes" para ações em lote (excluir/mudar tipo várias de uma vez) */
  selectedPartIds: string[];

  init: () => Promise<void>;
  setNav: (nav: NavId) => void;
  toggleSecondaryPanel: () => void;
  setTeleprompterOpen: (open: boolean) => void;
  pushToast: (message: string, kind?: 'info' | 'error') => void;
  dismissToast: (id: string) => void;

  importSongFromFolder: () => Promise<void>;
  selectSong: (songId: string) => Promise<void>;
  deleteSong: (songId: string) => void;
  renameSong: (songId: string, title: string) => void;

  updateCurrentSong: (mutator: (song: Song) => Song, opts?: { history?: boolean }) => void;
  undo: () => void;
  redo: () => void;
  setPartsFromRecognition: (sensitivity?: RecognitionSensitivity) => Promise<void>;
  addPart: (part: Omit<SongPart, 'id'>) => void;
  updatePart: (partId: string, patch: Partial<SongPart>) => void;
  deletePart: (partId: string) => void;
  /** Funde uma parte com a próxima (correção rápida de uma detecção automática
   *  que separou demais) — a parte seguinte desaparece e esta passa a cobrir
   *  os compassos das duas. */
  mergePartWithNext: (partId: string) => void;
  /** Divide uma parte ao meio (correção rápida de uma detecção automática que
   *  juntou duas seções diferentes numa parte só). */
  splitPart: (partId: string) => void;
  addArrangement: (name: string) => string;
  setActiveArrangement: (id: string | null) => void;
  updateArrangementSteps: (arrangementId: string, steps: SongArrangement['steps']) => void;
  /**
   * Garante que existe um arranjo "editável" para a música atual: se já há um
   * arranjo ativo, devolve seu id; senão, cria um novo a partir da ordem atual
   * das partes (equivalente a "salvar como nova versão") e devolve o novo id.
   * Replica o fluxo do Trilha: ao mexer no roteiro pela primeira vez, ele
   * pergunta se você quer salvar uma versão nova em vez de alterar o original.
   */
  ensureEditableArrangement: (suggestedName: string) => string;
  /** Renomeia uma versão/arranjo salvo (não afeta a "Original (ordem gravada)", que não tem id). */
  renameArrangement: (arrangementId: string, name: string) => void;
  /** Exclui uma versão salva. Se ela estiver ativa, volta pra "Original (ordem gravada)". */
  deleteArrangement: (arrangementId: string) => void;

  /** Seleção múltipla de partes (tela "Ajustes de partes"), pra ações em lote. */
  togglePartSelection: (partId: string) => void;
  selectAllParts: () => void;
  clearPartSelection: () => void;
  /** Exclui todas as partes selecionadas de uma vez (com undo). */
  bulkDeleteParts: (partIds: string[]) => void;
  /** Muda o tipo de várias partes selecionadas de uma vez (ex.: corrigir 4 "Verso" detectados errado pra "Refrão"). */
  bulkSetPartType: (partIds: string[], type: PartType) => void;
  /**
   * "Encaixar no tempo": arredonda o início/fim de uma parte pro tempo
   * (beat) mais próximo, usando o fórmula de compasso da música — corrige
   * pequenos erros de quem arrastou a seleção na forma de onda com a mão.
   */
  snapPartToBeat: (partId: string) => void;

  /** Salva o roteiro de tipos de parte do arranjo ativo (ou da ordem original) como um modelo reutilizável. */
  saveArrangementTemplate: (name: string) => void;
  /** Aplica um modelo salvo à música atual, casando cada passo do modelo com a primeira parte daquele tipo disponível. */
  applyArrangementTemplate: (templateId: string) => void;
  deleteArrangementTemplate: (templateId: string) => void;

  setKey: (key: string) => void;
  setBpm: (bpm: number) => void;
  setTrackRole: (trackId: string, role: TrackRole) => void;
  setTrackFollowsKey: (trackId: string, follow: boolean) => void;
  setTrackVolumeDb: (trackId: string, db: number) => void;
  setTrackMuted: (trackId: string, muted: boolean) => void;
  setTrackSolo: (trackId: string, solo: boolean) => void;
  setTrackOutput: (trackId: string, output: string) => void;
  setChordChart: (raw: string, originalKey: string) => void;

  play: () => Promise<void>;
  pause: () => Promise<void>;
  stop: () => Promise<void>;
  jumpToPart: (partId: string) => void;
  jumpRelative: (dir: 1 | -1) => void;
  toggleLoopActivePart: () => void;
  setPracticeLoop: (startBar: number, endBar: number) => void;
  clearPracticeLoop: () => void;

  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  updateRack: (patch: Partial<InstrumentRackState>) => void;
  updateRackLayer: (index: number, patch: Partial<RackLayer>) => void;
  addMidiBinding: (binding: MidiBinding) => void;
  removeMidiBinding: (predicate: (b: MidiBinding) => boolean) => void;

  addScene: (name: string) => void;
  updateScene: (sceneId: string, patch: Partial<Scene>) => void;
  deleteScene: (sceneId: string) => void;
  importScene: (scene: Scene) => void;

  togglePad: () => void;
  clearPlayLog: () => void;
  setActiveSceneId: (id: string | null) => void;
  toggleFavorite: (songId: string) => void;
  updateSongNotes: (songId: string, notes: string) => void;
  /**
   * Remove da versão/arranjo ativo todos os passos que tocam alguma das partes
   * indicadas — usado pelo recurso "selecionar um trecho na forma de onda e
   * excluir" (tela Arranjar). Se ainda não existe uma versão editável para a
   * música, cria uma nova a partir da ordem atual antes de remover (mesmo
   * fluxo de "salvar como nova versão" já usado no editor de roteiro), nunca
   * mexendo na ordem original.
   */
  deletePartsFromArrangement: (partIds: string[], suggestedName: string) => void;
}

// Histórico de desfazer/refazer por música (em memória, não persistido).
// Guarda snapshots completos do Song antes de cada edição estrutural
// (partes/arranjos), permitindo Ctrl+Z / Ctrl+Shift+Z no editor de arranjo,
// igual ao fluxo mostrado no Trilha.
const historyPast = new Map<string, Song[]>();
const historyFuture = new Map<string, Song[]>();
const HISTORY_LIMIT = 40;

function pushHistory(songId: string, snapshot: Song) {
  const arr = historyPast.get(songId) ?? [];
  arr.push(snapshot);
  if (arr.length > HISTORY_LIMIT) arr.shift();
  historyPast.set(songId, arr);
  historyFuture.set(songId, []);
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(library: Library) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    window.api.store.saveLibrary(library).catch(() => {});
  }, 400);
}

// Pastas de multitrack costumam vir nomeadas com padrões como:
//   "Tua Alegria (Ao Vivo) - Drops - B - 130 bpm"
//   "Sou Grato Por Seu Amor-ASI SERA-D-72.00bpm"
// ou seja: "{Título} - {opcional: versão/seção} - {Tom} - {BPM}bpm", com "-"
// podendo vir com ou sem espaços ao redor. Esta função tenta extrair o tom e
// o BPM do nome da pasta, deixando o resto como título da música.
const KEY_TOKEN_REGEX = /^[A-Ga-g](#|b|s)?m?$/;

function normalizeKeyToken(token: string): string {
  const m = token.match(/^([A-Ga-g])(#|b|s)?(m)?$/);
  if (!m) return token;
  const note = m[1].toUpperCase();
  const accidental = m[2] ? (m[2].toLowerCase() === 's' ? '#' : m[2].toLowerCase()) : '';
  const minor = m[3] ? 'm' : '';
  return `${note}${accidental}${minor}`;
}

function parseSongFolderName(raw: string): { title: string; key: string | null; bpm: number | null } {
  let working = raw.trim();
  let bpm: number | null = null;
  let key: string | null = null;

  // 1) BPM: procura um número (com casas decimais opcionais) seguido de "bpm".
  const bpmMatch = working.match(/^(.*?)[\s\-_]*([\d]{2,3}(?:[.,]\d+)?)\s*bpm\b(.*)$/i);
  if (bpmMatch) {
    const parsed = parseFloat(bpmMatch[2].replace(',', '.'));
    if (!Number.isNaN(parsed) && parsed > 0) {
      bpm = Math.round(parsed * 100) / 100;
      working = `${bpmMatch[1]} ${bpmMatch[3]}`.trim();
    }
  }

  // 2) Tom: olha o último segmento separado por "-"/"_" e vê se parece um tom
  // musical (ex: "B", "C#", "Db", "F#m", "Bbm").
  working = working.replace(/[\s\-_]+$/, '');
  const segments = working.split(/\s*-\s*|_/).filter((s) => s.trim().length > 0);
  if (segments.length > 1) {
    const last = segments[segments.length - 1].trim();
    if (KEY_TOKEN_REGEX.test(last)) {
      key = normalizeKeyToken(last);
      segments.pop();
      working = segments.join(' - ');
    }
  }

  const title = working.trim().replace(/[\s\-_]+$/, '') || raw.trim();
  return { title, key, bpm };
}

function guessRole(name: string): TrackRole {
  const n = name.toLowerCase();
  if (/(click|metr[oô]nomo)/.test(n)) return 'click';
  if (/(guide|guia|cue)/.test(n)) return 'guide';
  if (/(drum|bateria|kick|snare|overhead)/.test(n)) return 'drums';
  if (/(bass|baixo)/.test(n)) return 'bass';
  if (/(guitar|guitarra|eg\d|gtr)/.test(n)) return 'guitar';
  if (/(key|teclado|piano|synth|pad)/.test(n)) return n.includes('pad') ? 'loop' : 'keys';
  if (/(vocal|voz|lead|bgv|choir|coro|coral)/.test(n)) return n.includes('choir') || n.includes('coro') ? 'choir' : 'vocal';
  if (/(loop)/.test(n)) return 'loop';
  return 'other';
}

function defaultTrack(name: string, filePath: string): SongTrack {
  return {
    id: newId(),
    name,
    filePath,
    role: guessRole(name),
    followsKey: !/(click|guia|guide)/i.test(name),
    output: 'stereo-1-2',
    volumeDb: 0,
    muted: false,
    solo: false,
  };
}

/**
 * Click e Guide sempre primeiro na mixagem — são as faixas que a banda mais
 * precisa achar rápido no palco (referência de tempo e de tom/letra), e é
 * assim que ferramentas de playback ao vivo da categoria organizam a tira de
 * canais (em vez de simplesmente seguir a ordem alfabética dos arquivos,
 * que é o que a varredura de pasta devolve). O resto mantém a ordem em que
 * foi encontrado — só os dois primeiros lugares são reservados.
 */
function sortTracksForMixer(tracks: SongTrack[]): SongTrack[] {
  const priority: Partial<Record<TrackRole, number>> = { click: 0, guide: 1 };
  return [...tracks]
    .map((track, index) => ({ track, index }))
    .sort((a, b) => {
      const pa = priority[a.track.role] ?? 2;
      const pb = priority[b.track.role] ?? 2;
      if (pa !== pb) return pa - pb;
      return a.index - b.index;
    })
    .map((x) => x.track);
}

async function urlsForSong(song: Song): Promise<Record<string, string>> {
  const entries = await Promise.all(
    song.tracks.map(async (t) => [t.id, await window.api.fs.toFileUrl(t.filePath)] as const)
  );
  return Object.fromEntries(entries);
}

/**
 * Escolhe a melhor faixa pra estimar BPM/tom por análise de áudio, quando o
 * nome da pasta não traz essa informação. Pra BPM, uma faixa de click (se
 * existir) é ideal — ela é perfeitamente periódica. Pra tom, preferimos um
 * instrumento harmônico (teclado/violão/baixo) em vez de bateria/click, que
 * não têm altura definida.
 */
function pickTrackForAnalysis(tracks: SongTrack[], purpose: 'bpm' | 'key'): SongTrack | null {
  if (purpose === 'bpm') {
    return (
      tracks.find((t) => t.role === 'click') ??
      tracks.find((t) => t.role === 'drums') ??
      tracks.find((t) => t.role !== 'guide') ??
      tracks[0] ??
      null
    );
  }
  return (
    tracks.find((t) => t.role === 'keys') ??
    tracks.find((t) => t.role === 'guitar') ??
    tracks.find((t) => t.role === 'bass') ??
    tracks.find((t) => t.role === 'vocal') ??
    tracks.find((t) => t.role !== 'click' && t.role !== 'drums' && t.role !== 'guide') ??
    tracks[0] ??
    null
  );
}


export const useStore = create<StoreState>((set, get) => ({
  ready: false,
  library: { songs: [], scenes: [], arrangementTemplates: [] },
  settings: DEFAULT_SETTINGS,
  currentSong: null,
  nav: 'library',
  secondaryPanelCollapsed: false,
  teleprompterOpen: false,
  engineState: engine.getState(),
  toasts: [],
  recognizing: false,
  canUndo: false,
  canRedo: false,
  padActive: false,
  playLog: [],
  activeSceneId: null,
  loadingSongTitle: null,
  loadingSongId: null,
  syncLeaderState: null,
  selectedPartIds: [],

  init: async () => {
    const [library, loadedSettings] = await Promise.all([window.api.store.getLibrary(), window.api.store.getSettings()]);
    // Migração: sessões salvas antes do Rack passar a ter 6 camadas (era 4)
    // só têm 4 entradas em settings.rack.layers — completa com camadas vazias
    // em vez de travar/cortar o que o usuário já tinha configurado (no-op se
    // já tiver as 6 camadas).
    // Mescla com DEFAULT_RACK_STATE (e não só espalha loadedSettings.rack por
    // cima) pra sessões salvas antes de um novo campo do rack existir (ex.:
    // oitavador do master, mostrador de acorde) herdarem o padrão em vez de
    // ficarem com `undefined`.
    const settings = {
      ...loadedSettings,
      rack: { ...DEFAULT_RACK_STATE, ...loadedSettings.rack, layers: migrateRackLayers(loadedSettings.rack.layers) },
    };
    set({ library: { ...library, arrangementTemplates: library.arrangementTemplates ?? [] }, settings, ready: true });
    padEngine.setOutput(settings.pad.output);
    padEngine.setBreatheSeconds(settings.pad.loopCrossfadeSec);

    let lastLoggedPartId: string | null = null;
    let lastReportedPlaying: boolean | null = null;
    let lastOscPlaying: boolean | null = null;
    let lastOscPartId: string | null = null;
    let lastOscBpm: number | null = null;
    let lastOscKey: string | null = null;
    let lastCuePartId: string | null = null;
    let lastSyncSnapshot = '';
    engine.subscribe((engineState) => {
      set({ engineState });
      const song = get().currentSong;
      const settingsNow = get().settings;
      const parts = song?.parts.map((p, i) => ({ id: p.id, name: p.name, index: i + 1 })) ?? [];

      // Acorde detectado agora no Rack (mesma lógica da pílula da barra de
      // título, ver ChordIndicator.tsx) — incluído no estado enviado pro(s)
      // celular(es) conectado(s) via controle remoto, pra todo mundo da banda
      // ver o mesmo acorde ao vivo na tela do próprio aparelho (não só quem
      // está no computador principal).
      const activeNotes = rackEngine.getActiveNotesSnapshot();
      const currentChord = activeNotes.length ? detectChord(activeNotes)?.label ?? null : null;

      window.api.remote.sendState({
        songTitle: song?.title ?? null,
        isPlaying: engineState.isPlaying,
        currentKey: song?.currentKey ?? '-',
        currentBpm: song?.currentBpm ?? 0,
        parts,
        activePartId: engineState.activePartId,
        positionSec: engineState.realSeconds,
        durationSec: engineState.realTotalSeconds,
        currentChord,
      });

      // ---------------- OSC: transporte/parte/tempo/tom ----------------
      // Só manda quando a ponte OSC está ligada, e só quando o valor de fato
      // mudou desde o último quadro — evita inundar a rede a 25 mensagens
      // por segundo (frequência do monitor interno do motor de áudio).
      if (settingsNow.osc.enabled) {
        if (engineState.isPlaying !== lastOscPlaying) {
          lastOscPlaying = engineState.isPlaying;
          void window.api.osc.send(engineState.isPlaying ? '/mrq/transport/play' : '/mrq/transport/stop', []);
        }
        if (song && song.currentBpm !== lastOscBpm) {
          lastOscBpm = song.currentBpm;
          void window.api.osc.send('/mrq/tempo', [{ type: 'f', value: song.currentBpm }]);
        }
        if (song && song.currentKey !== lastOscKey) {
          lastOscKey = song.currentKey;
          void window.api.osc.send('/mrq/key', [{ type: 's', value: song.currentKey }]);
        }
      }
      if (song && engineState.activePartId !== lastOscPartId) {
        lastOscPartId = engineState.activePartId;
        const part = song.parts.find((p) => p.id === engineState.activePartId);
        if (part && settingsNow.osc.enabled) {
          const idx = song.parts.indexOf(part);
          void window.api.osc.send('/mrq/part', [
            { type: 'i', value: idx + 1 },
            { type: 's', value: part.name },
          ]);
        }
      }

      // ---------------- Cues de palco por parte (MIDI/OSC) ----------------
      // Dispara automaticamente quando a parte ativa muda E tem um cue
      // configurado (ver SongPart.cueOscAddress/cueMidiProgram) — independente
      // da transmissão geral de transporte acima (um cue de MIDI, por
      // exemplo, funciona mesmo com a ponte OSC desligada).
      if (song && engineState.activePartId !== lastCuePartId) {
        lastCuePartId = engineState.activePartId;
        const part = song.parts.find((p) => p.id === engineState.activePartId);
        if (part?.cueOscAddress && settingsNow.osc.enabled) {
          void window.api.osc.send(part.cueOscAddress, []);
        }
        if (part?.cueMidiProgram) {
          sendMidiProgramChange(part.cueMidiProgram.channel, part.cueMidiProgram.program);
        }
      }

      // ---------------- MRQ Sync: líder transmite o estado ----------------
      if (settingsNow.sync.enabled && settingsNow.sync.role === 'leader') {
        const snapshot = `${engineState.isPlaying}|${song?.currentBpm ?? 0}|${song?.currentKey ?? '-'}|${song?.title ?? ''}`;
        if (snapshot !== lastSyncSnapshot) {
          lastSyncSnapshot = snapshot;
          window.api.sync.broadcastState({
            isPlaying: engineState.isPlaying,
            bpm: song?.currentBpm ?? 0,
            key: song?.currentKey ?? '-',
            songTitle: song?.title ?? '',
          });
        }
      }

      // Histórico de execução: registra cada parte que começa a tocar de
      // fato (evita duplicar quando o id não muda entre ticks).
      if (engineState.isPlaying && song && engineState.activePartId && engineState.activePartId !== lastLoggedPartId) {
        lastLoggedPartId = engineState.activePartId;
        const part = song.parts.find((p) => p.id === engineState.activePartId);
        if (part) {
          set((s) => ({
            playLog: [{ songTitle: song.title, partName: part.name, at: Date.now() }, ...s.playLog].slice(0, 500),
          }));
        }
      }
      if (!engineState.isPlaying) lastLoggedPartId = null;

      // Avisa o processo principal quando a reprodução liga/desliga, pra ele
      // poder confirmar antes de fechar o app no meio de uma música ao vivo.
      if (engineState.isPlaying !== lastReportedPlaying) {
        lastReportedPlaying = engineState.isPlaying;
        window.api.app?.reportPlaybackState?.(engineState.isPlaying);
      }
    });

    window.api.remote.onCommand((cmd) => {
      const api = get();
      if (cmd.type === 'play') api.play();
      else if (cmd.type === 'pause') api.pause();
      else if (cmd.type === 'stop') api.stop();
      else if (cmd.type === 'jumpToPart') api.jumpToPart(cmd.partId);
      else if (cmd.type === 'setKey') api.setKey(cmd.key);
      else if (cmd.type === 'setBpm') api.setBpm(cmd.bpm);
      else if (cmd.type === 'toggleLoop') api.toggleLoopActivePart();
    });

    // Comandos OSC recebidos (ex.: de um TouchOSC, QLab ou qualquer app que
    // fale OSC) — endereços simples de transporte/navegação, análogos aos do
    // controle remoto por celular. Ver HelpPanel.tsx seção "osc" pra lista
    // completa. Mensagens com endereço desconhecido são ignoradas.
    window.api.osc.onMessage((msg) => {
      const api = get();
      const song = api.currentSong;
      switch (msg.address) {
        case '/mrq/play':
        case '/mrq/transport/play':
          api.play();
          break;
        case '/mrq/pause':
        case '/mrq/transport/pause':
          api.pause();
          break;
        case '/mrq/stop':
        case '/mrq/transport/stop':
          api.stop();
          break;
        case '/mrq/next':
          api.jumpRelative(1);
          break;
        case '/mrq/prev':
          api.jumpRelative(-1);
          break;
        case '/mrq/jump': {
          const idx = msg.args[0] && msg.args[0].type === 'i' ? msg.args[0].value : null;
          if (song && idx !== null && song.parts[idx - 1]) api.jumpToPart(song.parts[idx - 1].id);
          break;
        }
        default:
          break;
      }
    });

    // "MRQ Sync": quando configurado como Seguidor, só guarda o último estado
    // recebido do Líder da rede local pra exibição (ver syncLeaderState) —
    // nunca aplica automaticamente (play/pause/BPM) na reprodução local, por
    // segurança ao vivo (ver justificativa em src-tauri/src/sync.rs).
    window.api.sync.onState((state) => {
      set({ syncLeaderState: state });
    });

    // "Voz guia": quando configurado para anunciar a parte pedida fora de
    // ordem, usamos a síntese de voz do próprio navegador/Chromium (sem
    // precisar de nenhum arquivo de áudio extra) para falar o nome da parte.
    engine.setAnnounceHandler((text) => {
      try {
        if (!('speechSynthesis' in window)) return;
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'pt-BR';
        utterance.rate = 1.05;
        utterance.volume = 1;
        window.speechSynthesis.speak(utterance);
      } catch { /* noop */ }
    });
  },

  setNav: (nav) => set({ nav }),
  toggleSecondaryPanel: () => set((s) => ({ secondaryPanelCollapsed: !s.secondaryPanelCollapsed })),
  setTeleprompterOpen: (open) => set({ teleprompterOpen: open }),
  pushToast: (message, kind = 'info') =>
    set((s) => ({ toasts: [...s.toasts, { id: newId(), message, kind }] })),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  importSongFromFolder: async () => {
    const folder = await window.api.fs.chooseSongFolder();
    if (!folder) return;
    const found = await window.api.fs.scanFolderTracks(folder);
    if (found.length === 0) {
      get().pushToast('Nenhum arquivo de áudio encontrado nessa pasta.', 'error');
      return;
    }
    const tracks = sortTracksForMixer(found.map((f) => defaultTrack(f.name, f.filePath)));
    const folderName = folder.split(/[\\/]/).filter(Boolean).pop() ?? 'Nova música';
    const parsed = parseSongFolderName(folderName);
    const title = parsed.title || folderName;

    // Mostra retorno visual já aqui — escanear a pasta foi rápido, mas a
    // detecção de BPM/tom por áudio (abaixo, quando necessária) e a
    // decodificação de todas as faixas em seguida podem levar alguns
    // segundos, e sem isso a tela ficava parada sem nenhum sinal de que algo
    // estava acontecendo.
    set({ loadingSongTitle: title });

    // try/finally envolve TODO o resto da importação: se qualquer coisa aqui
    // lançar um erro inesperado antes de chegarmos a selectSong() (que tem a
    // sua própria limpeza), o indicador de carregamento ainda assim é
    // desligado — evita a tela ficar "presa" em "abrindo..." para sempre.
    try {
      // Se o nome da pasta não trouxe BPM e/ou tom, tenta detectar por análise
      // de áudio (ver src/audio/KeyBpmDetection.ts) antes de cair no padrão
      // fixo (C / 120 bpm). Roda sobre uma única faixa (não todas), decidida
      // pela função acima, pra manter o import rápido.
      let detectedKey = parsed.key;
      let detectedBpm = parsed.bpm;
      const audioDetected: string[] = [];
      if (!detectedBpm || !detectedKey) {
        try {
          if (!detectedBpm) {
            const t = pickTrackForAnalysis(tracks, 'bpm');
            if (t) {
              const url = await window.api.fs.toFileUrl(t.filePath);
              const buf = await decodeForAnalysis(engine.ctx, url);
              const bpm = detectBpm(buf);
              if (bpm) {
                detectedBpm = bpm;
                audioDetected.push(`BPM ${bpm} (por áudio)`);
              }
            }
          }
          if (!detectedKey) {
            const t = pickTrackForAnalysis(tracks, 'key');
            if (t) {
              const url = await window.api.fs.toFileUrl(t.filePath);
              const buf = await decodeForAnalysis(engine.ctx, url);
              const key = detectKey(buf);
              if (key) {
                detectedKey = key;
                audioDetected.push(`tom ${key} (por áudio)`);
              }
            }
          }
        } catch (err) {
          console.error('[deteccao] falha ao analisar audio para bpm/tom', err);
        }
      }

      const finalKey = detectedKey ?? 'C';
      const finalBpm = detectedBpm ?? 120;
      const now = Date.now();
      const wholeSongPart: SongPart = {
        id: newId(),
        name: 'Música inteira',
        type: 'Outra',
        startBar: 1,
        endBar: 1000,
        color: PART_COLORS.Outra,
      };
      const song: Song = {
        id: newId(),
        title,
        folderPath: folder,
        originalKey: finalKey,
        currentKey: finalKey,
        originalBpm: finalBpm,
        currentBpm: finalBpm,
        timeSignatureNum: 4,
        timeSignatureDen: 4,
        durationSec: 0,
        tracks,
        parts: [wholeSongPart],
        arrangements: [],
        activeArrangementId: null,
        chordChart: null,
        waveformPeaks: null,
        createdAt: now,
        updatedAt: now,
      };
      const library = { ...get().library, songs: [...get().library.songs, song] };
      set({ library });
      scheduleSave(library);
      const fromName = [parsed.key ? `tom ${finalKey}` : null, parsed.bpm ? `${finalBpm} bpm` : null].filter(Boolean);
      const detectedInfo = [...fromName, ...audioDetected].join(', ');
      get().pushToast(
        `"${title}" importada com ${tracks.length} faixas${detectedInfo ? ` (${detectedInfo} detectados)` : ''}.`
      );
      // selectSong() assume o indicador de carregamento a partir daqui (mesmo
      // título) e faz sua própria limpeza em finally — por isso não limpamos
      // loadingSongTitle de novo depois dessa chamada.
      await get().selectSong(song.id);
    } catch (err) {
      console.error('[import] falha inesperada ao importar a música', err);
      get().pushToast('Falha inesperada ao importar essa música.', 'error');
      set({ loadingSongTitle: null, loadingSongId: null });
    }
  },


  selectSong: async (songId) => {
    const song = get().library.songs.find((s) => s.id === songId);
    if (!song) return;
    // Evita cliques duplos disparando 2 carregamentos em paralelo da MESMA música
    // (ex: usuário clica de novo achando que não respondeu, enquanto já está carregando).
    if (get().loadingSongId === songId) return;
    // zera o histórico de desfazer/refazer da música anterior
    historyPast.clear();
    historyFuture.clear();
    set({ canUndo: false, canRedo: false, loadingSongTitle: song.title, loadingSongId: songId });
    // Rede de segurança: decodificar várias faixas grandes pode legitimamente
    // levar alguns segundos, mas nunca deve ficar "preso" sem nenhum retorno
    // visual. Se depois de 45s ainda não terminou, avisa o usuário em vez de
    // deixar a tela parecendo travada/sem resposta para sempre.
    const watchdog = setTimeout(() => {
      if (get().loadingSongId === songId && get().currentSong?.id !== song.id) {
        get().pushToast(
          `"${song.title}" está demorando muito mais que o normal para abrir. Verifique se os arquivos não estão num disco de rede/USB lento, ou tente novamente.`,
          'error'
        );
      }
    }, 45000);
    try {
      const urls = await urlsForSong(song);
      const { failed } = await engine.loadSong(song, urls);
      set({ currentSong: song });

      if (failed.length > 0) {
        const nomes = failed.slice(0, 4).map((f) => `${f.name} (${f.reason})`).join(', ');
        const resto = failed.length > 4 ? ` e mais ${failed.length - 4}` : '';
        if (failed.length === song.tracks.length) {
          get().pushToast(`Nenhuma faixa pôde ser carregada: ${nomes}${resto}.`, 'error');
        } else {
          get().pushToast(`${song.tracks.length - failed.length} de ${song.tracks.length} faixas carregadas. Falharam: ${nomes}${resto}.`, 'error');
        }
      }

      // Forma de onda geral ("master") + por faixa (tela "Faixas"): reaproveita
      // os buffers já decodificados pelo engine para carregar a música — não
      // decodifica de novo (não aumenta o pico de memória) — e usa uma
      // amostragem com passo fixo (ver computePeaks) para não travar a
      // interface calculando isso para 18-20 faixas de uma vez. O "master" é
      // a combinação (o pico mais alto em cada ponto) de todas as faixas que
      // não são o click, para refletir o som real da mixagem e não só uma
      // faixa de guia/click que pode ficar quase toda em silêncio.
      const needsTrackPeaks = !song.tracks.some((t) => t.peaks && t.peaks.length > 0);
      if (needsTrackPeaks || !song.waveformPeaks) {
        try {
          const BUCKETS = 1200;
          const peaksByTrack = new Map<string, number[]>();
          let maxDuration = 0;
          let i = 0;
          for (const t of song.tracks) {
            const buffer = engine.getTrackBuffer(t.id);
            if (buffer) {
              peaksByTrack.set(t.id, computePeaks(buffer, BUCKETS));
              if (buffer.duration > maxDuration) maxDuration = buffer.duration;
            }
            i += 1;
            // cede o controle à cada poucas faixas para manter a UI responsiva
            if (i % 4 === 0) await yieldToBrowser();
          }
          if (peaksByTrack.size > 0) {
            const forMaster = song.tracks
              .filter((t) => t.role !== 'click' && peaksByTrack.has(t.id))
              .map((t) => peaksByTrack.get(t.id)!);
            const master = combinePeaks(forMaster.length > 0 ? forMaster : [...peaksByTrack.values()], BUCKETS);
            get().updateCurrentSong((s) => ({
              ...s,
              waveformPeaks: master,
              durationSec: maxDuration || s.durationSec,
              tracks: s.tracks.map((t) => (peaksByTrack.has(t.id) ? { ...t, peaks: peaksByTrack.get(t.id)! } : t)),
            }));
          }
        } catch (err) {
          console.error('[waveform] falha ao gerar formas de onda', err);
        }
      }
    } catch (err) {
      console.error(err);
      get().pushToast('Não foi possível carregar essa música. Verifique os arquivos.', 'error');
    } finally {
      clearTimeout(watchdog);
      set({ loadingSongTitle: null, loadingSongId: null });
    }
  },

  deleteSong: (songId) => {
    const library = { ...get().library, songs: get().library.songs.filter((s) => s.id !== songId) };
    set({ library, currentSong: get().currentSong?.id === songId ? null : get().currentSong });
    scheduleSave(library);
  },

  renameSong: (songId, title) => {
    get().updateCurrentSong((s) => (s.id === songId ? { ...s, title } : s));
  },

  updateCurrentSong: (mutator, opts) => {
    const current = get().currentSong;
    if (!current) return;
    if (opts?.history) pushHistory(current.id, current);
    const updated = { ...mutator(current), updatedAt: Date.now() };
    const songs = get().library.songs.map((s) => (s.id === updated.id ? updated : s));
    const library = { ...get().library, songs };
    set({
      currentSong: updated,
      library,
      canUndo: (historyPast.get(current.id)?.length ?? 0) > 0,
      canRedo: (historyFuture.get(current.id)?.length ?? 0) > 0,
    });
    scheduleSave(library);
  },

  undo: () => {
    const current = get().currentSong;
    if (!current) return;
    const past = historyPast.get(current.id);
    if (!past || past.length === 0) return;
    const prev = past.pop()!;
    const future = historyFuture.get(current.id) ?? [];
    future.push(current);
    historyFuture.set(current.id, future);
    const songs = get().library.songs.map((s) => (s.id === prev.id ? prev : s));
    const library = { ...get().library, songs };
    engine.updateParts(prev.parts);
    engine.updateArrangements(prev.arrangements, prev.activeArrangementId);
    set({ currentSong: prev, library, canUndo: past.length > 0, canRedo: true });
    scheduleSave(library);
    get().pushToast('Desfeito.');
  },

  redo: () => {
    const current = get().currentSong;
    if (!current) return;
    const future = historyFuture.get(current.id);
    if (!future || future.length === 0) return;
    const next = future.pop()!;
    const past = historyPast.get(current.id) ?? [];
    past.push(current);
    historyPast.set(current.id, past);
    const songs = get().library.songs.map((s) => (s.id === next.id ? next : s));
    const library = { ...get().library, songs };
    engine.updateParts(next.parts);
    engine.updateArrangements(next.arrangements, next.activeArrangementId);
    set({ currentSong: next, library, canUndo: true, canRedo: future.length > 0 });
    scheduleSave(library);
    get().pushToast('Refeito.');
  },

  setPartsFromRecognition: async (sensitivity = 'normal') => {
    const song = get().currentSong;
    if (!song) return;
    set({ recognizing: true });
    try {
      const guideTrack = song.tracks.find((t) => t.role === 'guide') ?? song.tracks.find((t) => t.role === 'vocal') ?? song.tracks[0];
      if (!guideTrack) throw new Error('sem faixas');
      const url = await window.api.fs.toFileUrl(guideTrack.filePath);
      const buffer = await decodeForAnalysis(engine.ctx, url);

      // Tenta primeiro o reconhecimento por VOZ (ouve a locução anunciando
      // cada parte na própria faixa guia — mais preciso que adivinhar só
      // pela forma da onda), e só cai pro método heurístico de energia se
      // essa opção estiver desligada, o modelo ainda não tiver sido baixado,
      // ou a faixa não tiver locução suficiente pra confiar (ver
      // SpeechPartRecognition.ts).
      let parts: SongPart[] = [];
      let usedSpeech = false;
      if (get().settings.speech.enabled) {
        try {
          const modelReady = await window.api.speech.modelReady();
          if (modelReady) {
            const speechParts = await recognizePartsFromSpeech(buffer, song.currentBpm, song.timeSignatureNum, (wav, lang) =>
              window.api.speech.transcribeWav(wav, lang)
            );
            if (speechParts && speechParts.length > 0) {
              parts = speechParts;
              usedSpeech = true;
            }
          }
        } catch (err) {
          console.error('[speech] reconhecimento por voz falhou, caindo pro método por áudio', err);
        }
      }

      if (!usedSpeech) {
        parts = recognizeParts(buffer, song.currentBpm, song.timeSignatureNum, { sensitivity });
      }
      if (parts.length === 0) {
        get().pushToast('Não foi possível sugerir partes para esta música (ou ela é curta demais).', 'error');
        return;
      }
      // Selo de origem: mostra na lista se cada parte veio da locução da guia
      // (confiável) ou só da heurística de áudio (revisar) — ver detectionSource.
      parts = parts.map((p) => ({ ...p, detectionSource: usedSpeech ? 'speech' : 'audio' }));
      get().updateCurrentSong((s) => ({ ...s, parts }), { history: true });
      engine.updateParts(parts);
      get().pushToast(
        usedSpeech
          ? `${parts.length} partes reconhecidas pela locução da faixa guia. Revise antes de tocar ao vivo — use "Mesclar com a próxima" ou "Dividir" pra ajustar rápido.`
          : `${parts.length} partes sugeridas. Revise antes de tocar ao vivo — use "Mesclar com a próxima" ou "Dividir" pra ajustar rápido.`
      );
    } catch (err) {
      console.error(err);
      get().pushToast('Falha ao reconhecer partes.', 'error');
    } finally {
      set({ recognizing: false });
    }
  },

  mergePartWithNext: (partId) => {
    get().updateCurrentSong((s) => {
      const sorted = [...s.parts].sort((a, b) => a.startBar - b.startBar);
      const idx = sorted.findIndex((p) => p.id === partId);
      if (idx < 0 || idx >= sorted.length - 1) return s;
      const current = sorted[idx];
      const next = sorted[idx + 1];
      const merged: SongPart = { ...current, endBar: next.endBar };
      const parts = sorted.filter((p) => p.id !== next.id).map((p) => (p.id === current.id ? merged : p));
      engine.updateParts(parts);
      return { ...s, parts };
    }, { history: true });
    get().pushToast('Partes mescladas.');
  },

  splitPart: (partId) => {
    get().updateCurrentSong((s) => {
      const part = s.parts.find((p) => p.id === partId);
      if (!part) return s;
      const span = part.endBar - part.startBar;
      if (span < 2) return s;
      const mid = part.startBar + Math.round(span / 2);
      const firstHalf: SongPart = { ...part, endBar: mid };
      const secondHalf: SongPart = { ...part, id: newId(), name: `${part.name} (2)`, startBar: mid };
      const parts = s.parts
        .map((p) => (p.id === partId ? firstHalf : p))
        .concat(secondHalf)
        .sort((a, b) => a.startBar - b.startBar);
      engine.updateParts(parts);
      return { ...s, parts };
    }, { history: true });
    get().pushToast('Parte dividida ao meio — ajuste os nomes/limites se precisar.');
  },

  addPart: (part) => {
    get().updateCurrentSong((s) => {
      const parts = [...s.parts, { detectionSource: 'manual' as const, ...part, id: newId() }].sort((a, b) => a.startBar - b.startBar);
      engine.updateParts(parts);
      return { ...s, parts };
    }, { history: true });
  },

  updatePart: (partId, patch) => {
    get().updateCurrentSong((s) => {
      const parts = s.parts.map((p) => (p.id === partId ? { ...p, ...patch } : p)).sort((a, b) => a.startBar - b.startBar);
      engine.updateParts(parts);
      return { ...s, parts };
    }, { history: true });
  },

  deletePart: (partId) => {
    get().updateCurrentSong((s) => {
      const parts = s.parts.filter((p) => p.id !== partId);
      engine.updateParts(parts);
      return { ...s, parts };
    }, { history: true });
  },

  togglePartSelection: (partId) => {
    const current = get().selectedPartIds;
    set({ selectedPartIds: current.includes(partId) ? current.filter((id) => id !== partId) : [...current, partId] });
  },
  selectAllParts: () => {
    const song = get().currentSong;
    set({ selectedPartIds: song ? song.parts.map((p) => p.id) : [] });
  },
  clearPartSelection: () => set({ selectedPartIds: [] }),

  bulkDeleteParts: (partIds) => {
    if (partIds.length === 0) return;
    const ids = new Set(partIds);
    get().updateCurrentSong((s) => {
      const parts = s.parts.filter((p) => !ids.has(p.id));
      engine.updateParts(parts);
      return { ...s, parts };
    }, { history: true });
    set({ selectedPartIds: [] });
    get().pushToast(`${partIds.length} parte(s) excluída(s).`);
  },

  bulkSetPartType: (partIds, type) => {
    if (partIds.length === 0) return;
    const ids = new Set(partIds);
    get().updateCurrentSong((s) => {
      const parts = s.parts.map((p) => (ids.has(p.id) ? { ...p, type } : p));
      engine.updateParts(parts);
      return { ...s, parts };
    }, { history: true });
    get().pushToast(`${partIds.length} parte(s) marcada(s) como "${type}".`);
  },

  snapPartToBeat: (partId) => {
    get().updateCurrentSong((s) => {
      const part = s.parts.find((p) => p.id === partId);
      if (!part) return s;
      // "compasso" aqui é fracionário (1 bar = 1.0): arredonda pro tempo
      // (beat) mais próximo dentro do compasso, usando a fórmula da música —
      // ex. em 4/4, arredonda pro múltiplo de 0.25 de compasso mais perto.
      const beatStep = 1 / Math.max(1, s.timeSignatureNum);
      const snap = (bar: number) => Math.round(bar / beatStep) * beatStep;
      const startBar = snap(part.startBar);
      let endBar = snap(part.endBar);
      if (endBar <= startBar) endBar = startBar + beatStep;
      const parts = s.parts
        .map((p) => (p.id === partId ? { ...p, startBar, endBar } : p))
        .sort((a, b) => a.startBar - b.startBar);
      engine.updateParts(parts);
      return { ...s, parts };
    }, { history: true });
    get().pushToast('Parte encaixada no tempo mais próximo.');
  },

  addArrangement: (name) => {
    const arrangementId = newId();
    get().updateCurrentSong((s) => {
      const arrangement: SongArrangement = { id: arrangementId, name, steps: s.parts.map((p) => ({ partId: p.id, repeat: 1 })) };
      const next = { ...s, arrangements: [...s.arrangements, arrangement], activeArrangementId: arrangement.id };
      engine.updateArrangements(next.arrangements, next.activeArrangementId);
      return next;
    }, { history: true });
    return arrangementId;
  },

  setActiveArrangement: (id) => {
    get().updateCurrentSong((s) => {
      engine.updateArrangements(s.arrangements, id);
      return { ...s, activeArrangementId: id };
    });
  },

  updateArrangementSteps: (arrangementId, steps) => {
    get().updateCurrentSong((s) => {
      const arrangements = s.arrangements.map((a) => (a.id === arrangementId ? { ...a, steps } : a));
      engine.updateArrangements(arrangements, s.activeArrangementId);
      return { ...s, arrangements };
    }, { history: true });
  },

  ensureEditableArrangement: (suggestedName) => {
    const song = get().currentSong;
    if (!song) return '';
    if (song.activeArrangementId) return song.activeArrangementId;
    const id = get().addArrangement(suggestedName);
    get().pushToast(`Nova versão "${suggestedName}" criada a partir da música original.`);
    return id;
  },

  renameArrangement: (arrangementId, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    get().updateCurrentSong((s) => {
      const arrangements = s.arrangements.map((a) => (a.id === arrangementId ? { ...a, name: trimmed } : a));
      return { ...s, arrangements };
    }, { history: true });
  },

  deleteArrangement: (arrangementId) => {
    get().updateCurrentSong((s) => {
      const arrangements = s.arrangements.filter((a) => a.id !== arrangementId);
      const activeArrangementId = s.activeArrangementId === arrangementId ? null : s.activeArrangementId;
      engine.updateArrangements(arrangements, activeArrangementId);
      return { ...s, arrangements, activeArrangementId };
    }, { history: true });
    get().pushToast('Versão excluída. Voltando pra "Original (ordem gravada)" se ela estava em uso.');
  },

  setKey: (key) => {
    engine.setKey(key);
    get().updateCurrentSong((s) => ({ ...s, currentKey: key }));
    if (padEngine.playing) padEngine.changeKey(key, get().settings.pad.keyChangeCrossfadeSec);
  },

  setBpm: (bpm) => {
    engine.setBpm(bpm);
    get().updateCurrentSong((s) => ({ ...s, currentBpm: bpm }));
  },

  setTrackRole: (trackId, role) => {
    get().updateCurrentSong((s) => ({ ...s, tracks: s.tracks.map((t) => (t.id === trackId ? { ...t, role } : t)) }));
  },

  setTrackFollowsKey: (trackId, follow) => {
    engine.setTrackFollowsKey(trackId, follow);
    get().updateCurrentSong((s) => ({ ...s, tracks: s.tracks.map((t) => (t.id === trackId ? { ...t, followsKey: follow } : t)) }));
  },

  setTrackVolumeDb: (trackId, db) => {
    engine.setTrackVolumeDb(trackId, db);
    get().updateCurrentSong((s) => ({ ...s, tracks: s.tracks.map((t) => (t.id === trackId ? { ...t, volumeDb: db } : t)) }));
  },

  setTrackMuted: (trackId, muted) => {
    engine.setTrackMuted(trackId, muted);
    get().updateCurrentSong((s) => ({ ...s, tracks: s.tracks.map((t) => (t.id === trackId ? { ...t, muted } : t)) }));
  },

  setTrackSolo: (trackId, solo) => {
    engine.setTrackSolo(trackId, solo);
    get().updateCurrentSong((s) => ({ ...s, tracks: s.tracks.map((t) => (t.id === trackId ? { ...t, solo } : t)) }));
  },

  setTrackOutput: (trackId, output) => {
    engine.setTrackOutput(trackId, output);
    get().updateCurrentSong((s) => ({ ...s, tracks: s.tracks.map((t) => (t.id === trackId ? { ...t, output } : t)) }));
  },

  setChordChart: (raw, originalKey) => {
    get().updateCurrentSong((s) => ({ ...s, chordChart: { raw, originalKey, capo: 0 } }));
  },

  play: async () => {
    const settings = get().settings;
    if (settings.pad.exitOnPlay) padEngine.stop(settings.pad.fadeInOutSec);
    if (settings.click.countInBars > 0 && !engine.getState().isPlaying) {
      const song = get().currentSong;
      const beats = settings.click.countInBars * (song?.timeSignatureNum ?? 4);
      await engine.playCountIn(beats, song?.currentBpm ?? 120, () => {}, settings.click);
    }
    await engine.play();
  },
  pause: async () => engine.pause(),
  stop: async () => engine.stop(),
  jumpToPart: (partId) => {
    const song = get().currentSong;
    const behavior = get().settings.guideVoice.outOfOrderBehavior;
    let guideAnnounce: { behavior: 'mute' | 'mute-and-announce' } | undefined;
    if (song && behavior !== 'keep') {
      const curIdx = song.parts.findIndex((p) => p.id === get().engineState.activePartId);
      const targetIdx = song.parts.findIndex((p) => p.id === partId);
      const isSequential = curIdx >= 0 && targetIdx === curIdx + 1;
      if (!isSequential && targetIdx >= 0) guideAnnounce = { behavior };
    }
    engine.jumpToPart(partId, engine.getState().isPlaying, guideAnnounce);
  },
  jumpRelative: (dir) => {
    const song = get().currentSong;
    if (!song) return;
    const idx = song.parts.findIndex((p) => p.id === get().engineState.activePartId);
    const nextIdx = Math.min(song.parts.length - 1, Math.max(0, (idx < 0 ? 0 : idx) + dir));
    const part = song.parts[nextIdx];
    if (part) engine.jumpToPart(part.id, engine.getState().isPlaying);
  },
  toggleLoopActivePart: () => engine.setLoopActivePart(!get().engineState.loopActivePart),
  setPracticeLoop: (startBar, endBar) => engine.setPracticeLoop(startBar, endBar),
  clearPracticeLoop: () => engine.clearPracticeLoop(),

  updateSettings: async (patch) => {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    await window.api.store.saveSettings(settings);
    if (patch.outputDeviceId !== undefined) await engine.setOutputDevice(patch.outputDeviceId);
    if (patch.pad) {
      padEngine.setOutput(settings.pad.output);
      padEngine.setBreatheSeconds(settings.pad.loopCrossfadeSec);
    }
  },

  updateRack: (patch) => {
    const rack = { ...get().settings.rack, ...patch };
    get().updateSettings({ rack });
  },
  updateRackLayer: (index, patch) => {
    const layers = get().settings.rack.layers.map((l, i) => (i === index ? { ...l, ...patch } : l));
    get().updateRack({ layers });
  },

  addMidiBinding: (binding) => {
    const settings = { ...get().settings, midiBindings: [...get().settings.midiBindings, binding] };
    get().updateSettings(settings);
  },
  removeMidiBinding: (predicate) => {
    const settings = { ...get().settings, midiBindings: get().settings.midiBindings.filter((b) => !predicate(b)) };
    get().updateSettings(settings);
  },

  addScene: (name) => {
    const scene: Scene = { id: newId(), name, items: [] };
    const library = { ...get().library, scenes: [...get().library.scenes, scene] };
    set({ library });
    scheduleSave(library);
  },
  updateScene: (sceneId, patch) => {
    const library = { ...get().library, scenes: get().library.scenes.map((s) => (s.id === sceneId ? { ...s, ...patch } : s)) };
    set({ library });
    scheduleSave(library);
  },
  deleteScene: (sceneId) => {
    const library = { ...get().library, scenes: get().library.scenes.filter((s) => s.id !== sceneId) };
    set({ library });
    scheduleSave(library);
  },
  importScene: (scene) => {
    // gera um id novo pra não colidir com nenhuma cena já existente (ex.: a mesma
    // cena importada 2x, ou importada no mesmo app em que foi exportada)
    const songIds = new Set(get().library.songs.map((s) => s.id));
    const validItems = scene.items.filter((it) => songIds.has(it.songId));
    const skipped = scene.items.length - validItems.length;
    const imported: Scene = { id: newId(), name: scene.name, items: validItems };
    const library = { ...get().library, scenes: [...get().library.scenes, imported] };
    set({ library });
    scheduleSave(library);
    get().pushToast(
      skipped > 0
        ? `Cena "${imported.name}" importada. ${skipped} música(s) da cena não foram encontradas nesta biblioteca e foram ignoradas.`
        : `Cena "${imported.name}" importada com ${imported.items.length} música(s).`,
      skipped > 0 ? 'error' : 'info'
    );
  },

  saveArrangementTemplate: (name) => {
    const trimmed = name.trim();
    const song = get().currentSong;
    if (!trimmed || !song) return;
    const active = song.arrangements.find((a) => a.id === song.activeArrangementId);
    const sourceSteps: SongArrangement['steps'] =
      active?.steps ?? [...song.parts].sort((a, b) => a.startBar - b.startBar).map((p) => ({ partId: p.id, repeat: 1 as const }));
    const partsById = new Map(song.parts.map((p) => [p.id, p]));
    const steps = sourceSteps
      .map((st) => ({ part: partsById.get(st.partId), repeat: st.repeat }))
      .filter((x): x is { part: SongPart; repeat: number | 'infinite' } => !!x.part)
      .map((x) => ({ type: x.part.type, repeat: x.repeat }));
    if (steps.length === 0) {
      get().pushToast('Esta versão não tem partes suficientes pra virar um modelo.', 'error');
      return;
    }
    const template: ArrangementTemplate = { id: newId(), name: trimmed, steps };
    const library = { ...get().library, arrangementTemplates: [...(get().library.arrangementTemplates ?? []), template] };
    set({ library });
    scheduleSave(library);
    get().pushToast(`Modelo "${trimmed}" salvo com ${steps.length} passo(s) — aplique em qualquer música pela lista de modelos.`);
  },

  applyArrangementTemplate: (templateId) => {
    const song = get().currentSong;
    const template = get().library.arrangementTemplates?.find((t) => t.id === templateId);
    if (!song || !template) return;
    const byType = new Map<PartType, SongPart[]>();
    for (const p of [...song.parts].sort((a, b) => a.startBar - b.startBar)) {
      const arr = byType.get(p.type) ?? [];
      arr.push(p);
      byType.set(p.type, arr);
    }
    const cursor = new Map<PartType, number>();
    const steps: SongArrangement['steps'] = [];
    let skipped = 0;
    for (const step of template.steps) {
      const options = byType.get(step.type) ?? [];
      if (options.length === 0) {
        skipped++;
        continue;
      }
      const i = cursor.get(step.type) ?? 0;
      const part = options[Math.min(i, options.length - 1)];
      cursor.set(step.type, i + 1);
      steps.push({ partId: part.id, repeat: step.repeat });
    }
    if (steps.length === 0) {
      get().pushToast('Nenhuma parte desta música combina com os tipos do modelo escolhido.', 'error');
      return;
    }
    const id = get().addArrangement(`${template.name} (modelo)`);
    get().updateArrangementSteps(id, steps);
    get().pushToast(
      skipped > 0
        ? `Modelo aplicado como nova versão "${template.name} (modelo)". ${skipped} passo(s) ignorado(s) — esta música não tem parte desse tipo.`
        : `Modelo "${template.name}" aplicado como nova versão.`
    );
  },

  deleteArrangementTemplate: (templateId) => {
    const library = {
      ...get().library,
      arrangementTemplates: (get().library.arrangementTemplates ?? []).filter((t) => t.id !== templateId),
    };
    set({ library });
    scheduleSave(library);
  },

  /** Liga/desliga o pad contínuo no tom da música atual — ação única usada pelo
   *  botão na tela, pelo atalho de teclado e pelo binding de MIDI, pra não ter
   *  3 lógicas divergentes de ligar/desligar o pad. */
  togglePad: () => {
    const song = get().currentSong;
    if (!song) return;
    const settings = get().settings;
    if (padEngine.playing) {
      padEngine.stop(settings.pad.fadeInOutSec);
    } else {
      padEngine.setOutput(settings.pad.output);
      padEngine.setBreatheSeconds(settings.pad.loopCrossfadeSec);
      padEngine.setVolumeDb(settings.pad.volumeDb);
      padEngine.start(song.currentKey, settings.pad.fadeInOutSec);
    }
    set({ padActive: padEngine.playing });
  },

  clearPlayLog: () => set({ playLog: [] }),

  setActiveSceneId: (id) => set({ activeSceneId: id }),

  toggleFavorite: (songId) => {
    const library = {
      ...get().library,
      songs: get().library.songs.map((s) => (s.id === songId ? { ...s, favorite: !s.favorite } : s)),
    };
    set({ library, currentSong: get().currentSong?.id === songId ? { ...get().currentSong!, favorite: !get().currentSong!.favorite } : get().currentSong });
    scheduleSave(library);
  },

  updateSongNotes: (songId, notes) => {
    if (get().currentSong?.id === songId) {
      get().updateCurrentSong((s) => ({ ...s, notes }));
      return;
    }
    const library = { ...get().library, songs: get().library.songs.map((s) => (s.id === songId ? { ...s, notes } : s)) };
    set({ library });
    scheduleSave(library);
  },

  deletePartsFromArrangement: (partIds, suggestedName) => {
    const song = get().currentSong;
    if (!song || partIds.length === 0) return;
    const idSet = new Set(partIds);
    const arrangementId = get().ensureEditableArrangement(suggestedName);
    if (!arrangementId) return;
    const arrangement = get().currentSong?.arrangements.find((a) => a.id === arrangementId);
    const baseSteps = arrangement?.steps ?? song.parts.map((p) => ({ partId: p.id, repeat: 1 as number | 'infinite' }));
    const nextSteps = baseSteps.filter((step) => !idSet.has(step.partId));
    if (nextSteps.length === baseSteps.length) {
      get().pushToast('O trecho selecionado não corresponde a nenhuma parte do roteiro atual.', 'error');
      return;
    }
    get().updateArrangementSteps(arrangementId, nextSteps);
    get().pushToast(`Trecho removido desta versão (${baseSteps.length - nextSteps.length} parte(s)).`);
  },
}));
