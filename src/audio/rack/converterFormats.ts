/**
 * Detecção de formato + dispatcher unificado dos importadores do MRQ
 * Instrument Converter (Fase 8, ver docs/mrq-instrument-converter/mrq-converter-architecture.md §7).
 * Cada formato já tem seu próprio par inspect/convert, espalhado em
 * `mrqFormat.ts` (SF2/SF3/NPNO/NSMP/WAV/AIFF/FLAC/MP3/OGG — Fases 2-4 e 7,
 * tudo backend Rust), `syxImport.ts` (Fase 5) e `nkiImport.ts` (Fase 6);
 * este módulo só os unifica atrás de uma API comum (`detectFormat`/
 * `inspectAny`/`convertAny`) pra a tela do conversor não precisar conhecer
 * as particularidades de cada um.
 *
 * Nenhuma lógica de conversão nova mora aqui — é só roteamento + a leitura
 * de bytes crua que o formato SYX precisa antes de inspecionar (os outros
 * formatos recebem um caminho de arquivo e leem/decodificam por conta
 * própria, no backend Rust ou, no caso do NKI, dentro de `nkiImport.ts`).
 */

import {
  mrqConvertAudioFileToMrq,
  mrqConvertNpnoToMrq,
  mrqConvertSf2ToMrq,
  mrqInspectAudioFile,
  mrqInspectNpno,
  mrqInspectSf2,
  type MrqCompatibilityReport,
  type MrqFinishResult,
  type MrqInstrumentModel,
} from './mrqFormat';
import { convertNkiToMrq, inspectNki, type NkiUnresolvedSample } from './nkiImport';
import { convertExsToMrq, inspectExs, type ExsUnresolvedSample } from './exsImport';
import { convertSyxToMrq, inspectSyx } from './syxImport';
export type { NkiUnresolvedSample, ExsUnresolvedSample };

export type ConverterFormatId =
  | 'sf2'
  | 'sf3'
  | 'npno'
  | 'nsmp'
  | 'syx'
  | 'nki'
  | 'exs'
  | 'wav'
  | 'aiff'
  | 'flac'
  | 'mp3'
  | 'ogg';

export const FORMAT_LABELS: Record<ConverterFormatId, string> = {
  sf2: 'SoundFont 2 (SF2)',
  sf3: 'SoundFont 3 (SF3)',
  npno: 'Biblioteca de piano Nord (NPNO)',
  nsmp: 'Amostra Nord (NSMP)',
  syx: 'Banco SysEx DX7 (SYX)',
  nki: 'Patch Kontakt (NKI)',
  exs: 'Instrumento Logic EXS24 (EXS)',
  wav: 'WAV',
  aiff: 'AIFF',
  flac: 'FLAC',
  mp3: 'MP3',
  ogg: 'OGG Vorbis',
};

/** Extensões conhecidas que NÃO são um `.nki` avulso válido (ver §6 do
 *  documento de arquitetura) — roteadas pro importador NKI mesmo assim,
 *  de propósito: é ele quem sabe explicar o motivo exato (DRM/escopo) via
 *  `checkKnownUnsupportedExtension`, em vez de um "formato desconhecido"
 *  genérico vindo daqui. */
const EXTENSION_MAP: Record<string, ConverterFormatId> = {
  sf2: 'sf2',
  sf3: 'sf3',
  npno: 'npno',
  nsmp: 'nsmp',
  nsmp3: 'nsmp',
  nsmp4: 'nsmp',
  syx: 'syx',
  nki: 'nki',
  nkx: 'nki',
  nkc: 'nki',
  nkb: 'nki',
  nkm: 'nki',
  exs: 'exs',
  wav: 'wav',
  wave: 'wav',
  aif: 'aiff',
  aiff: 'aiff',
  aifc: 'aiff',
  flac: 'flac',
  mp3: 'mp3',
  ogg: 'ogg',
  oga: 'ogg',
};

