import type { RackPresetOption } from '../../../shared/types';
import { loadNordWasmModule } from './npnoWasmModule';

const ATTACK_SEC = 0.003;
const RELEASE_SEC = 0.12;

interface NsmpZoneMeta {
  root_key: number;
  top_note: number;
  low_note: number | null;
  channels: number;
  frames: number;
  offset: number;
  length: number;
}

interface NsmpMeta {
  name: string;
  generation: string; // "nsmp" | "nsmp3" | "nsmp4"
  sample_rate: number;
  zones: NsmpZoneMeta[];
  skipped: number;
}

interface Zone {
  rootKey: number;
  topNote: number;
  lowNote: number | null;
  buffer: AudioBuffer;
}

/**
 * Camada "Piano Nord (amostra) / .nsmp": decodifica de verdade um arquivo de
 * amostra da Nord Sample Library (`.nsmp`, `.nsmp3` ou `.nsmp4` — as três
 * gerações usadas por Stage/Electro/Piano/Wave/Grand) usando o MESMO crate
 * Rust `nord-format` já usado para o `.npno` (ver NpnoLayerVoice.ts e
 * native/npno-wasm/). Diferente do `.npno` (bibliotecas de piano, com bancos
 * ataque/ressonância/liberação e várias camadas de velocidade por tecla), o
 * `.nsmp` guarda um conjunto de "zonas" — faixas de notas, cada uma com uma
 * única amostra gravada — sem camadas de velocidade por tecla; a dinâmica
 * real vem só do volume (como num sampler comum).
 */
export class NsmpLayerVoice {
  private ctx: AudioContext;
  private zones: Zone[] = [];
  private active = new Map<number, { src: AudioBufferSourceNode; gain: GainNode; baseRate: number }>();
  private bendSemitones = 0;
  private name = '';
  private generation = '';
  readonly output: GainNode;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.output = ctx.createGain();
  }

  /** Nome#Geração lido do próprio arquivo, pra mostrar como "instrumento" carregado. */
  get libraryName(): string {
    return this.name ? `${this.name} #${this.generation}` : this.generation;
  }

  async load(buffer: ArrayBuffer): Promise<RackPresetOption[]> {
    this.dispose();
    const mod = await loadNordWasmModule();
    const bytes = new Uint8Array(buffer);
    let decoded: { metadata_json: string; pcm: Uint8Array };
    try {
      decoded = mod.nsmp_decode(bytes);
    } catch (err) {
      throw new Error(
        `Não foi possível decodificar este arquivo de amostra Nord (${String(err)}). O decodificador ` +
          'cobre o layout conhecido das gerações nsmp/nsmp3/nsmp4; um arquivo de uma variante ainda não ' +
          'catalogada pode não ser reconhecido.'
      );
    }
    const meta: NsmpMeta = JSON.parse(decoded.metadata_json);
    const pcmBuffer = decoded.pcm.buffer.slice(
      decoded.pcm.byteOffset,
      decoded.pcm.byteOffset + decoded.pcm.byteLength
    ) as ArrayBuffer;

    this.name = meta.name;
    this.generation = meta.generation;

    for (const zone of meta.zones) {
      const int16 = new Int16Array(pcmBuffer, zone.offset, zone.length / 2);
      const frames = zone.frames;
      const channels = Math.max(1, zone.channels);
      const audioBuffer = this.ctx.createBuffer(channels, frames, meta.sample_rate);
      for (let ch = 0; ch < channels; ch++) {
        const data = audioBuffer.getChannelData(ch);
        for (let i = 0; i < frames; i++) {
          data[i] = int16[i * channels + ch] / 32768;
        }
      }
      this.zones.push({ rootKey: zone.root_key, topNote: zone.top_note, lowNote: zone.low_note, buffer: audioBuffer });
    }
    // Zonas se referem umas às outras pelo topo (quando low_note não vem no
    // arquivo, a zona cobre de "um acima do topo da zona anterior" até o
    // próprio topo) — por isso a ordem ascendente de topNote importa pra
    // achar a zona certa em findZone() abaixo.
    this.zones.sort((a, b) => a.topNote - b.topNote);

    if (meta.skipped > 0) {
      console.warn(`[nsmp] ${meta.skipped} zona(s) desta amostra não puderam ser decodificadas e ficarão mudas.`);
    }
    if (this.zones.length === 0) {
      throw new Error('Este arquivo de amostra Nord não tem nenhuma zona decodificável — talvez seja uma variante ainda não coberta.');
    }

    return [{ value: 'default', label: this.libraryName || 'Amostra Nord' }];
  }

  /** Acha a zona que responde por uma tecla MIDI, ou null se a tecla estiver acima da zona mais aguda ou num vão sem cobertura. */
  private findZone(note: number): Zone | null {
    for (const zone of this.zones) {
      if (note > zone.topNote) continue;
      if (zone.lowNote !== null && note < zone.lowNote) return null; // vão sem cobertura entre zonas (gerações v3/v4)
      return zone;
    }
    return null; // acima da zona mais aguda: nota muda, sem "clamp" (confirmado em hardware pelo próprio formato)
  }

  noteOn(note: number, velocity: number) {
    this.stopNote(note, 0.008);
    const zone = this.findZone(note);
    if (!zone) return;

    const src = this.ctx.createBufferSource();
    src.buffer = zone.buffer;
    const baseRate = Math.pow(2, (note - zone.rootKey) / 12);
    src.playbackRate.value = baseRate * Math.pow(2, this.bendSemitones / 12);
    const gain = this.ctx.createGain();
    const now = this.ctx.currentTime;
    const target = Math.max(0, Math.min(1, velocity / 127));
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(target, now + ATTACK_SEC);
    src.connect(gain);
    gain.connect(this.output);
    src.start();
    src.onended = () => {
      try {
        gain.disconnect();
      } catch {
        /* já desconectado */
      }
    };
    this.active.set(note, { src, gain, baseRate });
  }

  noteOff(note: number) {
    this.stopNote(note, RELEASE_SEC);
  }

  /** Pitch bend em semitons (ver RackEngine.PITCH_BEND_RANGE_SEMITONES), aplicado às notas já soando. */
  setPitchBend(semitones: number) {
    this.bendSemitones = semitones;
    const now = this.ctx.currentTime;
    const bendFactor = Math.pow(2, semitones / 12);
    for (const voice of this.active.values()) {
      voice.src.playbackRate.setTargetAtTime(voice.baseRate * bendFactor, now, 0.01);
    }
  }

  private stopNote(note: number, fadeSec: number) {
    const voice = this.active.get(note);
    if (!voice) return;
    this.active.delete(note);
    const now = this.ctx.currentTime;
    try {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
      voice.gain.gain.linearRampToValueAtTime(0, now + fadeSec);
      voice.src.stop(now + fadeSec + 0.02);
    } catch {
      /* fonte já parada */
    }
  }

  allNotesOff() {
    for (const note of Array.from(this.active.keys())) this.stopNote(note, 0.05);
  }

  dispose() {
    this.allNotesOff();
    this.zones = [];
  }
}

/** Confere rapidamente se os bytes parecem uma amostra Nord (.nsmp/.nsmp3/.nsmp4) válida, sem decodificar áudio. */
export async function sniffNsmp(buffer: ArrayBuffer): Promise<string> {
  const mod = await loadNordWasmModule();
  return mod.nsmp_sniff(new Uint8Array(buffer));
}
