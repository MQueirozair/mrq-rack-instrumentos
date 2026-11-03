/**
 * Cliente fino do formato `.mrq` ("MRQ Instrument") — Fase 2 do MRQ
 * Instrument Converter (ver docs/mrq-instrument-converter/mrq-converter-architecture.md). Toda a
 * codificação FLAC, hashing e empacotamento binário roda no backend Rust
 * (`src-tauri/src/mrq/`), não no WebView — só os tipos e os wrappers de
 * `invoke` moram aqui. Este módulo é novo e independente: NÃO toca em
 * `mrqiFormat.ts`/`mrqiExport.ts`/`MrqiLayerVoice.ts` (formato `.mrqi`
 * existente, que continua funcionando exatamente como antes) nem é usado
 * por nenhum carregador do Rack ainda — isso só entra numa fase futura,
 * depois de validado.
 *
 * Só funciona rodando dentro do Tauri (usa `@tauri-apps/api/core`
 * diretamente) — o MRQ Instrument Converter é funcionalidade nova, sem
 * necessidade de equivalente no build legado em Electron.
 */

import { invoke } from '@tauri-apps/api/core';

// ---------------------------------------------------------------------------
// MRQ Instrument Model — espelha 1:1 as structs serde de
// src-tauri/src/mrq/model.rs. Nenhum campo é inventado por importadores:
// tudo que uma fonte não puder prover fica `undefined`.
// ---------------------------------------------------------------------------

export interface MrqEnvelope {
  attack: number;
  hold?: number;
  decay: number;
  sustain: number;
  release: number;
}

export type MrqFilterType = 'lowpass' | 'highpass' | 'bandpass';

export interface MrqFilter {
  filterType: MrqFilterType;
  cutoffHz: number;
  resonance: number;
}

export type MrqModulationSource = 'lfo' | 'envelope2' | 'velocity' | 'aftertouch' | 'modwheel';
export type MrqModulationDestination = 'pitch' | 'cutoff' | 'volume' | 'pan';

export interface MrqModulation {
  source: MrqModulationSource;
  destination: MrqModulationDestination;
  amount: number;
}

export type MrqStereoMode = 'mono' | 'stereo' | 'left' | 'right';

export interface MrqZone {
  /** Referencia o `id` passado para `mrqBuilderAddSample` na mesma sessão. */
  sampleId: string;
  rootNote: number;
  loKey: number;
  hiKey: number;
  loVel: number;
  hiVel: number;
  roundRobinGroup?: string;
  roundRobinIndex?: number;
  tuneCents: number;
  volumeDb: number;
  pan: number;
  stereo?: MrqStereoMode;
  loopEnabled?: boolean;
  loopStart?: number;
  loopEnd?: number;
  envelope?: MrqEnvelope;
  filter?: MrqFilter;
  /** Grupo de exclusividade/"choke" (ex.: ExclusiveClass do SF2/SF3) —
   *  preservado como dado desde a Fase 3, mas nenhum motor de reprodução
   *  MRQ ainda aplica esse comportamento (ver MrqCompatibilityReport). */
  exclusiveGroup?: number;
}

export interface MrqGroup {
  id: string;
  name: string;
  zones: MrqZone[];
  envelope?: MrqEnvelope;
  filter?: MrqFilter;
  modulation?: MrqModulation[];
}

export interface MrqPreset {
  id: string;
  name: string;
  groups: MrqGroup[];
}

export interface MrqMidiConfig {
  pitchBendRangeSemitones?: number;
  defaultChannel?: number;
  transposeSemitones?: number;
}

export type MrqSourceFormat =
  | 'sf2'
  | 'sf3'
  | 'sfz'
  | 'npno'
  | 'nsmp'
  | 'syx-dx7'
  | 'nki'
  | 'exs'
  | 'wav'
  | 'aiff'
  | 'flac'
  | 'mp3'
  | 'ogg'
  /** Ver `MrqSourceFormat::KontaktCapture` em model.rs — instrumento
   *  montado pelo fluxo "Kontakt Audio Capture" a partir de vários WAV. */
  | 'kontakt-capture';

export interface MrqInstrumentModel {
  name: string;
  sourceFormat: MrqSourceFormat;
  importedAt: string;
  presets: MrqPreset[];
  midi?: MrqMidiConfig;
}

export interface MrqSampleIndexEntry {
  id: string;
  relativeOffset: number;
  length: number;
  sha256: string;
  sampleRateHz: number;
  channels: number;
  bitsPerSampleOriginal?: number;
  bitsPerSampleEncoded: number;
  convertedFromFloat32: boolean;
  codec: string;
}

export interface MrqFileMetadata {
  formatVersion: number;
  instrument: MrqInstrumentModel;
  samples: MrqSampleIndexEntry[];
}

export interface MrqFinishResult {
  path: string;
  sampleCount: number;
}