export function basenameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function extensionOf(path: string): string {
  const name = basenameOf(path);
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Detecção primária — pela extensão do nome do arquivo. É a fonte de
 *  verdade pra QUAL importador roda (nunca reescrita por um "palpite" de
 *  assinatura binária: um .sf2 e um .sf3 têm o mesmo cabeçalho RIFF e só a
 *  extensão os distingue de fato). */
export function detectFormatByExtension(path: string): ConverterFormatId | null {
  return EXTENSION_MAP[extensionOf(path)] ?? null;
}

/** Lê só os primeiros bytes do arquivo (sem baixar o arquivo inteiro pra
 *  isso) — usado só pra conferência auxiliar de assinatura binária (ver
 *  `sniffMagicBytes`), nunca pra decidir qual importador rodar.
 *
 *  IMPORTANTE: precisa mandar um cabeçalho `Range` na requisição. O
 *  protocolo customizado `mrqfile://` (`src-tauri/src/protocol.rs`) só
 *  devolve uma fatia parcial quando recebe `Range` — sem ele, ele lê e
 *  devolve o ARQUIVO INTEIRO de propósito (ver comentário em
 *  `serve_file`, que explica por que o corte fixo de 8MB foi removido:
 *  outros chamadores deste mesmo protocolo, como `AudioEngine.loadSong`,
 *  dependem de receber o arquivo completo num fetch() sem Range). Sem o
 *  Range aqui, esta função — que só queria espiar 32 bytes — forçava o
 *  Rust a carregar o arquivo inteiro na memória e mandar tudo pro
 *  WebView2 antes do primeiro byte chegar no renderer. Pra um `.nki`/
 *  `.npno` pequeno isso passava despercebido; pra uma biblioteca SF2
 *  comercial de vários GB, isso trava o import inteiro (e como isso
 *  acontece ANTES do item entrar na fila do React, nada aparece na tela
 *  nem no log — exatamente o bug relatado de ".sf2 não carrega, trava
 *  tudo"). */
export async function readFileHeaderBytes(path: string, maxBytes = 32): Promise<Uint8Array> {
  const url = await window.api.fs.toFileUrl(path);
  const res = await fetch(url, { headers: { Range: `bytes=0-${Math.max(0, maxBytes - 1)}` } });
  if (!res.ok || !res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.length;
    }
    const out = new Uint8Array(Math.min(total, maxBytes));
    let offset = 0;
    for (const chunk of chunks) {
      const take = Math.min(chunk.length, out.length - offset);
      out.set(chunk.subarray(0, take), offset);
      offset += take;
      if (offset >= out.length) break;
    }
    return out;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Lê o arquivo inteiro como bytes — necessário só pro importador SYX
 *  (`inspectSyx` recebe os bytes diretamente, sem comando Tauri de
 *  backend; `convertSyxToMrq` já lê por conta própria a partir do caminho). */
export async function readFileBytes(path: string): Promise<Uint8Array> {
  const url = await window.api.fs.toFileUrl(path);
  const res = await fetch(url);
  if (!res.ok) throw new Error('arquivo não encontrado no disco.');
  return new Uint8Array(await res.arrayBuffer());
}

function matchesSignature(bytes: Uint8Array, offset: number, sig: string): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i += 1) {
    if (bytes[offset + i] !== sig.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Conferência auxiliar de assinatura binária (magic bytes) — complementa a
 * detecção por extensão (pedido explícito do documento de arquitetura),
 * mas NUNCA decide sozinha qual importador roda: produz só uma descrição
 * legível pra UI avisar quando a extensão parece não bater com o conteúdo
 * real do arquivo (ex.: alguém renomeou um .mp3 pra .wav). `null` quando a
 * assinatura não é uma das reconhecidas aqui (não é necessariamente um
 * erro — vários formatos deste conversor, como SF2/SF3/NPNO/NSMP/NKI/SYX,
 * têm cabeçalhos próprios não cobertos por este checklist simples, e já
 * são validados de verdade dentro de cada importador).
 */
export function sniffMagicBytes(bytes: Uint8Array): string | null {
  if (matchesSignature(bytes, 0, 'RIFF') && matchesSignature(bytes, 8, 'WAVE')) return 'RIFF/WAVE';
  if (matchesSignature(bytes, 0, 'RIFF') && matchesSignature(bytes, 8, 'sfbk')) return 'RIFF/sfbk (SoundFont)';
  if (matchesSignature(bytes, 0, 'FORM') && (matchesSignature(bytes, 8, 'AIFF') || matchesSignature(bytes, 8, 'AIFC'))) {
    return 'FORM/AIFF';
  }
  if (matchesSignature(bytes, 0, 'fLaC')) return 'fLaC';
  if (matchesSignature(bytes, 0, 'OggS')) return 'OggS';
  if (matchesSignature(bytes, 0, 'ID3')) return 'ID3 (MP3)';
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'quadro MPEG (MP3)';
  return null;
}

/** `true` quando a assinatura reconhecida contradiz claramente o formato
 *  detectado pela extensão (ex.: extensão .wav, bytes de MP3) — usado só
 *  pra mostrar um aviso na fila, nunca pra bloquear a importação. */
export function magicBytesConflictWarning(format: ConverterFormatId, sniff: string | null): string | null {
  if (!sniff) return null;
  const expectedByFormat: Partial<Record<ConverterFormatId, string[]>> = {
    wav: ['RIFF/WAVE'],
    aiff: ['FORM/AIFF'],
    flac: ['fLaC'],
    ogg: ['OggS'],
    mp3: ['ID3 (MP3)', 'quadro MPEG (MP3)'],
    sf2: ['RIFF/sfbk (SoundFont)'],
    sf3: ['RIFF/sfbk (SoundFont)'],
  };
  const expected = expectedByFormat[format];
  if (!expected) return null;
  if (expected.includes(sniff)) return null;
  return `a extensão indica ${FORMAT_LABELS[format]}, mas os primeiros bytes do arquivo parecem ser ${sniff} — confira se a extensão está correta.`;
}

export interface ConverterInspection {
  instrument: MrqInstrumentModel;
  compatibility: MrqCompatibilityReport;
  /** Só preenchido pra `.nki`/`.exs` (ver NkiInspectionResult.unresolved/
   *  ExsInspectionResult.unresolved) — permite à UI do conversor checar
   *  `reason === 'not-found'` estruturalmente e oferecer "escolher pasta da
   *  biblioteca" sem parsear o texto do relatório de compatibilidade. */
  unresolved?: (NkiUnresolvedSample | ExsUnresolvedSample)[];
}

export interface ConverterConversion {
  finish: MrqFinishResult;
  compatibility: MrqCompatibilityReport;
  /** Ver ConverterInspection.unresolved. */
  unresolved?: (NkiUnresolvedSample | ExsUnresolvedSample)[];
}

/** Opções extras, específicas de cada formato, pro `inspectAny`/`convertAny`
 *  abaixo — `.nki` e `.exs` usam `libraryRoot` (mesmo conceito nos dois:
 *  pasta-raiz de biblioteca escolhida manualmente pelo usuário quando as
 *  amostras não estão perto do arquivo original), mas isto fica num objeto
 *  genérico (em vez de mais um parâmetro posicional) pra não precisar
 *  renegociar a assinatura de novo se outro formato precisar de algo
 *  parecido no futuro. */
export interface ConverterFormatOptions {
  /** Pasta-raiz de uma biblioteca de amostras escolhida manualmente pelo
   *  usuário (ver `fs.chooseFolder`) — usada quando `format === 'nki'` ou
   *  `format === 'exs'` pra tentar resolver, por nome de arquivo, amostras
   *  que não estavam perto do arquivo original nem numa subpasta
   *  Samples/samples direta. */
  libraryRoot?: string;
  /** Modelo editado pelo Editor de Mapeamento (MappingEditor.tsx) pra usar
   *  NO LUGAR do mapeamento recém-extraído do arquivo de origem — só tem
   *  efeito real em formatos cuja conversão roda inteiramente no WebView e
   *  monta o `MrqInstrumentModel` localmente antes de chamar
   *  `mrqBuilderBegin` (`.syx` DX7, `.nki` Kontakt, `.exs` Logic EXS24).
   *  Formatos que convertem via um único comando Rust opaco
   *  (`mrq_convert_*_to_mrq`, sem gancho pra receber um modelo de volta)
   *  ainda ignoram este campo — ver `formatSupportsMappingEdits` em
   *  InstrumentConverter.tsx, que decide quando oferecer isto ao usuário. */
  overrideInstrument?: MrqInstrumentModel;
}

/** Inspeciona (parsing estrutural, sem gravar nada em disco) um arquivo de
 *  origem já com o formato detectado. Lança o erro específico de cada
 *  importador quando o arquivo é inválido/fora de escopo (nunca um erro
 *  genérico "formato desconhecido" nesse ponto — isso só acontece em
 *  `detectFormatByExtension` retornando `null`, tratado por quem chama). */
export async function inspectAny(
  format: ConverterFormatId,
  sourcePath: string,
  opts?: ConverterFormatOptions
): Promise<ConverterInspection> {
  switch (format) {
    case 'sf2':
    case 'sf3':
      return mrqInspectSf2(sourcePath);
    case 'npno':
    case 'nsmp':
      return mrqInspectNpno(sourcePath);
    case 'wav':
    case 'aiff':
    case 'flac':
    case 'mp3':
    case 'ogg':
      return mrqInspectAudioFile(sourcePath);
    case 'syx': {
      const bytes = await readFileBytes(sourcePath);
      return inspectSyx(bytes, {}, basenameOf(sourcePath).replace(/\.syx$/i, ''));
    }
    case 'nki':
      return inspectNki(sourcePath, undefined, opts?.libraryRoot);
    case 'exs':
      return inspectExs(sourcePath, undefined, opts?.libraryRoot);
    default: {
      const exhaustive: never = format;
      throw new Error(`formato não reconhecido: ${String(exhaustive)}`);
    }
  }
}

/** Converte um arquivo de origem já com o formato detectado pra um `.mrq`
 *  em `destPath`. Mesma regra de erro-específico-nunca-genérico do
 *  `inspectAny` acima. */
export async function convertAny(
  format: ConverterFormatId,
  sourcePath: string,
  destPath: string,
  /** Progresso granular real — só o importador SYX expõe isso hoje
   *  (contagem de vozes DX7 renderizadas). Os demais formatos convertem
   *  numa única chamada atômica ao backend Rust, sem canal de progresso;
   *  a UI deve tratar a ausência de chamadas a este callback como "sem
   *  progresso incremental disponível", nunca simular uma percentagem. */
  onProgress?: (done: number, total: number) => void,
  opts?: ConverterFormatOptions
): Promise<ConverterConversion> {
  switch (format) {
    case 'sf2':
    case 'sf3':
      return mrqConvertSf2ToMrq(sourcePath, destPath);
    case 'npno':
    case 'nsmp':
      return mrqConvertNpnoToMrq(sourcePath, destPath);
    case 'wav':
    case 'aiff':
    case 'flac':
    case 'mp3':
    case 'ogg':
      return mrqConvertAudioFileToMrq(sourcePath, destPath);
    case 'syx':
      return convertSyxToMrq(sourcePath, destPath, { onProgress }, basenameOf(sourcePath).replace(/\.syx$/i, ''), opts?.overrideInstrument);
    case 'nki':
      return convertNkiToMrq(sourcePath, destPath, undefined, opts?.libraryRoot, opts?.overrideInstrument);
    case 'exs':
      return convertExsToMrq(sourcePath, destPath, undefined, opts?.libraryRoot, opts?.overrideInstrument);
    default: {
      const exhaustive: never = format;
      throw new Error(`formato não reconhecido: ${String(exhaustive)}`);
    }
  }
}
