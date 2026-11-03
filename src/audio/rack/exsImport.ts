/**
 * Importador de instrumentos Logic EXS24 (.exs) pro MRQ Instrument
 * Converter — mesmo papel que `nkiImport.ts` cumpre pro Kontakt, só que pro
 * formato do antigo sampler EXS24 do Logic Pro (hoje "Sampler", que ainda lê
 * e grava `.exs`). O parsing binário em si mora em `ExsFile.ts` (puro,
 * testável em Node — ver scripts/test-exs-import.mjs); a resolução de
 * amostra em disco + decodificação real de áudio mora em `ExsLayerVoice.ts`
 * (depende de navegador: fetch/decodeAudioData). Este módulo só adapta a
 * saída de um `ExsLayerVoice` já carregado pro modelo `.mrq`, igual
 * `nkiImport.ts` faz com `NkiLayerVoice`.
 *
 * Diferença importante de escopo em relação ao `.nki`: o Logic nunca
 * criptografou o `.exs` (não existe aqui o equivalente da barreira do
 * Kontakt 4.2.2+) — então, ao contrário do Kontakt, QUALQUER `.exs` que
 * referencie arquivos de amostra externos (o caso extremamente mais comum)
 * é suportado, não só "versões antigas sem DRM". O que fica de fora,
 * documentado honestamente no relatório de compatibilidade (nunca omitido):
 * motor de filtro/envelope/matriz de modulação do EXS24 (não reimplementado,
 * mesmo princípio já aplicado ao KSP do Kontakt), loop/offset de amostra
 * (o Rack deste app sempre toca a amostra inteira, do início ao fim — mesma
 * limitação já aceita pro SFZ, ver SfzLayerVoice.ts), round-robin/exclusive
 * groups, e instrumentos "consolidados num arquivo só" (Logic >= 9 pode
 * gravar um Auto Sampler inteiro como um único CAF com offsets internos por
 * zona — ver `ExsSample.waveDataStart`/`isCompressed` em ExsFile.ts).
 */

import type { ExsZone } from './ExsFile';
export type { ExsZone };
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
import { audioBufferToSampleInput } from './mrqiFormat';
import { ExsLayerVoice, type ExsUnresolvedSample } from './ExsLayerVoice';
export type { ExsUnresolvedSample };

/** Mesmo formato estrutural mínimo de AudioBuffer usado por nkiImport.ts —
 *  ver o comentário de `NkiAudioBufferLike` lá pro porquê (testável em Node
 *  puro, sem depender do DOM). */