export interface MrqSampleIntegrity {
  sampleId: string;
  ok: boolean;
}

export interface MrqIntegrityReport {
  globalOk: boolean;
  perSample: MrqSampleIntegrity[];
}

export interface MrqDecodedSample {
  sampleId: string;
  /** PCM Float32 intercalado, -1.0..1.0 — pronto pra virar AudioBuffer. */
  interleaved: Float32Array | number[];
  sampleRateHz: number;
  channels: number;
  bitsPerSampleEncoded: number;
}

/**
 * Converte um `MrqDecodedSample` (PCM Float32 intercalado, já decodificado
 * pelo backend Rust via `mrqExtractSample` — nunca decodificação de áudio
 * no WebView) num `AudioBuffer` tocável pela Web Audio API. Usado tanto
 * pela pré-escuta do MRQ Instrument Converter (InstrumentConverter.tsx,
 * MrqInstrumentAnalyzer.tsx) quanto pelo carregamento real de `.mrq` no
 * Rack (MrqLayerVoice.ts) — centralizado aqui pra não duplicar a mesma
 * cópia/desintercalação de amostra em três lugares.
 */
export function mrqDecodedSampleToAudioBuffer(ctx: BaseAudioContext, decoded: MrqDecodedSample): AudioBuffer {
  const frameCount = decoded.interleaved.length / decoded.channels;
  const buffer = ctx.createBuffer(decoded.channels, Math.max(1, frameCount), decoded.sampleRateHz);
  const src = decoded.interleaved instanceof Float32Array ? decoded.interleaved : Float32Array.from(decoded.interleaved);
  for (let ch = 0; ch < decoded.channels; ch += 1) {
    const channelData = buffer.getChannelData(ch);
    for (let i = 0; i < frameCount; i += 1) channelData[i] = src[i * decoded.channels + ch];
  }
  return buffer;
}

/** Entrada de amostra aceita por `mrqBuilderAddSample` — ver
 *  `MrqSampleSourceInput` em model.rs pro porquê das duas formas. */
export type MrqSampleSourceInput =
  | { kind: 'integerPcm'; bitsPerSample: number; interleaved: number[] | Int32Array }
  | { kind: 'float32'; interleaved: number[] | Float32Array; targetBitsPerSample?: number };

/** Formato estruturado de erro devolvido por qualquer comando `mrq_*` — ver
 *  `MrqError` em errors.rs. Sempre tem `kind`; os demais campos variam por
 *  variante (ver comentário em cada uso). */
export interface MrqError {
  kind: string;
  message?: string;
  found?: number;
  expected?: number;
  neededAtLeast?: number;
  available?: number;
  declared?: number | string;
  maxAllowed?: number;
  sampleId?: string;
  sessionId?: string;
  /** Só em `kind === 'metadataStreamMismatch'` — ver MrqError::MetadataStreamMismatch em errors.rs. */
  field?: string;
  /** Só em `kind === 'metadataStreamMismatch'` — valor real lido do STREAMINFO do FLAC. */
  actual?: string;
}

export function isMrqError(e: unknown): e is MrqError {
  return typeof e === 'object' && e !== null && typeof (e as { kind?: unknown }).kind === 'string';
}

// ---------------------------------------------------------------------------
// Relatório de compatibilidade — ver MrqCompatibilityReport em model.rs e a
// aba "Compatibility" do MRQ Instrument Analyzer (seção 7.1 do documento de
// arquitetura). Gerado de verdade por cada importador (a partir da Fase 3),
// nunca inventado.
// ---------------------------------------------------------------------------

export interface MrqCompatibilityItem {
  field: string;
  detail: string;
}

export interface MrqCompatibilityReport {
  preserved: MrqCompatibilityItem[];
  approximated: MrqCompatibilityItem[];
  unsupported: MrqCompatibilityItem[];
}

// ---------------------------------------------------------------------------
// Wrappers de invoke — nomes dos comandos Tauri em snake_case (ver
// src-tauri/src/mrq/commands.rs); API JS em camelCase, como o resto do
// projeto (ver tauriBridge.ts).
// ---------------------------------------------------------------------------

export function mrqBuilderBegin(finalPath: string, instrument: MrqInstrumentModel): Promise<string> {
  return invoke('mrq_builder_begin', { finalPath, instrument });
}

export function mrqBuilderAddSample(
  sessionId: string,
  sampleId: string,
  source: MrqSampleSourceInput,
  sampleRateHz: number,
  channels: number
): Promise<MrqSampleIndexEntry> {
  return invoke('mrq_builder_add_sample', { sessionId, sampleId, source, sampleRateHz, channels });
}

export function mrqBuilderFinish(sessionId: string): Promise<MrqFinishResult> {
  return invoke('mrq_builder_finish', { sessionId });
}

