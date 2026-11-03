/**
 * Importador de patches Kontakt (.nki) — Fase 6 do MRQ Instrument Converter
 * (ver docs/mrq-instrument-converter/mrq-converter-architecture.md §6/§8). Reaproveita inteiramente
 * `NkiLayerVoice.ts` (parsing do contêiner zlib+XML, resolução de amostras,
 * decodificação de áudio real via `decodeAudioData`) — o trabalho novo
 * desta fase é só a adaptação da saída (igual já existe pra `.mrqi` em
 * mrqiExport.ts, mas escrevendo pro formato `.mrq` da Fase 2) e o relatório
 * de limites honesto exigido pela §6.
 *
 * §6 é explícita: até ferramentas comerciais estabelecidas (Chicken Systems
 * Translator/SampleStack) não conseguem ler Kontakt 6+, nem qualquer
 * .nki/.nkm/.nkb que referencie .nkx/.ncw (amostras criptografadas/
 * comprimidas) — mesmo em Kontakt 4/5. Isso é proteção anticópia deliberada
 * da Native Instruments, não uma lacuna de engenharia. Este módulo NUNCA
 * declara suporte total a .nki: todo caso não lido gera um erro específico
 * (criptografado / versão não suportada / bank em vez de patch avulso /
 * amostra em codec não suportado / etc.), nunca falha silenciosamente nem
 * finge sucesso parcial — amostras que não resolveram aparecem no relatório
 * de compatibilidade como `unsupported`, nunca são omitidas.
 */

import { NkiLayerVoice, type NkiUnresolvedSample } from './NkiLayerVoice';
export type { NkiUnresolvedSample };
import { audioBufferToSampleInput } from './mrqiFormat';
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
// Extensões companheiras conhecidas que NÃO são .nki avulso — ver §6.
// Checar isso ANTES de tentar abrir evita um erro genérico de parsing e dá
// um motivo específico, igual o resto do projeto já faz pra outros formatos.
// ---------------------------------------------------------------------------

const KNOWN_UNSUPPORTED_EXTENSIONS: Record<string, string> = {
  '.nkx': 'biblioteca de amostras comprimida/criptografada do Kontakt (NKX) — protegida por DRM da Native Instruments, nunca lida por nenhuma ferramenta de terceiros de forma legítima.',
  '.nkc': 'cache/contêiner de biblioteca do Kontakt (NKC) — mesmo status de proteção que .nkx.',
  '.nkb': 'banco de patches do Kontakt (NKB, múltiplos .nki agrupados) — fora do escopo atual (só .nki avulso é suportado); abra os .nki individuais, se existirem.',
  '.nkm': 'multi-instrumento do Kontakt (NKM, combina vários patches com roteamento) — fora do escopo atual, só .nki avulso é suportado.',
};

export function checkKnownUnsupportedExtension(sourcePath: string): void {
  const match = /\.[a-z0-9]+$/i.exec(sourcePath.trim());
  const ext = match ? match[0].toLowerCase() : '';
  const reason = KNOWN_UNSUPPORTED_EXTENSIONS[ext];
  if (reason) {
    throw new Error(`Este arquivo (${ext}) não é um .nki avulso: ${reason}`);
  }
}

// ---------------------------------------------------------------------------
// Modelo MRQ a partir de um NkiLayerVoice já carregado
// ---------------------------------------------------------------------------

/** Conversão exata de ganho linear (como o .nki guarda volume/gain, ver
 *  FIELD_ALIASES.volume em NkiLayerVoice.ts) pra dB (como o campo
 *  `volumeDb` do .mrq espera) — não é uma aproximação, é só mudança de
 *  unidade; um piso de -120dB evita -Infinity/NaN no raríssimo caso de
 *  volume <= 0. */
export function linearGainToDb(gain: number): number {
  if (!(gain > 0)) return -120;
  return Math.max(-120, 20 * Math.log10(gain));
}

function sampleIdFor(groupIndex: number, zoneIndex: number): string {
  return `nki-g${groupIndex}-z${zoneIndex}`;
}

