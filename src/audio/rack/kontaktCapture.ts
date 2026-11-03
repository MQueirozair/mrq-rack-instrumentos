/**
 * "Kontakt Audio Capture" — fluxo OPCIONAL do MRQ Instrument Converter pra
 * transformar instrumentos Kontakt que não podem ser abertos diretamente
 * (`.nki` criptografado/biblioteca comercial — ver `nkiImport.ts`, que já
 * detecta e explica esse caso) num instrumento `.mrq` a partir de arquivos
 * WAV/AIFF/FLAC já RENDERIZADOS pelo próprio Kontakt, por um usuário com
 * acesso legítimo ao instrumento original.
 *
 * Isto NÃO é um segundo conversor: reaproveita o MESMO pipeline `.mrq`
 * genérico que todo importador já usa por baixo
 * (`mrqBuilderBegin`/`mrqBuilderFinish`/`mrqBuilderAbort`, Fase 2 — mesmo
 * padrão de orquestração frontend que `syxImport.ts` já usa pro DX7), só
 * que a amostra em si é decodificada e anexada no Rust por CAMINHO de
 * arquivo (`mrqCaptureAddSample`, que reaproveita o mesmo decodificador
 * `symphonia` de `audio_file.rs`) em vez de ir por PCM bruto — assim nenhum
 * áudio grande atravessa a ponte do WebView como JSON, nos dois sentidos.
 *
 * Duas responsabilidades claramente separadas, igual ao resto do
 * conversor (lógica decoupled de UI — ver docs/mrq-instrument-converter/mrq-converter-architecture.md):
 *  - Heurística de nome de arquivo (`parseCapturedFileName`) e montagem
 *    automática de faixa de velocidade/round-robin (`computeAutoMapping`):
 *    puras, sem I/O, fáceis de testar isoladas (scripts/test-kontakt-capture.mjs).
 *  - Orquestração real (`runKontaktCapture`): chama os comandos Tauri.
 *
 * Nenhum dado é inventado: tudo que a heurística não reconhecer fica como
 * valor padrão explícito (raiz C3/teclado e velocidade inteiros), nunca um
 * "palpite" escondido — a tela (`KontaktCaptureDialog.tsx`) sempre deixa
 * claro o que foi detectado automaticamente e o que precisa de ajuste
 * manual, e o relatório de compatibilidade gerado documenta honestamente
 * os limites deste fluxo (nenhuma estrutura interna do Kontakt original —
 * scripts KSP, efeitos, modulações — é ou pode ser recuperada a partir do
 * áudio renderizado).
 */

import { invoke } from '@tauri-apps/api/core';
import { noteNameToMidi } from './midiNoteNames';
import {
  mrqBuilderAbort,
  mrqBuilderBegin,
  mrqBuilderFinish,
  type MrqCompatibilityReport,
  type MrqFinishResult,
  type MrqGroup,
  type MrqInstrumentModel,
  type MrqSampleIndexEntry,
  type MrqStereoMode,
  type MrqZone,
} from './mrqFormat';

// ---------------------------------------------------------------------------
// Wrappers de invoke — espelham src-tauri/src/importers/kontakt_capture.rs
// (comandos `mrq_capture_probe_audio_file`/`mrq_capture_add_sample`,
// registrados em commands.rs/lib.rs).
// ---------------------------------------------------------------------------

export interface CaptureFileProbe {
  durationSeconds: number;
  sampleRateHz: number;
  channels: number;
  bitsPerSampleOriginal?: number;
  /** SHA-256 do PCM decodificado — só pra detecção de duplicados na UI. */
  contentSha256: string;
}

/** Sonda metadados de UM arquivo de áudio (duração/taxa/canais/bits/hash),
 *  sem gravar nada em disco — alimenta a grade de mapeamento antes do
 *  usuário confirmar qualquer coisa. */
export function mrqCaptureProbeAudioFile(path: string): Promise<CaptureFileProbe> {
  return invoke('mrq_capture_probe_audio_file', { path });
}

/** Decodifica e anexa UMA amostra a uma sessão `.mrq` já aberta via
 *  `mrqBuilderBegin`. `sampleId` precisa bater com o `sampleId` usado nas
 *  zonas do `MrqInstrumentModel` passado pra `begin`. */