export interface ExsAudioBufferLike {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

export interface ExsExportedZone {
  buffer: ExsAudioBufferLike;
  samplePath: string;
  rootNote: number;
  loNote: number;
  hiNote: number;
  loVel: number;
  hiVel: number;
  tuneCents: number;
  /** Ganho em dB já combinado zona+grupo — ver ExsZone.gainDb em ExsFile.ts
   *  (ao contrário do `.nki`, que guarda ganho linear). */
  gainDb: number;
  pan: number;
}

export interface ExsExportedInstrument {
  instrumentName: string;
  zones: ExsExportedZone[];
}

interface BuiltExsModel {
  instrument: MrqInstrumentModel;
  sampleRefs: { sampleId: string; buffer: ExsAudioBufferLike }[];
}

function sampleIdFor(index: number): string {
  return `exs-z${index}`;
}

export function buildInstrumentModel(exported: ExsExportedInstrument): BuiltExsModel {
  const sampleRefs: { sampleId: string; buffer: ExsAudioBufferLike }[] = [];
  const preset: MrqPreset = {
    id: 'exs-preset-0',
    name: exported.instrumentName,
    groups: [
      {
        id: 'exs-preset-0-g',
        name: exported.instrumentName,
        zones: exported.zones.map((zone, zi) => {
          const sampleId = sampleIdFor(zi);
          sampleRefs.push({ sampleId, buffer: zone.buffer });
          return {
            sampleId,
            rootNote: zone.rootNote,
            loKey: zone.loNote,
            hiKey: zone.hiNote,
            loVel: zone.loVel,
            hiVel: zone.hiVel,
            tuneCents: zone.tuneCents,
            volumeDb: zone.gainDb,
            pan: zone.pan,
            stereo: zone.buffer.numberOfChannels >= 2 ? ('stereo' as const) : ('mono' as const),
          };
        }),
      },
    ],
  };
  return {
    instrument: {
      name: exported.instrumentName,
      sourceFormat: 'exs',
      importedAt: new Date().toISOString(),
      presets: [preset],
    },
    sampleRefs,
  };
}

export function describeUnresolved(entry: ExsUnresolvedSample): string {
  const fileName = entry.samplePath.split(/[\\/]/).pop() ?? entry.samplePath;
  if (entry.reason === 'unsupported-codec') {
    return `${fileName}: amostra consolidada num único arquivo de áudio com offset interno (Auto Sampler do Logic) ou marcada como comprimida internamente — extrair o trecho exato dessa zona não é suportado ainda; exporte o instrumento como .sfz de dentro do Logic/EXS24 (o Logic faz isso nativamente) como alternativa.`;
  }
  return `${fileName}: não encontrada ao lado do .exs no disco (nem numa pasta "Samples"/"samples") — a zona ficou muda e foi excluída da conversão.`;
}

export function buildCompatibilityReport(unresolved: ExsUnresolvedSample[]): MrqCompatibilityReport {
  const report: MrqCompatibilityReport = {
    preserved: [
      { field: 'zone.rootNote/loKey/hiKey/loVel/hiVel', detail: 'Mapeamento de tecla/velocidade lido diretamente do bloco binário do .exs (Zone, offsets documentados em ExsFile.ts).' },
      { field: 'zone.tuneCents/pan/volumeDb', detail: 'Afinação fina+grossa, pan e ganho (já combinando zona + grupo, quando houver) preservados por zona.' },
      { field: 'switch "Pitch" desligado', detail: 'Zonas sem rastreamento de pitch (comum em kits de bateria/one-shots) ficam limitadas à própria tecla raiz, pra nunca tocar transposta por engano — o Rack deste app sempre aplica pitch-tracking por nota, não existe um modo "sem pitch" no motor.' },
    ],
    approximated: [
      {
        field: 'reprodução da amostra (início/fim, loop)',
        detail: 'Cada zona toca a amostra inteira, do início ao fim, sempre — pontos de loop e de corte (sample start/end) do .exs são lidos mas não aplicados na reprodução (mesma limitação já aceita pro SFZ, ver SfzLayerVoice.ts). Pra amostras já cortadas/com loop embutido no próprio arquivo de áudio isso não muda nada; pra zonas que dependem do Logic cortar um arquivo maior em tempo real, o resultado toca a amostra completa.',
      },
    ],
    unsupported: [
      {
        field: 'motor de filtro/envelope/matriz de modulação do EXS24',
        detail: 'Só os timbres/amostras e seu mapeamento de tecla/velocidade são convertidos — filtros, envelopes (ADSR) e a matriz de modulação do EXS24 não são reimplementados (mesmo princípio já aplicado ao motor de scripts do Kontakt, KSP).',
      },
      {
        field: 'round-robin e grupos exclusivos',
        detail: 'Quando o .exs usa alternância round-robin entre zonas (Group com enableByType=Round-Robin), todas as variações são convertidas como zonas normais sobrepostas (todas tocam juntas), não alternadas — o conversor não reimplementa a lógica de alternância do Logic.',
      },
      {
        field: 'instrumentos consolidados num único arquivo (Auto Sampler)',
        detail: 'Instrumentos do Logic 9+ que consolidam todas as zonas num único arquivo de áudio com offset interno por zona (recurso do Auto Sampler) não são suportados — cada zona precisa referenciar seu próprio arquivo de amostra avulso no disco. Arquivos assim aparecem no relatório com `unsupported-codec`, nunca silenciosamente ignorados.',
      },
    ],
  };
  if (unresolved.length > 0) {
    report.unsupported.push({
      field: `${unresolved.length} amostra(s) não resolvida(s)`,
      detail: unresolved.map(describeUnresolved).join(' | '),
    });
  }
  return report;
}

export interface ExsInspectionResult {
  instrument: MrqInstrumentModel;
  compatibility: MrqCompatibilityReport;
  unresolved: ExsUnresolvedSample[];
}

export interface ExsConversionResult {
  finish: MrqFinishResult;
  compatibility: MrqCompatibilityReport;
  unresolved: ExsUnresolvedSample[];
}

export function inspectLoadedExs(voice: ExsLayerVoice): ExsInspectionResult {
  const { instrument } = buildInstrumentModel(voice.exportForMrqi());
  return {
    instrument,
    compatibility: buildCompatibilityReport(voice.unresolvedSamples),
    unresolved: voice.unresolvedSamples,
  };
}

/** @param overrideInstrument Ver o mesmo parâmetro em
 *   `convertLoadedNkiToMrq` (nkiImport.ts) — mesmo contrato: modelo editado
 *   pelo Editor de Mapeamento usado no lugar do recém-reconstruído a
 *   partir da `voice`, mantendo os `sampleId` originais. */
export async function convertLoadedExsToMrq(
  voice: ExsLayerVoice,
  destPath: string,
  overrideInstrument?: MrqInstrumentModel
): Promise<ExsConversionResult> {
  const { instrument: builtInstrument, sampleRefs } = buildInstrumentModel(voice.exportForMrqi());
  const instrument = overrideInstrument ?? builtInstrument;
  const compatibility = buildCompatibilityReport(voice.unresolvedSamples);
  const unresolved = voice.unresolvedSamples;
  if (sampleRefs.length === 0) {
    throw new Error('Nenhuma amostra resolvida neste .exs — não há áudio pra gravar no .mrq.');
  }
  const sessionId = await mrqBuilderBegin(destPath, instrument);
  try {
    for (const ref of sampleRefs) {
      const input = audioBufferToSampleInput(ref.buffer as AudioBuffer);
      await mrqBuilderAddSample(
        sessionId,
        ref.sampleId,
        { kind: 'float32', interleaved: input.data },
        input.sampleRate,
        input.channels
      );
    }
  } catch (err) {
    await mrqBuilderAbort(sessionId).catch(() => {
      /* já estamos no caminho de erro — não deixa uma falha no abort esconder o erro original. */
    });
    throw err;
  }
  const finish = await mrqBuilderFinish(sessionId);
  return { finish, compatibility, unresolved };
}

async function loadExsFromDisk(sourcePath: string, ctx?: AudioContext, libraryRoot?: string): Promise<ExsLayerVoice> {
  const ownedCtx = ctx ?? new AudioContext();
  try {
    const url = await window.api.fs.toFileUrl(sourcePath);
    const res = await fetch(url);
    if (!res.ok) throw new Error('arquivo .exs não encontrado no disco.');
    const buffer = await res.arrayBuffer();
    const voice = new ExsLayerVoice(ownedCtx);
    await voice.load(buffer, sourcePath, libraryRoot);
    return voice;
  } finally {
    if (!ctx) {
      await ownedCtx.close().catch(() => {
        /* alguns navegadores reclamam de fechar duas vezes; inofensivo */
      });
    }
  }
}

export async function inspectExs(sourcePath: string, ctx?: AudioContext, libraryRoot?: string): Promise<ExsInspectionResult> {
  const voice = await loadExsFromDisk(sourcePath, ctx, libraryRoot);
  try {
    return inspectLoadedExs(voice);
  } finally {
    voice.dispose();
  }
}

export async function convertExsToMrq(
  sourcePath: string,
  destPath: string,
  ctx?: AudioContext,
  libraryRoot?: string,
  overrideInstrument?: MrqInstrumentModel
): Promise<ExsConversionResult> {
  const voice = await loadExsFromDisk(sourcePath, ctx, libraryRoot);
  try {
    return await convertLoadedExsToMrq(voice, destPath, overrideInstrument);
  } finally {
    voice.dispose();
  }
}
