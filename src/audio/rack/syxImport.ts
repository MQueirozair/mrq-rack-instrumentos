/**
 * Importador de bancos/vozes DX7 (.syx) — Fase 5 do MRQ Instrument Converter
 * (ver docs/mrq-instrument-converter/mrq-converter-architecture.md §8). Ao contrário dos importadores
 * SF2/SF3 (Fase 3) e NPNO/NSMP (Fase 4), que são 100% Rust (o arquivo de
 * origem já contém áudio PCM pronto), um .syx não contém nenhum áudio — só
 * parâmetros de síntese FM. Preservar o som exige *renderizar* notas com o
 * motor FM de verdade, o que só existe em JavaScript (@audio/synth-dx7, um
 * porte bit-exato da MSFA do Google); por isso esta fase roda inteira no
 * lado TS/WebView, sem nenhuma mudança no backend Rust — o resultado final
 * (amostras Float32 + modelo de instrumento) é só entregue aos wrappers já
 * existentes da Fase 2 (`mrqBuilderBegin`/`mrqBuilderAddSample`/
 * `mrqBuilderFinish` em mrqFormat.ts), que fazem a codificação FLAC e a
 * escrita do .mrq em Rust como sempre.
 *
 * Duas metades bem separadas, de propósito:
 *  - PARSING (`parse` de @audio/synth-dx7, via sysex.js): não usa BigInt,
 *    entra no bundle principal normalmente. Sempre disponível.
 *  - RENDER (dx7.js, usa BigInt pra tabela de seno bit-exata): não cabe no
 *    alvo es2019 do bundle principal (ver comentário em
 *    offline-src/Dx7OfflineRender.ts e scripts/build-rack-worklets.cjs).
 *    Carregado sob demanda via `import()` dinâmico de um artefato
 *    pré-compilado; `isDx7RenderSupported()` detecta ANTES se o navegador
 *    tem o recurso (BigInt, Safari 14.1+/equivalente) pra não tentar em
 *    vão em WebKit mais antigo (ex.: macOS 10.15/Catalina).
 */

import { parse } from '@audio/synth-dx7';
import type { Dx7OfflineRenderRequest } from './offline-src/Dx7OfflineRender';
import {
  mrqBuilderAbort,
  mrqBuilderAddSample,
  mrqBuilderBegin,
  mrqBuilderFinish,
  type MrqCompatibilityReport,
  type MrqFinishResult,
  type MrqInstrumentModel,
  type MrqPreset,
} from './mrqFormat';

// ---------------------------------------------------------------------------
// Parsing (sempre disponível, sem BigInt)
// ---------------------------------------------------------------------------

export interface SyxVoiceInfo {
  index: number;
  name: string;
}

/** Lê os nomes/vozes de um .syx (cartucho de 32 vozes VMEM, voz única VCED,
 *  ou dados sem cabeçalho) — rápido, sem renderizar nenhum áudio. */
export function parseSyxVoices(bytes: Uint8Array): SyxVoiceInfo[] {
  return parse(bytes).map((v, index) => ({ index, name: v.name || `Voz ${index + 1}` }));
}

/** `true` se o ambiente consegue carregar o artefato de render (precisa de
 *  BigInt, Safari 14.1+/WebKit equivalente — a mesma exigência que a
 *  reprodução ao vivo de DX7 já tem via AudioWorklet, não uma nova). */
export function isDx7RenderSupported(): boolean {
  return typeof BigInt !== 'undefined';
}

// ---------------------------------------------------------------------------
// Render (sob demanda, artefato separado)
// ---------------------------------------------------------------------------

const DX7_OFFLINE_RENDER_RELATIVE_URL = './vendor/dx7-offline/dx7-offline-render.js';

interface Dx7OfflineRenderModule {
  renderDx7Note(req: Dx7OfflineRenderRequest): Float32Array;
}

let offlineModulePromise: Promise<Dx7OfflineRenderModule> | null = null;

function resolveVendorUrl(relative: string): string {
  // import() dinâmico resolve especificador relativo contra a URL do módulo
  // que chama (este arquivo, dentro do bundle principal), não contra
  // document.baseURI — diferente de addModule()/<script src>, que usam a
  // base do documento (ver Dx7LayerVoice.ts/Sf2LayerVoice.ts). Por isso a
  // URL é montada na mão aqui, senão resolveria um nível errado quando o
  // bundle principal está em dist/assets/.
  return new URL(relative, document.baseURI).href;
}

function loadOfflineRenderModule(): Promise<Dx7OfflineRenderModule> {
  if (!offlineModulePromise) {
    const url = resolveVendorUrl(DX7_OFFLINE_RENDER_RELATIVE_URL);
    offlineModulePromise = import(/* @vite-ignore */ url) as Promise<Dx7OfflineRenderModule>;
  }
  return offlineModulePromise;
}

// ---------------------------------------------------------------------------
// Estratégia de amostragem — "N notas representativas" (ver arquitetura §8)
// ---------------------------------------------------------------------------