/** Formato mínimo de AudioBuffer que a lógica pura abaixo precisa — tipagem
 *  estrutural de propósito (não importa `AudioBuffer` do DOM diretamente),
 *  pra `buildInstrumentModel`/`buildCompatibilityReport` não dependerem de
 *  nenhuma API de navegador e poderem ser testadas em Node puro com um
 *  objeto falso (ver scripts/test-nki-import.mjs) — o mesmo princípio de
 *  "lógica de conversão desacoplada da UI/runtime" já seguido nas fases
 *  anteriores. Um `AudioBuffer` real satisfaz esse formato sem nenhuma
 *  conversão (tipagem estrutural do TypeScript).
 */
export interface NkiAudioBufferLike {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

export interface NkiExportedZone {
  buffer: NkiAudioBufferLike;
  samplePath: string;
  rootNote: number;
  loNote: number;
  hiNote: number;
  loVel: number;
  hiVel: number;
  tuneCents: number;
  volume: number;
  pan: number;
}

export interface NkiExportedInstrument {
  instrumentName: string;
  groups: { name: string; zones: NkiExportedZone[] }[];
}

interface BuiltNkiModel {
  instrument: MrqInstrumentModel;
  sampleRefs: { sampleId: string; buffer: NkiAudioBufferLike }[];
}

export function buildInstrumentModel(exported: NkiExportedInstrument): BuiltNkiModel {
  const sampleRefs: { sampleId: string; buffer: NkiAudioBufferLike }[] = [];
  const presets: MrqPreset[] = exported.groups.map((group, gi) => ({
    id: `nki-group-${gi}`,
    name: group.name,
    groups: [
      {
        id: `nki-group-${gi}-g`,
        name: group.name,
        zones: group.zones.map((zone, zi) => {
          const sampleId = sampleIdFor(gi, zi);
          sampleRefs.push({ sampleId, buffer: zone.buffer });
          return {
            sampleId,
            rootNote: zone.rootNote,
            loKey: zone.loNote,
            hiKey: zone.hiNote,
            loVel: zone.loVel,
            hiVel: zone.hiVel,
            tuneCents: zone.tuneCents,
            volumeDb: linearGainToDb(zone.volume || 1),
            pan: zone.pan,
            stereo: zone.buffer.numberOfChannels >= 2 ? ('stereo' as const) : ('mono' as const),
          };
        }),
      },
    ],
  }));
  return {
    instrument: {
      name: exported.instrumentName,
      sourceFormat: 'nki',
      importedAt: new Date().toISOString(),
      presets,
    },
    sampleRefs,
  };
}

export function describeUnresolved(entry: NkiUnresolvedSample): string {
  const fileName = entry.samplePath.split(/[\\/]/).pop() ?? entry.samplePath;
  if (entry.reason === 'unsupported-codec') {
    return `${fileName}: amostra em .ncw (NI Compressed Wave), um codec proprietário sem decoder no navegador/WebView — não dá pra recuperar o áudio sem a amostra original em .wav/.aiff.`;
  }
  return `${fileName}: não encontrada ao lado do .nki no disco (ou dentro de uma pasta "Samples"/"samples") — a zona ficou muda e foi excluída da conversão.`;
}

export function buildCompatibilityReport(unresolved: NkiUnresolvedSample[]): MrqCompatibilityReport {
  const report: MrqCompatibilityReport = {
    preserved: [
      { field: 'zone.rootNote/loKey/hiKey/loVel/hiVel', detail: 'Mapeamento de tecla/velocidade lido do XML interno do .nki (ou inferido do nome do arquivo quando a nota raiz não veio explícita).' },
      { field: 'zone.tuneCents/pan/volumeDb', detail: 'Afinação fina, pan e volume (convertido de ganho linear pra dB, sem perda) preservados por zona.' },
      { field: 'programas/grupos de timbre', detail: 'Quando o .nki tem mais de um "Programa" (variação de timbre), cada um vira um preset separado no .mrq.' },
    ],
    approximated: [
      {
        field: 'zone.rootNote/loKey/hiKey (nomes de campo do schema XML)',
        detail: 'A Native Instruments nunca publicou o schema XML do .nki — os campos são reconhecidos por várias variações plausíveis de nome (ver FIELD_ALIASES em NkiLayerVoice.ts), não um schema oficial confirmado. Na grande maioria dos patches isso funciona, mas um nome de campo fora do esperado pode cair no valor padrão (nota 60, tecla/velocidade cheia) em vez do valor real.',
      },
    ],
    unsupported: [
      {
        field: 'engine de efeitos/scripts (KSP)',
        detail: 'Só os timbres/amostras são convertidos — o motor de efeitos e scripts do Kontakt (KSP) não é reimplementado (não cabe no plano de licenciamento deste app).',
      },
      {
        field: 'arquivos "monolito" e bibliotecas protegidas',
        detail: 'Kontakt 4.2.2+ (binário criptografado), Kontakt 5/6 (formato interno não documentado), .nki "monolito" (amostras embutidas) e qualquer referência a .nkx/.ncw são proteção anticópia da Native Instruments — nenhuma ferramenta de terceiros (incluindo as comerciais estabelecidas da indústria) lê isso hoje. Arquivos assim nem chegam a este relatório: falham no carregamento com um erro específico, nunca com sucesso parcial fingido.',
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

// ---------------------------------------------------------------------------
// API pública — espelha o par Inspect/Convert das Fases 3/4/5, com uma
// variante extra que opera sobre um NkiLayerVoice JÁ carregado (mesmo
// contrato que exportNkiToMrqi, pra quando o .nki já está tocando numa
// camada do Rack e não vale a pena decodificar tudo de novo).
// ---------------------------------------------------------------------------

export interface NkiInspectionResult {
  instrument: MrqInstrumentModel;
  compatibility: MrqCompatibilityReport;
  /** Lista estruturada das amostras que não resolveram (mesma origem do
   *  texto já embutido em `compatibility`) — exposta à parte pra quem
   *  consome isto (ex.: InstrumentConverter.tsx) poder checar
   *  `reason === 'not-found'` e oferecer "escolher pasta da biblioteca"
   *  sem precisar fazer parsing do texto do relatório. */
  unresolved: NkiUnresolvedSample[];
}

export interface NkiConversionResult {
  finish: MrqFinishResult;
  compatibility: MrqCompatibilityReport;
  /** Ver NkiInspectionResult.unresolved. */
  unresolved: NkiUnresolvedSample[];
}

/** Inspeciona um .nki já carregado numa `NkiLayerVoice` (ex.: a camada ativa
 *  do Rack) — não decodifica nada de novo, só reflete o que já foi
 *  resolvido por `load()`. Mesmo aviso de `NkiLayerVoice`: como a
 *  decodificação de áudio já acontece dentro de `load()`, não existe uma
 *  "inspeção rápida sem áudio" pra .nki como existe pra SF2/NPNO/SYX — o
 *  custo de abrir o arquivo já foi pago antes de chamar isto. */
export function inspectLoadedNki(voice: NkiLayerVoice): NkiInspectionResult {
  const { instrument } = buildInstrumentModel(voice.exportForMrqi());
  return {
    instrument,
    compatibility: buildCompatibilityReport(voice.unresolvedSamples),
    unresolved: voice.unresolvedSamples,
  };
}

/** Converte um .nki já carregado numa `NkiLayerVoice` pra um `.mrq` em
 *  `destPath`. Reempacota os `AudioBuffer`s já decodificados (nenhuma
 *  releitura do .nki ou de amostras do disco) — equivalente a
 *  `exportNkiToMrqi`, mas escrevendo no formato `.mrq` da Fase 2
 *  (`mrqBuilderBegin/AddSample/Finish`) em vez do `.mrqi` legado.
 *
 *  @param overrideInstrument Modelo editado pelo Editor de Mapeamento
 *   (MappingEditor.tsx) — quando presente, é usado NO LUGAR do modelo
 *   recém-reconstruído a partir da `voice` (tecla raiz/afinação/faixas/
 *   volume/pan editados pelo usuário). As amostras continuam vindo da
 *   `voice` normalmente — o override só troca os METADADOS das zonas,
 *   nunca os `sampleId`, que precisam continuar batendo com `sampleRefs`
 *   (garantido porque a tela de edição só mexe nos campos escalares da
 *   zona, nunca adiciona/remove/reordena zona ou troca `sampleId`). */
export async function convertLoadedNkiToMrq(
  voice: NkiLayerVoice,
  destPath: string,
  overrideInstrument?: MrqInstrumentModel
): Promise<NkiConversionResult> {
  const { instrument: builtInstrument, sampleRefs } = buildInstrumentModel(voice.exportForMrqi());
  const instrument = overrideInstrument ?? builtInstrument;
  const compatibility = buildCompatibilityReport(voice.unresolvedSamples);
  const unresolved = voice.unresolvedSamples;
  if (sampleRefs.length === 0) {
    throw new Error('Nenhuma amostra resolvida neste .nki — não há áudio pra gravar no .mrq.');
  }
  const sessionId = await mrqBuilderBegin(destPath, instrument);
  try {
    for (const ref of sampleRefs) {
      // Aqui `ref.buffer` é sempre um AudioBuffer real de verdade (veio de
      // `voice.exportForMrqi()`, que só existe depois de decodeAudioData) —
      // NkiAudioBufferLike é só uma tipagem estrutural mais larga pra
      // permitir testar buildInstrumentModel/buildCompatibilityReport sem
      // navegador (ver scripts/test-nki-import.mjs), não um tipo diferente
      // em tempo de execução.
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
      /* já estamos no caminho de erro — não deixa uma falha no abort
         esconder o erro original. */
    });
    throw err;
  }
  const finish = await mrqBuilderFinish(sessionId);
  return { finish, compatibility, unresolved };
}

/** Abre um .nki do zero a partir do disco (fora do Rack — ex.: a futura
 *  tela "MRQ Instrument Converter", Fase 8) e devolve o modelo/relatório
 *  projetado, sem escrever nenhum .mrq ainda. Cria um `AudioContext`
 *  efêmero próprio quando nenhum for passado (decodeAudioData exige um) e
 *  o fecha ao terminar. */
export async function inspectNki(
  sourcePath: string,
  ctx?: AudioContext,
  libraryRoot?: string
): Promise<NkiInspectionResult> {
  const voice = await loadNkiFromDisk(sourcePath, ctx, libraryRoot);
  try {
    return inspectLoadedNki(voice);
  } finally {
    voice.dispose();
  }
}

/** Converte um .nki do disco (`sourcePath`) inteiro pra um `.mrq` em
 *  `destPath` — lê o arquivo, decodifica as amostras reais e grava. Lança
 *  um erro específico e claro (nunca genérico) pra qualquer caso coberto
 *  pela §6 do documento de arquitetura (criptografado, versão não
 *  suportada, banco em vez de patch avulso, codec de amostra não
 *  suportado). */
export async function convertNkiToMrq(
  sourcePath: string,
  destPath: string,
  ctx?: AudioContext,
  libraryRoot?: string,
  overrideInstrument?: MrqInstrumentModel
): Promise<NkiConversionResult> {
  const voice = await loadNkiFromDisk(sourcePath, ctx, libraryRoot);
  try {
    return await convertLoadedNkiToMrq(voice, destPath, overrideInstrument);
  } finally {
    voice.dispose();
  }
}

/**
 * @param libraryRoot Pasta-raiz de biblioteca escolhida manualmente pelo
 *  usuário (ver NkiLayerVoice.resolveFromLibraryRoot) — passada direto pra
 *  `voice.load`, que já sabe usá-la como fonte extra de busca quando as
 *  amostras não estão perto do .nki. Opcional: sem ela, o comportamento é
 *  idêntico ao de antes desta capacidade existir.
 */
async function loadNkiFromDisk(sourcePath: string, ctx?: AudioContext, libraryRoot?: string): Promise<NkiLayerVoice> {
  checkKnownUnsupportedExtension(sourcePath);
  const ownedCtx = ctx ?? new AudioContext();
  try {
    const url = await window.api.fs.toFileUrl(sourcePath);
    const res = await fetch(url);
    if (!res.ok) throw new Error('arquivo .nki não encontrado no disco.');
    const buffer = await res.arrayBuffer();
    const voice = new NkiLayerVoice(ownedCtx);
    await voice.load(buffer, sourcePath, libraryRoot);
    return voice;
  } finally {
    // só fecha o contexto se fomos nós que o criamos — um AudioContext
    // passado pelo chamador (ex.: o já usado por uma camada do Rack) não é
    // nosso pra fechar.
    if (!ctx) {
      // decodeAudioData já terminou (await voice.load concluiu) antes de
      // chegarmos aqui, então fechar agora é seguro mesmo em caso de erro.
      await ownedCtx.close().catch(() => {
        /* alguns navegadores reclamam de fechar duas vezes; inofensivo */
      });
    }
  }
}