export function mrqCaptureAddSample(sessionId: string, sampleId: string, path: string): Promise<MrqSampleIndexEntry> {
  return invoke('mrq_capture_add_sample', { sessionId, sampleId, path });
}

// ---------------------------------------------------------------------------
// Heurística de nome de arquivo — best effort, documentada, nunca um
// "palpite" silencioso: tudo que não reconhece vira `null`, e quem chama
// decide o valor padrão (sempre explícito na UI).
// ---------------------------------------------------------------------------

export interface ParsedFileNameHints {
  rootNote: number | null;
  velocity: number | null;
  roundRobinTag: string | null;
  articulation: string | null;
}

const VELOCITY_PREFIX = /^(?:vel|velocity|v)-?(\d{1,3})$/i;
const VELOCITY_SUFFIX = /^(\d{1,3})-?(?:vel|velocity)$/i;
const ROUND_ROBIN_TOKEN = /^(?:rr|roundrobin|round-robin)-?(\d{1,2})$/i;
const NOTE_NUMBER_TOKEN = /^(?:key|note|midi|n|k)-?(\d{1,3})$/i;

/** Palavras comuns de articulação/camada em bibliotecas de amostra — usado
 *  só pra SUGERIR um nome de grupo/camada (o usuário sempre pode trocar),
 *  nunca pra decidir mapeamento de nota/tecla/velocidade. */
const ARTICULATION_KEYWORDS = [
  'sustain', 'sus', 'staccato', 'stacc', 'pizzicato', 'pizz', 'legato', 'leg',
  'tremolo', 'trem', 'marcato', 'spiccato', 'harmonics', 'harm', 'mute', 'muted',
  'open', 'closed', 'close', 'pedal', 'ped', 'vibrato', 'vib', 'bow', 'arco',
];

function isValidMidi(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= 127;
}

/** Reconhece nota (nome tipo "C3"/"Db4" ou número explícito "key060"),
 *  velocidade ("vel127"/"v064"), tag de round robin ("rr1") e uma palavra
 *  de articulação conhecida, a partir do NOME do arquivo (sem a extensão).
 *  Cada token do nome (separado por `_`/`-`/espaço/`.`) é testado uma vez
 *  pra cada categoria ainda não preenchida — o primeiro match válido
 *  vence; nada impede o usuário de corrigir manualmente depois. */
export function parseCapturedFileName(fileName: string): ParsedFileNameHints {
  const base = fileName.replace(/\.[^./\\]+$/, '');
  const tokens = base.split(/[_\-\s.]+/).filter(Boolean);

  let rootNote: number | null = null;
  let velocity: number | null = null;
  let roundRobinTag: string | null = null;
  let articulation: string | null = null;

  for (const token of tokens) {
    if (rootNote === null) {
      const byName = noteNameToMidi(token);
      if (byName !== null) {
        rootNote = byName;
        continue;
      }
      const byNumber = NOTE_NUMBER_TOKEN.exec(token);
      if (byNumber) {
        const n = Number(byNumber[1]);
        if (isValidMidi(n)) {
          rootNote = n;
          continue;
        }
      }
    }
    if (velocity === null) {
      const m = VELOCITY_PREFIX.exec(token) ?? VELOCITY_SUFFIX.exec(token);
      if (m) {
        const v = Number(m[1]);
        if (isValidMidi(v)) {
          velocity = v;
          continue;
        }
      }
    }
    if (roundRobinTag === null) {
      const m = ROUND_ROBIN_TOKEN.exec(token);
      if (m) {
        roundRobinTag = m[1];
        continue;
      }
    }
    if (articulation === null && ARTICULATION_KEYWORDS.includes(token.toLowerCase())) {
      articulation = token.toLowerCase();
    }
  }

  // Fallback de round robin: sufixo de uma letra só (a/b/c) no fim do nome,
  // depois de nota/velocidade/articulação já não terem consumido o token —
  // convenção comum em bibliotecas ("Piano_C3_v100_a.wav").
  if (roundRobinTag === null && tokens.length > 1) {
    const last = tokens[tokens.length - 1];
    if (/^[a-c]$/i.test(last)) roundRobinTag = last.toLowerCase();
  }

  return { rootNote, velocity, roundRobinTag, articulation };
}