export interface SyxRenderOptions {
  /** Distância em semitons entre notas renderizadas (default 7 — uma
   *  quinta justa; ~19-20 notas cobrindo 0-127). Render em si é muito
   *  barato (fator tempo-real ~6-7·10⁻⁴ por voz, ver README do
   *  @audio/synth-dx7) — o que limita a densidade na prática é o tamanho
   *  final do .mrq, não o tempo de conversão. */
  noteStepSemitones?: number;
  /** Velocidade MIDI usada pra renderizar cada nota (default 100). Uma só
   *  velocidade por nota — o DX7 muda timbre (não só volume) com
   *  velocity via FM, o que não é recriado; ver relatório de
   *  compatibilidade. */
  velocity?: number;
  /** Segundos com a tecla pressionada antes de soltar (default 1). */
  durationSeconds?: number;
  /** Segundos de cauda depois de soltar a tecla (default 2). Fixo (não
   *  "até silêncio") pra manter o tamanho do arquivo previsível mesmo em
   *  patches com release muito longo (pad/strings). */
  releaseSeconds?: number;
  /** Taxa de amostragem do render (default 44100). */
  sampleRateHz?: number;
  /** Notificado a cada amostra renderizada/gravada, pra barra de progresso. */
  onProgress?: (done: number, total: number) => void;
}

const DEFAULT_OPTIONS: Required<Omit<SyxRenderOptions, 'onProgress'>> = {
  noteStepSemitones: 7,
  velocity: 100,
  durationSeconds: 1,
  releaseSeconds: 2,
  sampleRateHz: 44100,
};

/** Notas MIDI representativas, cobrindo 0-127 sem deixar a última de fora. */
function representativeNotes(stepSemitones: number): number[] {
  const step = Math.max(1, Math.round(stepSemitones));
  const notes: number[] = [];
  for (let n = 0; n <= 127; n += step) notes.push(n);
  if (notes[notes.length - 1] !== 127) notes.push(127);
  return notes;
}

/** Faixas de tecla contíguas, cortadas no meio do caminho entre notas
 *  vizinhas — sem buraco, sem sobreposição, cobrindo 0-127 inteiro. */
function keyRangesFor(notes: number[]): Array<{ loKey: number; hiKey: number }> {
  return notes.map((note, i) => ({
    loKey: i === 0 ? 0 : Math.floor((notes[i - 1] + note) / 2) + 1,
    hiKey: i === notes.length - 1 ? 127 : Math.floor((note + notes[i + 1]) / 2),
  }));
}

function sampleIdFor(voiceIndex: number, note: number): string {
  return `dx7-v${voiceIndex}-n${note}`;
}

function buildInstrumentModel(
  name: string,
  voices: { index: number; name: string }[],
  notes: number[]
): MrqInstrumentModel {
  const ranges = keyRangesFor(notes);
  const presets: MrqPreset[] = voices.map((voice) => ({
    id: `dx7-voice-${voice.index}`,
    name: voice.name,
    groups: [
      {
        id: `dx7-voice-${voice.index}-group`,
        name: voice.name,
        zones: notes.map((note, i) => ({
          sampleId: sampleIdFor(voice.index, note),
          rootNote: note,
          loKey: ranges[i].loKey,
          hiKey: ranges[i].hiKey,
          loVel: 0,
          hiVel: 127,
          tuneCents: 0,
          volumeDb: 0,
          pan: 0,
          stereo: 'mono' as const,
        })),
      },
    ],
  }));
  return {
    name,
    sourceFormat: 'syx-dx7',
    importedAt: new Date().toISOString(),
    presets,
  };
}

