import type { RackPresetOption } from '../../../shared/types';
import { loadNordWasmModule } from './npnoWasmModule';

const loadWasmModule = loadNordWasmModule;

const UNCOVERED = 0xff;
/** Maior valor de camada que uma velocidade qualquer ainda toca; acima disso a
 *  camada nunca soa (ver `encode::HIGHEST_PLAYED_LAYER` no nord-format). */
const HIGHEST_PLAYED_LAYER = Math.floor((127 - 1) * 31 / 127);

interface StrokeMeta {
  root: number;
  bank: string; // 'attack' | 'resonance' | 'release' | 'unknown_N'
  layer: number;
  channels: number;
  frames: number;
  offset: number;
  length: number;
}

interface LibraryMeta {
  name: string;
  variant: string;
  channels: number;
  sample_rate: number;
  key_map: number[];
  strokes: StrokeMeta[];
  skipped: number;
}

interface RootStrokes {
  /** strokes de ataque deste root, por ordem decrescente de "layer" (mais 0 = mais forte primeiro) */
  attack: { layer: number; buffer: AudioBuffer }[];
  release: { layer: number; buffer: AudioBuffer }[];
}

const ATTACK_FADE_SEC = 0.002;
const RELEASE_FADE_SEC = 0.06;

/**
 * Camada "Piano Nord / .npno": decodifica de verdade uma biblioteca de piano
 * Nord (formato fechado e não documentado oficialmente pela Clavia) usando o
 * crate Rust `nord-format` (BSD-3-Clause, projeto comunitário não afiliado à
 * Clavia, compilado para WebAssembly — ver native/npno-wasm/). Cada "stroke"
 * (uma nota gravada de verdade, em um banco ataque/ressonância/liberação e
 * camada de intensidade) é decodificado para PCM de 16 bits pelo codec
 * proprietário reverso-geredenharizado da própria lib, e tocado como um
 * `AudioBuffer`. O mapeamento tecla→raiz e a seleção de camada por velocidade
 * seguem exatamente as regras documentadas pelo nord-format como confirmadas
 * em hardware real (ver comentários abaixo).
 *
 * Limitação honesta: o "release trigger" (a camada de banco "release", tocada
 * ao soltar a tecla) não é reproduzido aqui — tocamos apenas o banco "attack"
 * no note-on; sem acesso a uma Nord física para validar o comportamento exato
 * de blend ataque/liberação, preferimos não arriscar um resultado incorreto.
 * Isso é uma simplificação documentada, não uma substituição do formato.
 */