// ---------------------------------------------------------------------------
// Mapeamento automático de faixa de velocidade + round robin — agrupa por
// nota raiz, depois por velocidade idêntica (candidatos a round robin da
// MESMA camada), e distribui o espaço 0-127 em faixas contíguas sem
// sobreposição entre velocidades distintas da mesma nota.
// ---------------------------------------------------------------------------

export interface AutoMapInput {
  id: string;
  /** Escopo do agrupamento — layers/grupos diferentes (ex.: "Sustain" vs
   *  "Staccato") nunca compartilham faixa nem round robin entre si, mesmo
   *  quando caem na mesma nota/velocidade. */
  group: string;
  rootNote: number;
  /** `null` quando a heurística de nome de arquivo não detectou
   *  velocidade nenhuma pra esta amostra — fica de fora do cálculo
   *  automático (mapeamento manual, faixa padrão 0-127). */
  velocity: number | null;
}

export interface AutoMapResult {
  loVel: number;
  hiVel: number;
  roundRobinGroup?: string;
  roundRobinIndex?: number;
}

export function computeAutoVelocityAndRoundRobin(entries: AutoMapInput[]): Map<string, AutoMapResult> {
  const byGroupNote = new Map<string, AutoMapInput[]>();
  for (const e of entries) {
    if (e.velocity === null) continue;
    const key = `${e.group}\u0000${e.rootNote}`;
    const list = byGroupNote.get(key) ?? [];
    list.push(e);
    byGroupNote.set(key, list);
  }

  const result = new Map<string, AutoMapResult>();
  for (const [key, list] of byGroupNote) {
    const byVelocity = new Map<number, AutoMapInput[]>();
    for (const e of list) {
      const v = e.velocity as number;
      const arr = byVelocity.get(v) ?? [];
      arr.push(e);
      byVelocity.set(v, arr);
    }
    const uniqueVelocities = [...byVelocity.keys()].sort((a, b) => a - b);
    uniqueVelocities.forEach((velocity, i) => {
      const lo = i === 0 ? 0 : Math.round((uniqueVelocities[i - 1] + velocity) / 2) + 1;
      const hi = i === uniqueVelocities.length - 1 ? 127 : Math.round((velocity + uniqueVelocities[i + 1]) / 2);
      const loVel = Math.max(0, Math.min(lo, hi));
      const hiVel = Math.min(127, Math.max(lo, hi));
      const cluster = byVelocity.get(velocity) ?? [];
      const roundRobinGroup = cluster.length > 1 ? `rr-${key}-${velocity}` : undefined;
      cluster.forEach((entry, idx) => {
        result.set(entry.id, { loVel, hiVel, roundRobinGroup, roundRobinIndex: roundRobinGroup ? idx : undefined });
      });
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Faixa de teclado automática — mesma ideia da faixa de velocity acima, mas
// por GRUPO (cada grupo/camada cobre o teclado de forma independente):
// ordena as notas raiz conhecidas de um grupo e distribui faixas contíguas
// de tecla (0-127) nos pontos médios entre notas vizinhas.
// ---------------------------------------------------------------------------

export interface AutoKeyRangeInput {
  id: string;
  group: string;
  rootNote: number;
}

export interface AutoKeyRangeResult {
  loKey: number;
  hiKey: number;
}

export function computeAutoKeyRanges(entries: AutoKeyRangeInput[]): Map<string, AutoKeyRangeResult> {
  const byGroup = new Map<string, AutoKeyRangeInput[]>();
  for (const e of entries) {
    const list = byGroup.get(e.group) ?? [];
    list.push(e);
    byGroup.set(e.group, list);
  }

  const result = new Map<string, AutoKeyRangeResult>();
  for (const list of byGroup.values()) {
    // Notas raiz repetidas no mesmo grupo (ex.: round robin) compartilham a
    // mesma faixa de tecla — agrupa primeiro por nota, igual à velocidade.
    const byNote = new Map<number, AutoKeyRangeInput[]>();
    for (const e of list) {
      const arr = byNote.get(e.rootNote) ?? [];
      arr.push(e);
      byNote.set(e.rootNote, arr);
    }
    const uniqueNotes = [...byNote.keys()].sort((a, b) => a - b);
    uniqueNotes.forEach((note, i) => {
      const lo = i === 0 ? 0 : Math.round((uniqueNotes[i - 1] + note) / 2) + 1;
      const hi = i === uniqueNotes.length - 1 ? 127 : Math.round((note + uniqueNotes[i + 1]) / 2);
      const loKey = Math.max(0, Math.min(lo, hi));
      const hiKey = Math.min(127, Math.max(lo, hi));
      for (const entry of byNote.get(note) ?? []) {
        result.set(entry.id, { loKey, hiKey });
      }
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Detecção de duplicados — comparação pura por hash de conteúdo (já
// calculado pelo backend em `probe()`), sem reabrir nenhum arquivo.
// ---------------------------------------------------------------------------

export function findDuplicateGroups(entries: { id: string; hash: string }[]): string[][] {
  const byHash = new Map<string, string[]>();
  for (const e of entries) {
    const arr = byHash.get(e.hash) ?? [];
    arr.push(e.id);
    byHash.set(e.hash, arr);
  }
  return [...byHash.values()].filter((ids) => ids.length > 1);
}

// ---------------------------------------------------------------------------
// Montagem do MrqInstrumentModel + relatório de compatibilidade a partir do
// mapeamento confirmado pelo usuário.
// ---------------------------------------------------------------------------

export interface CaptureZoneInput {
  /** Precisa bater com o id usado em `runKontaktCapture`/`mrqCaptureAddSample`. */
  sampleId: string;
  /** Nome do grupo/camada escolhido pelo usuário (vira um `MrqGroup`). */
  group: string;
  rootNote: number;
  loKey: number;
  hiKey: number;
  loVel: number;
  hiVel: number;
  roundRobinGroup?: string;
  roundRobinIndex?: number;
  /** Ver `MrqZone.exclusiveGroup` — opcional, definido manualmente pelo
   *  usuário quando quiser (ex.: hi-hat aberto/fechado renderizados como
   *  WAVs separados). */
  exclusiveGroup?: number;
  stereo?: MrqStereoMode;
}

export interface BuiltCapture {
  instrument: MrqInstrumentModel;
  compatibility: MrqCompatibilityReport;
}

export function buildCaptureInstrumentModel(instrumentName: string, zones: CaptureZoneInput[]): BuiltCapture {
  if (zones.length === 0) {
    throw new Error('nenhuma amostra mapeada — adicione pelo menos um arquivo de áudio antes de gerar o instrumento.');
  }

  const groupOrder: string[] = [];
  const groupedZones = new Map<string, MrqZone[]>();
  for (const z of zones) {
    if (!groupedZones.has(z.group)) {
      groupedZones.set(z.group, []);
      groupOrder.push(z.group);
    }
    groupedZones.get(z.group)!.push({
      sampleId: z.sampleId,
      rootNote: z.rootNote,
      loKey: z.loKey,
      hiKey: z.hiKey,
      loVel: z.loVel,
      hiVel: z.hiVel,
      roundRobinGroup: z.roundRobinGroup,
      roundRobinIndex: z.roundRobinIndex,
      tuneCents: 0,
      volumeDb: 0,
      pan: 0,
      stereo: z.stereo,
      exclusiveGroup: z.exclusiveGroup,
    });
  }

  const groups: MrqGroup[] = groupOrder.map((name, i) => ({
    id: `group-${i}`,
    name,
    zones: groupedZones.get(name) ?? [],
  }));

  const instrument: MrqInstrumentModel = {
    name: instrumentName,
    sourceFormat: 'kontakt-capture',
    importedAt: new Date().toISOString(),
    presets: [{ id: 'preset-0', name: instrumentName, groups }],
  };

  const compatibility: MrqCompatibilityReport = { preserved: [], approximated: [], unsupported: [] };

  compatibility.preserved.push({
    field: 'Áudio',
    detail:
      'cada arquivo capturado foi decodificado pelo mesmo importador de áudio avulso do conversor (symphonia, no backend Rust) e recodificado em FLAC lossless dentro do .mrq — sample rate, contagem de canais e profundidade de bits originais preservados exatamente como no arquivo renderizado.',
  });
  compatibility.approximated.push({
    field: 'Nota raiz / faixa de teclado / faixa de velocidade',
    detail:
      'detectadas por heurística de nome de arquivo (quando reconhecível) ou definidas manualmente pelo usuário no Kontakt Audio Capture — não são um dado extraído do instrumento Kontakt original, que este fluxo nunca abre.',
  });
  compatibility.approximated.push({
    field: 'Grupos/camadas',
    detail:
      'agrupamento definido manualmente pelo usuário durante a captura — reflete como ele organizou os arquivos renderizados, não a estrutura real de grupos/articulações do patch Kontakt original.',
  });
  if (zones.some((z) => z.roundRobinGroup)) {
    compatibility.approximated.push({
      field: 'Round robin',
      detail:
        'atribuído quando várias amostras caem na mesma nota+velocidade (ou ajustado manualmente) — alterna de verdade na reprodução (o Rack já suporta round robin em camadas .mrq), mas a ordem/variação real do instrumento Kontakt original não é conhecida, só a ordem dos arquivos capturados.',
    });
  }
  if (zones.some((z) => z.exclusiveGroup !== undefined)) {
    compatibility.approximated.push({
      field: 'Grupo de exclusividade',
      detail:
        'definido manualmente pelo usuário nesta captura; preservado como dado no .mrq, mas o Rack ainda não corta automaticamente vozes do mesmo grupo — mesma limitação já documentada para a importação SF2/SF3.',
    });
  }
  compatibility.unsupported.push({
    field: 'Scripts KSP, efeitos/DSP e modulações internas do Kontakt',
    detail:
      'este fluxo captura só o áudio já renderizado — nenhum comportamento de script, efeito proprietário, modulação ou envelope do instrumento Kontakt original é recuperado ou pode ser inferido a partir do áudio.',
  });
  compatibility.unsupported.push({
    field: 'Pontos de loop',
    detail:
      'não extraídos dos arquivos capturados por este fluxo (mesmo que o WAV de origem carregue um chunk "smpl" com esses pontos) — toda amostra capturada é tratada como one-shot nesta versão.',
  });
  compatibility.unsupported.push({
    field: 'Estrutura original de presets/grupos/articulações do Kontakt',
    detail:
      'o instrumento Kontakt original nunca é aberto por este fluxo (ele só é usado, fora do MRQ, pra renderizar o áudio) — os grupos criados aqui são só os buckets que o usuário escolheu durante a captura.',
  });

  return { instrument, compatibility };
}

// ---------------------------------------------------------------------------
// Orquestração real — mesmo padrão begin/add-em-loop/finish (com abort em
// caso de erro) já usado por `syxImport.ts` pro DX7, só que cada "add" aqui
// decodifica no Rust por caminho de arquivo (`mrqCaptureAddSample`) em vez
// de mandar PCM já decodificado em JS.
// ---------------------------------------------------------------------------

export interface CaptureSampleTask {
  sampleId: string;
  path: string;
}

export async function runKontaktCapture(
  destPath: string,
  instrument: MrqInstrumentModel,
  tasks: CaptureSampleTask[],
  onProgress?: (done: number, total: number) => void
): Promise<{ finish: MrqFinishResult }> {
  if (tasks.length === 0) {
    throw new Error('nenhum arquivo pra gravar — adicione pelo menos uma amostra antes de confirmar.');
  }
  const sessionId = await mrqBuilderBegin(destPath, instrument);
  let done = 0;
  try {
    for (const task of tasks) {
      await mrqCaptureAddSample(sessionId, task.sampleId, task.path);
      done += 1;
      onProgress?.(done, tasks.length);
    }
  } catch (err) {
    await mrqBuilderAbort(sessionId).catch(() => {
      /* já estamos no caminho de erro — não deixa uma falha no abort
         esconder o erro original. */
    });
    throw err;
  }
  const finish = await mrqBuilderFinish(sessionId);
  return { finish };
}
