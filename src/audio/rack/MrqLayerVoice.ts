import type { RackPresetOption } from '../../../shared/types';
import { isTauriRuntime } from '../../runtimeEnv';
import {
  mrqDecodedSampleToAudioBuffer,
  mrqExtractSample,
  mrqReadMetadata,
  type MrqGroup,
  type MrqPreset,
  type MrqZone,
} from './mrqFormat';

const ATTACK_SEC = 0.003;
const RELEASE_SEC = 0.12;
/** Quantas amostras decodificar em paralelo (invoke Tauri -> Rust ->
 *  mrq_extract_sample) ao carregar um `.mrq`. Um instrumento orquestral
 *  real pode ter centenas de amostras; decodificar uma de cada vez seria
 *  lento só pelo overhead de ida-e-volta da ponte IPC, mas disparar todas
 *  de uma vez arriscaria sobrecarregar o backend (cada uma envolve
 *  descompactar FLAC). Um limite fixo e moderado é o meio-termo mais
 *  seguro sem precisar medir hardware do usuário. */
const SAMPLE_DECODE_CONCURRENCY = 6;

interface ResolvedZone extends MrqZone {
  buffer: AudioBuffer;
}

interface ResolvedPreset {
  name: string;
  /** Zonas de TODOS os grupos do preset já achatadas — grupos dentro de um
   *  preset `.mrq` são só uma camada organizacional (ex.: camadas de
   *  velocity/round-robin do SF2 de origem), não algo selecionável à parte
   *  pelo usuário; isso espelha exatamente como MrqiLayerVoice/NkiLayerVoice
   *  tratam seus "grupos" — todas as zonas do item selecionado tocam juntas. */
  zones: ResolvedZone[];
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/** Forma mínima exigida pra participar da seleção de round robin — qualquer
 *  objeto com esses dois campos serve (não precisa ser uma `ResolvedZone`
 *  completa), o que permite testar esta função isoladamente em Node puro,
 *  sem AudioContext nem AudioBuffer (ver scripts/test-mrq-rack-layer.mjs). */
export interface RoundRobinCandidate {
  roundRobinGroup?: string;
  roundRobinIndex?: number;
}

/**
 * Entre as zonas candidatas pra uma nota, zonas SEM `roundRobinGroup` tocam
 * sempre (comportamento de sempre); zonas que COMPARTILHAM o mesmo
 * `roundRobinGroup` alternam entre si (uma por disparo, na ordem de
 * `roundRobinIndex`) em vez de tocarem todas empilhadas — senão um
 * instrumento com round robin de verdade soaria "grosso"/fora de caráter,
 * tocando todas as variações de uma vez a cada nota. `counters` é mutado
 * (avança o "próximo da vez" de cada grupo) — passe o mesmo Map entre
 * chamadas sucessivas pra round robin de verdade alternar nota após nota.
 */
export function selectRoundRobinZones<T extends RoundRobinCandidate>(candidates: T[], counters: Map<string, number>): T[] {
  const byGroup = new Map<string, T[]>();
  const result: T[] = [];
  for (const zone of candidates) {
    if (!zone.roundRobinGroup) {
      result.push(zone);
      continue;
    }
    const list = byGroup.get(zone.roundRobinGroup) ?? [];
    list.push(zone);
    byGroup.set(zone.roundRobinGroup, list);
  }
  for (const [groupId, list] of byGroup) {
    list.sort((a, b) => (a.roundRobinIndex ?? 0) - (b.roundRobinIndex ?? 0));
    const turn = counters.get(groupId) ?? 0;
    counters.set(groupId, turn + 1);
    result.push(list[turn % list.length]);
  }
  return result;
}

/**
 * `zone.pan` é o valor "declarado" pela fonte original — mas um par estéreo
 * vindo de um SF2 (`stereo: 'left'/'right'`, duas amostras MONO separadas
 * que juntas formam a imagem estéreo) normalmente declara pan=0 nos dois
 * lados, porque a separação estéreo deveria vir de cada lado ser roteado
 * pro canal certo, não do pan. Só força o pan pro extremo quando a amostra
 * resolvida é realmente mono (`channels === 1`) — uma amostra já estéreo (2
 * canais) é tocada como está, respeitando `zone.pan` normal.
 */
export function effectiveStereoPan(pan: number, stereo: MrqZone['stereo'], channels: number): number {
  if (channels === 1) {
    if (stereo === 'left') return -1;
    if (stereo === 'right') return 1;
  }
  return pan;
}

/**
 * Camada ".mrq" (Fase 9 do MRQ Instrument Converter, ver
 * docs/mrq-instrument-converter/mrq-converter-architecture.md §8) — carrega no Rack um instrumento
 * já convertido pra `.mrq` (originalmente SF2/SF3, NPNO/NSMP, SYX, NKI ou
 * um arquivo de áudio avulso, ver mrqFormat.ts). Diferente de MrqiLayerVoice
 * (que desempacota PCM cru em memória, tudo em JS puro), aqui CADA amostra é
 * decodificada de verdade pelo backend Rust (`mrq_extract_sample`, que lê o
 * FLAC gravado dentro do `.mrq` e devolve PCM Float32) — nenhuma
 * decodificação de áudio roda no WebView, igual ao resto do MRQ Instrument
 * Converter. Isso só funciona dentro do Tauri: sem equivalente no build
 * Electron legado (ver runtimeEnv.ts).
 *
 * Igual a MrqiLayerVoice/NkiLayerVoice/Sf2LayerVoice (a própria camada SF2
 * nativa do Rack), esta classe NÃO implementa envelope ADSR nem filtro
 * próprios — isso continua sendo tratado de forma genérica e uniforme pelo
 * próprio RackEngine (LayerEnvelopeSettings/LayerFilterSettings), igual pra
 * todo formato de camada.
 *
 * Importante (revisão técnica pós-Fase 10, item "ExclusiveGroup"): o
 * `exclusiveGroup`/"choke" do modelo `.mrq` (preenchido pelo importador SF2
 * a partir do `ExclusiveClass`, ver src-tauri/src/importers/sf2.rs e o
 * relatório de compatibilidade, que marca isso como `Approximated`) NÃO é
 * aplicado em lugar NENHUM do app hoje — não é "tratado genericamente pelo
 * RackEngine" como envelope/filtro são. O campo chega íntegro até aqui (dá
 * pra ver no Analyzer, aba Grupos & zonas) mas esta classe o ignora
 * silenciosamente de propósito: tocar uma nova zona do mesmo grupo de
 * exclusividade NÃO interrompe vozes ativas de outras zonas desse mesmo
 * grupo (o comportamento real de um "choke group" de sampler). Isso é uma
 * limitação conhecida e documentada, não um bug silencioso — consertar
 * exigiria o RackEngine saber agrupar vozes ativas por `exclusiveGroup` e
 * encerrar as antigas no `noteOn` de uma nova, o que ainda não existe em
 * nenhuma camada deste Rack (nem SF2 nativo, nem NKI, nem `.mrqi`).
 *
 * O que ESTA classe implementa de verdade, por ser dado real específico do
 * modelo `.mrq` que nenhuma outra camada tinha antes:
 *  - round robin (`roundRobinGroup`/`roundRobinIndex`): zonas do mesmo grupo
 *    de round robin alternam entre si a cada nota, em vez de tocarem todas
 *    empilhadas (hoje nenhum importador deste app preenche esse campo — fica
 *    pronto pra quando algum `.mrq` externo ou futuro importador preencher);
 *  - pares estéreo SF2 (`stereo: 'left'/'right'` numa amostra mono): sem
 *    isso, um piano/pad estéreo importado de um SF2 tocaria os dois lados
 *    centralizados, perdendo a imagem estéreo — aqui cada lado vai pro
 *    canal certo quando a amostra decodificada é mono.
 */
export class MrqLayerVoice {
  private ctx: AudioContext;
  private presets: ResolvedPreset[] = [];
  private zones: ResolvedZone[] = [];
  private roundRobinCounters = new Map<string, number>();
  private active = new Map<number, { src: AudioBufferSourceNode; gain: GainNode; baseRate: number }[]>();
  private bendSemitones = 0;
  private instrumentName = '';
  readonly output: GainNode;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.output = ctx.createGain();
  }

