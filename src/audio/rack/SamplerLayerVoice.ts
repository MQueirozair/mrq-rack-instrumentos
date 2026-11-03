const ATTACK_SEC = 0.003;
const RELEASE_SEC = 0.12;

/**
 * Camada "Piano / Amostra": toca um único arquivo de áudio do próprio usuário
 * (.wav/.aiff/.flac/.ogg/.mp3), reamostrado pela taxa de reprodução pra cada
 * tecla a partir de uma nota raiz configurável. É uma opção independente —
 * para bibliotecas de piano Nord reais (.npno), ver NpnoLayerVoice.ts.
 */
export class SamplerLayerVoice {
  private ctx: AudioContext;
  private buffer: AudioBuffer | null = null;
  private rootNote = 60;
  /** baseRate = razão de playbackRate só pela tecla (sem pitch bend); o valor de fato aplicado é baseRate * bendFactor */
  private active = new Map<number, { src: AudioBufferSourceNode; gain: GainNode; baseRate: number }>();
  private bendSemitones = 0;
  readonly output: GainNode;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.output = ctx.createGain();
  }

  async load(buffer: ArrayBuffer, rootNote = 60): Promise<void> {
    this.dispose();
    this.buffer = await this.ctx.decodeAudioData(buffer.slice(0));
    this.rootNote = rootNote;
  }

  setRootNote(note: number) {
    this.rootNote = note;
  }

  noteOn(note: number, velocity: number) {
    if (!this.buffer) return;
    this.stopNote(note, 0.01);
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    const baseRate = Math.pow(2, (note - this.rootNote) / 12);
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
    this.buffer = null;
  }
}