export function mrqBuilderAbort(sessionId: string): Promise<void> {
  return invoke('mrq_builder_abort', { sessionId });
}

export function mrqReadMetadata(path: string): Promise<MrqFileMetadata> {
  return invoke('mrq_read_metadata', { path });
}

export function mrqReadSampleIndex(path: string): Promise<MrqSampleIndexEntry[]> {
  return invoke('mrq_read_sample_index', { path });
}

export function mrqExtractSample(path: string, sampleId: string): Promise<MrqDecodedSample> {
  return invoke('mrq_extract_sample', { path, sampleId });
}

export function mrqValidateIntegrity(path: string): Promise<MrqIntegrityReport> {
  return invoke('mrq_validate_integrity', { path });
}

// ---------------------------------------------------------------------------
// Importador SF2/SF3 (Fase 3, ver src-tauri/src/importers/sf2.rs). Espelha
// `Sf2InspectionResult`/`Sf2ConversionResult` de
// src-tauri/src/importers/commands.rs.
// ---------------------------------------------------------------------------

export interface Sf2InspectionResult {
  instrument: MrqInstrumentModel;
  compatibility: MrqCompatibilityReport;
}

export interface Sf2ConversionResult {
  finish: MrqFinishResult;
  compatibility: MrqCompatibilityReport;
}

/** Só faz o parsing estrutural (sem decodificar áudio) — rápido, pra inspeção/preview. */
export function mrqInspectSf2(path: string): Promise<Sf2InspectionResult> {
  return invoke('mrq_inspect_sf2', { path });
}

/** Converte um SF2/SF3 inteiro (estrutura + áudio) pra um `.mrq` em `destPath`. */
export function mrqConvertSf2ToMrq(sourcePath: string, destPath: string): Promise<Sf2ConversionResult> {
  return invoke('mrq_convert_sf2_to_mrq', { sourcePath, destPath });
}

// ---------------------------------------------------------------------------
// Importador NPNO/NSMP (Fase 4, ver src-tauri/src/importers/npno.rs). Um
// único comando cobre tanto biblioteca de piano (.npno) quanto amostra
// (.nsmp/.nsmp3/.nsmp4) — espelha `NpnoInspectionResult`/`NpnoConversionResult`
// de src-tauri/src/importers/commands.rs.
// ---------------------------------------------------------------------------

export interface NpnoInspectionResult {
  instrument: MrqInstrumentModel;
  compatibility: MrqCompatibilityReport;
}

export interface NpnoConversionResult {
  finish: MrqFinishResult;
  compatibility: MrqCompatibilityReport;
}

/** Só faz o parsing estrutural (sem decodificar o áudio pesado do .npno) — rápido, pra inspeção/preview. */
export function mrqInspectNpno(path: string): Promise<NpnoInspectionResult> {
  return invoke('mrq_inspect_npno', { path });
}

/** Converte um .npno/.nsmp/.nsmp3/.nsmp4 inteiro (estrutura + áudio) pra um `.mrq` em `destPath`. */
export function mrqConvertNpnoToMrq(sourcePath: string, destPath: string): Promise<NpnoConversionResult> {
  return invoke('mrq_convert_npno_to_mrq', { sourcePath, destPath });
}

// ---------------------------------------------------------------------------
// Importador de arquivo de áudio avulso — WAV/AIFF/FLAC/MP3/OGG (Fase 7,
// ver src-tauri/src/importers/audio_file.rs, decodificado via `symphonia`
// no backend). Um único comando cobre os 5 formatos — espelha
// `AudioFileInspectionResult`/`AudioFileConversionResult` de
// src-tauri/src/importers/commands.rs.
// ---------------------------------------------------------------------------

export interface AudioFileInspectionResult {
  instrument: MrqInstrumentModel;
  compatibility: MrqCompatibilityReport;
}

export interface AudioFileConversionResult {
  finish: MrqFinishResult;
  compatibility: MrqCompatibilityReport;
}

/**
 * Faz o parsing + decodificação completa do áudio (um arquivo avulso não
 * tem como separar "estrutura" de "áudio" — é só uma gravação) e devolve
 * junto o relatório de compatibilidade. Gera sempre UM preset/UM grupo/UMA
 * zona cobrindo o teclado inteiro, com a raiz fixa em C4 (ver nota em
 * `audio_file.rs`).
 */
export function mrqInspectAudioFile(path: string): Promise<AudioFileInspectionResult> {
  return invoke('mrq_inspect_audio_file', { path });
}

/** Converte um .wav/.aiff/.flac/.mp3/.ogg inteiro pra um `.mrq` em `destPath`. */
export function mrqConvertAudioFileToMrq(sourcePath: string, destPath: string): Promise<AudioFileConversionResult> {
  return invoke('mrq_convert_audio_file_to_mrq', { sourcePath, destPath });
}