export class NpnoLayerVoice {
  private ctx: AudioContext;
  private rootMap = new Map<number, RootStrokes>();
  private keyMap: number[] = [];
  private active = new Map<number, { src: AudioBufferSourceNode; gain: GainNode; baseRate: number }>();
  private bendSemitones = 0;
  private libName = '';
  readonly output: GainNode;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.output = ctx.createGain();
  }

  /** Nome#Variante lido do próprio arquivo, pra mostrar como "instrumento" carregado. */
  get libraryName(): string {
    return this.libName;
  }

  async load(buffer: ArrayBuffer): Promise<RackPresetOption[]> {
    this.dispose();
    const mod = await loadWasmModule();
    const bytes = new Uint8Array(buffer);
    let decoded: { metadata_json: string; pcm: Uint8Array };
    try {
      decoded = mod.npno_decode(bytes);
    } catch (err) {
      throw new Error(
        `Não foi possível decodificar este .npno (${String(err)}). O decodificador cobre o layout ` +
          'conhecido das bibliotecas de piano Nord; um arquivo de outra geração/variante pode não ' +
          'ser reconhecido ainda.'
      );
    }
    const meta: LibraryMeta = JSON.parse(decoded.metadata_json);
    const pcmBuffer = decoded.pcm.buffer.slice(
      decoded.pcm.byteOffset,
      decoded.pcm.byteOffset + decoded.pcm.byteLength
    ) as ArrayBuffer;

    this.keyMap = meta.key_map;
    this.libName = [meta.name, meta.variant].filter(Boolean).join(' #');

    for (const stroke of meta.strokes) {
      if (stroke.bank !== 'attack' && stroke.bank !== 'release') continue; // 'resonance' (pedal baixado) fica pra uma iteração futura
      const int16 = new Int16Array(pcmBuffer, stroke.offset, stroke.length / 2);
      const frames = stroke.frames;
      const channels = Math.max(1, stroke.channels);
      const audioBuffer = this.ctx.createBuffer(channels, frames, meta.sample_rate);
      for (let ch = 0; ch < channels; ch++) {
        const data = audioBuffer.getChannelData(ch);
        for (let i = 0; i < frames; i++) {
          data[i] = int16[i * channels + ch] / 32768;
        }
      }
      let entry = this.rootMap.get(stroke.root);
      if (!entry) {
        entry = { attack: [], release: [] };
        this.rootMap.set(stroke.root, entry);
      }
      const list = stroke.bank === 'attack' ? entry.attack : entry.release;
      list.push({ layer: stroke.layer, buffer: audioBuffer });
    }
    for (const entry of this.rootMap.values()) {
      entry.attack.sort((a, b) => a.layer - b.layer);
      entry.release.sort((a, b) => a.layer - b.layer);
    }

    if (meta.skipped > 0) {
      console.warn(`[npno] ${meta.skipped} stroke(s) desta biblioteca não puderam ser decodificados e ficarão mudos.`);
    }
    if (this.rootMap.size === 0) {
      throw new Error('Este .npno não tem nenhuma nota de ataque decodificável — talvez seja uma variante não coberta ainda.');
    }

    // Única "preset": o piano inteiro já carregado (bibliotecas Nord não têm sub-presets).
    return [{ value: 'default', label: this.libName || 'Piano Nord' }];
  }

  /** Raiz coberta mais próxima da tecla pedida, pra tocar algo mesmo fora do key_map exato. */
  private nearestCoveredRoot(note: number): number | null {
    if (this.rootMap.size === 0) return null;
    let best: number | null = null;
    let bestDist = Infinity;
    for (const root of this.rootMap.keys()) {
      const dist = Math.abs(root - note);
      if (dist < bestDist) {
        bestDist = dist;
        best = root;
      }
    }
    return best;
  }

  /** Mesma fórmula do nord-format: a maior camada <= (127-velocidade)*31/127 toca. */
  private pickLayer(list: { layer: number; buffer: AudioBuffer }[], velocity: number): AudioBuffer | null {
    if (list.length === 0) return null;
    const bound = Math.min(HIGHEST_PLAYED_LAYER, Math.round(((127 - velocity) * 31) / 127));
    let chosen: { layer: number; buffer: AudioBuffer } | null = null;
    for (const item of list) {
      if (item.layer <= bound && (!chosen || item.layer > chosen.layer)) chosen = item;
    }
    return (chosen ?? list[0]).buffer;
  }

  noteOn(note: number, velocity: number) {
    this.stopNote(note, 0.008);
    let root = this.keyMap[note];
    if (root === undefined || root === UNCOVERED) {
      const nearest = this.nearestCoveredRoot(note);
      if (nearest === null) return;
      root = nearest;
    }
    const entry = this.rootMap.get(root);
    if (!entry) return;
    const buffer = this.pickLayer(entry.attack, velocity);
    if (!buffer) return;

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const baseRate = Math.pow(2, (note - root) / 12);
    src.playbackRate.value = baseRate * Math.pow(2, this.bendSemitones / 12);
    const gain = this.ctx.createGain();
    const now = this.ctx.currentTime;
    const target = Math.max(0, Math.min(1, velocity / 127));
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(target, now + ATTACK_FADE_SEC);
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
    this.stopNote(note, RELEASE_FADE_SEC);
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
    this.rootMap.clear();
    this.keyMap = [];
  }
}

/** Confere rapidamente se os bytes parecem um .npno válido, sem decodificar áudio. */
export async function sniffNpno(buffer: ArrayBuffer): Promise<string> {
  const mod = await loadWasmModule();
  return mod.npno_sniff(new Uint8Array(buffer));
}