  get name(): string {
    return this.instrumentName;
  }

  async load(_buffer: ArrayBuffer, sourcePath?: string): Promise<RackPresetOption[]> {
    this.dispose();
    if (!isTauriRuntime()) {
      throw new Error('Arquivos .mrq só podem ser abertos na versão Tauri do MRQ - Multitracks Play (recurso novo, sem equivalente na versão Electron).');
    }
    if (!sourcePath) {
      throw new Error('Não foi possível determinar o caminho do arquivo .mrq no disco (necessário pra ler as amostras via o backend Rust).');
    }

    const metadata = await mrqReadMetadata(sourcePath);
    this.instrumentName = metadata.instrument.name || sourcePath.split(/[\\/]/).pop() || '';

    const sampleIds = new Set<string>();
    for (const preset of metadata.instrument.presets) {
      for (const group of preset.groups) {
        for (const zone of group.zones) sampleIds.add(zone.sampleId);
      }
    }

    const buffers = new Map<string, AudioBuffer>();
    const failures: string[] = [];
    await mapWithConcurrency([...sampleIds], SAMPLE_DECODE_CONCURRENCY, async (sampleId) => {
      try {
        const decoded = await mrqExtractSample(sourcePath, sampleId);
        buffers.set(sampleId, mrqDecodedSampleToAudioBuffer(this.ctx, decoded));
      } catch (err) {
        failures.push(sampleId);
        logMrqLayerError(`falha ao decodificar a amostra "${sampleId}" de "${sourcePath}"`, err);
      }
    });

    this.presets = metadata.instrument.presets
      .map((preset: MrqPreset) => ({
        name: preset.name,
        zones: flattenGroups(preset.groups, buffers),
      }))
      .filter((p) => p.zones.length > 0);

    if (this.presets.length === 0) {
      throw new Error(
        buffers.size === 0
          ? 'Nenhuma amostra deste .mrq pôde ser decodificada (arquivo corrompido ou incompatível).'
          : 'Este .mrq não tem nenhuma zona com amostra resolvida.'
      );
    }
    if (failures.length > 0) {
      console.warn(`[mrq] ${failures.length} amostra(s) não puderam ser decodificadas e ficarão mudas: ${failures.join(', ')}`);
    }

    this.zones = this.presets[0].zones;

    if (this.presets.length > 1) {
      return this.presets.map((p, i) => ({ value: String(i), label: p.name || `Preset ${i + 1}` }));
    }
    return [{ value: 'default', label: this.instrumentName || this.presets[0].name || 'Instrumento' }];
  }