function buildCompatibilityReport(stepSemitones: number, velocity: number): MrqCompatibilityReport {
  return {
    preserved: [
      { field: 'voice.name', detail: 'Nome de cada voz DX7 preservado (até 10 caracteres, padrão VCED).' },
      {
        field: 'zone.rootNote/tuneCents',
        detail: 'Afinação exata nas notas renderizadas — frequência calculada a partir da nota MIDI (A4=440Hz), sem aproximação.',
      },
    ],
    approximated: [
      {
        field: 'zone.loKey/hiKey',
        detail: `Cada voz foi renderizada a cada ${stepSemitones} semitons e esticada (pitch-shift) pro resto da tecla vizinha — não é um render nota-a-nota como o motor FM ao vivo (Dx7LayerVoice).`,
      },
      {
        field: 'zone.loVel/hiVel',
        detail: `Uma única velocidade (${velocity}) foi renderizada por nota; o DX7 muda timbre via FM com a velocity (não só volume) — isso não é recriado, só o ganho digital varia por tecla.`,
      },
      {
        field: 'sample clipping',
        detail: 'Vozes DX7 com vários operadores portadores altos podem passar de 0 dBFS (ver README do @audio/synth-dx7); essas amostras são limitadas (clipping) ao gravar, igual a qualquer AudioBuffer do Web Audio.',
      },
    ],
    unsupported: [
      {
        field: 'fm synthesis parameters',
        detail: 'O .mrq resultante é baseado em samples (PCM), não em síntese FM — operadores, algoritmo, envelopes e LFO originais não ficam editáveis depois da conversão, só o áudio já renderizado.',
      },
      {
        field: 'modulation (mod wheel/aftertouch/pitch bend/portamento)',
        detail: 'O render offline não modela esses controladores (mesma limitação do motor ao vivo) — as amostras capturam só a nota tocada e solta.',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// API pública — espelha o par Inspect/Convert de SF2 e NPNO (Fases 3/4)
// ---------------------------------------------------------------------------

export interface SyxInspectionResult {
  instrument: MrqInstrumentModel;
  compatibility: MrqCompatibilityReport;
}

export interface SyxConversionResult {
  finish: MrqFinishResult;
  compatibility: MrqCompatibilityReport;
}

/** Só faz o parsing estrutural (nomes/vozes) e projeta o modelo/relatório
 *  resultante — rápido, não renderiza nenhum áudio. Serve de preview antes
 *  de converter de verdade. */
export function inspectSyx(bytes: Uint8Array, options: SyxRenderOptions = {}, name = 'Banco DX7'): SyxInspectionResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const voices = parseSyxVoices(bytes);
  if (voices.length === 0) {
    throw new Error('Nenhuma voz DX7 válida foi encontrada neste arquivo .syx.');
  }
  const notes = representativeNotes(opts.noteStepSemitones);
  return {
    instrument: buildInstrumentModel(name, voices, notes),
    compatibility: buildCompatibilityReport(opts.noteStepSemitones, opts.velocity),
  };
}

/** Converte um .syx inteiro (parsing + render das notas representativas)
 *  pra um `.mrq` em `destPath`. Lê o arquivo de origem via a mesma ponte
 *  cross-plataforma usada pelo resto do Rack (`window.api.fs.toFileUrl` +
 *  `fetch`, ver rackReload.ts) — só a escrita do .mrq em si exige Tauri
 *  (mrqFormat.ts), igual às Fases 3/4. */
/** @param overrideInstrument Ver o mesmo parâmetro em
 *   `convertLoadedNkiToMrq` (nkiImport.ts) — modelo editado pelo Editor de
 *   Mapeamento usado no lugar do recém-montado por `buildInstrumentModel`,
 *   mantendo os `sampleId` (`voiceIndex::note`) que `mrqBuilderAddSample`
 *   abaixo continua gravando normalmente. */
export async function convertSyxToMrq(
  sourcePath: string,
  destPath: string,
  options: SyxRenderOptions = {},
  name = 'Banco DX7',
  overrideInstrument?: MrqInstrumentModel
): Promise<SyxConversionResult> {
  if (!isDx7RenderSupported()) {
    throw new Error(
      'Este navegador/WebView não suporta os recursos necessários (BigInt) pra renderizar áudio DX7 — precisa de WebKit equivalente ao Safari 14.1+ (a mesma exigência que a reprodução ao vivo de bancos .syx no Rack já tem). Não é possível gerar um .mrq com áudio neste sistema; os nomes das vozes ainda podem ser lidos com parseSyxVoices/inspectSyx.'
    );
  }

  const opts = { ...DEFAULT_OPTIONS, ...options };
  const url = await window.api.fs.toFileUrl(sourcePath);
  const res = await fetch(url);
  if (!res.ok) throw new Error('arquivo .syx não encontrado no disco.');
  const bytes = new Uint8Array(await res.arrayBuffer());

  const voices = parseSyxVoices(bytes);
  if (voices.length === 0) {
    throw new Error('Nenhuma voz DX7 válida foi encontrada neste arquivo .syx.');
  }
  const parsedVoices = parse(bytes);
  const notes = representativeNotes(opts.noteStepSemitones);
  const compatibility = buildCompatibilityReport(opts.noteStepSemitones, opts.velocity);
  const instrument = overrideInstrument ?? buildInstrumentModel(name, voices, notes);

  const renderModule = await loadOfflineRenderModule();
  const sessionId = await mrqBuilderBegin(destPath, instrument);

  const total = voices.length * notes.length;
  let done = 0;
  try {
    for (const voice of voices) {
      const patch = parsedVoices[voice.index].patch;
      for (const note of notes) {
        const samples = renderModule.renderDx7Note({
          patch,
          note,
          velocity: opts.velocity,
          sampleRateHz: opts.sampleRateHz,
          durationSeconds: opts.durationSeconds,
          releaseSeconds: opts.releaseSeconds,
        });
        await mrqBuilderAddSample(
          sessionId,
          sampleIdFor(voice.index, note),
          { kind: 'float32', interleaved: samples },
          opts.sampleRateHz,
          1
        );
        done += 1;
        opts.onProgress?.(done, total);
      }
    }
  } catch (err) {
    await mrqBuilderAbort(sessionId).catch(() => {
      /* já estamos no caminho de erro — não deixa uma falha no abort
         esconder o erro original. */
    });
    throw err;
  }

  const finish = await mrqBuilderFinish(sessionId);
  return { finish, compatibility };
}