  selectPreset(value: string) {
    if (this.presets.length <= 1) return;
    const idx = Number(value);
    const preset = Number.isFinite(idx) ? this.presets[idx] : undefined;
    if (preset) this.zones = preset.zones;
  }

  private zonesFor(note: number, velocity: number): ResolvedZone[] {
    const matches = this.zones.filter(
      (z) => note >= z.loKey && note <= z.hiKey && velocity >= z.loVel && velocity <= z.hiVel
    );
    const candidates = matches.length > 0 ? matches : this.zones.filter((z) => note >= z.loKey && note <= z.hiKey);
    return selectRoundRobinZones(candidates, this.roundRobinCounters);
  }

  noteOn(note: number, velocity: number) {
    this.stopNote(note, 0.01);
    const zones = this.zonesFor(note, velocity);
    if (zones.length === 0) return;
    const voices: { src: AudioBufferSourceNode; gain: GainNode; baseRate: number }[] = [];
    const now = this.ctx.currentTime;
    for (const zone of zones) {
      const src = this.ctx.createBufferSource();
      src.buffer = zone.buffer;
      if (zone.loopEnabled && zone.loopStart != null && zone.loopEnd != null && zone.loopEnd > zone.loopStart) {
        src.loop = true;
        src.loopStart = zone.loopStart / zone.buffer.sampleRate;
        src.loopEnd = zone.loopEnd / zone.buffer.sampleRate;
      }
      const baseRate = Math.pow(2, (note - zone.rootNote + zone.tuneCents / 100) / 12);
      src.playbackRate.value = baseRate * Math.pow(2, this.bendSemitones / 12);
      const gain = this.ctx.createGain();
      // volumeDb é em decibéis (não um ganho linear 0..1 como nas outras
      // camadas) — converte pra linear antes de combinar com a velocity.
      const linearVolume = Math.pow(10, zone.volumeDb / 20);
      const target = Math.max(0, (velocity / 127) * linearVolume);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(target, now + ATTACK_SEC);
      let node: AudioNode = gain;
      const pan = effectiveStereoPan(zone.pan, zone.stereo, zone.buffer.numberOfChannels);
      if (pan) {
        const panner = this.ctx.createStereoPanner();
        panner.pan.value = Math.max(-1, Math.min(1, pan));
        gain.connect(panner);
        node = panner;
      }
      node.connect(this.output);
      src.connect(gain);
      src.start();
      src.onended = () => {
        try {
          gain.disconnect();
        } catch {
          /* já desconectado */
        }
      };
      voices.push({ src, gain, baseRate });
    }
    if (voices.length > 0) this.active.set(note, voices);
  }

  noteOff(note: number) {
    this.stopNote(note, RELEASE_SEC);
  }

  setPitchBend(semitones: number) {
    this.bendSemitones = semitones;
    const now = this.ctx.currentTime;
    const bendFactor = Math.pow(2, semitones / 12);
    for (const voices of this.active.values()) {
      for (const voice of voices) voice.src.playbackRate.setTargetAtTime(voice.baseRate * bendFactor, now, 0.01);
    }
  }

  private stopNote(note: number, fadeSec: number) {
    const voices = this.active.get(note);
    if (!voices) return;
    this.active.delete(note);
    const now = this.ctx.currentTime;
    for (const voice of voices) {
      try {
        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
        voice.gain.gain.linearRampToValueAtTime(0, now + fadeSec);
        voice.src.stop(now + fadeSec + 0.02);
      } catch {
        /* fonte já parada */
      }
    }
  }

  allNotesOff() {
    for (const note of Array.from(this.active.keys())) this.stopNote(note, 0.05);
  }

  dispose() {
    this.allNotesOff();
    this.presets = [];
    this.zones = [];
    this.roundRobinCounters.clear();
  }
}

function flattenGroups(groups: MrqGroup[], buffers: Map<string, AudioBuffer>): ResolvedZone[] {
  const zones: ResolvedZone[] = [];
  for (const group of groups) {
    for (const zone of group.zones) {
      const buffer = buffers.get(zone.sampleId);
      if (buffer) zones.push({ ...zone, buffer });
    }
  }
  return zones;
}

function logMrqLayerError(context: string, err: unknown) {
  const e = err instanceof Error ? err : new Error(String(err));
  console.error(`[MrqLayerVoice] ${context}:`, e);
  try {
    void window.api?.log?.append?.(`[MrqLayerVoice] ${context}: ${e.name}: ${e.message}\n${e.stack ?? ''}`);
  } catch {
    /* noop */
  }
}
