import type { AudioEngine } from './AudioEngine';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function noteFrequency(note: string, octave = 3): number {
  const idx = NOTE_NAMES.indexOf(note);
  if (idx < 0) return 220;
  const midi = (octave + 1) * 12 + idx;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Pad contínuo sintetizado: dois osciladores desafinados + filtro, com crossfade
 * suave ao trocar de tom e fade in/out configuráveis. A saída passa por um
 * LFO lento no corte do filtro ("respiração") cujo período é configurável
 * via "Emenda da repetição" — dá um leve movimento ao pad em vez de ficar
 * 100% estático, já que (ao contrário de um pad por amostra de áudio) este
 * motor não tem nenhum ponto de loop/emenda real pra suavizar.
 */
export class PadEngine {
  private ctx: AudioContext;
  private engineRef: AudioEngine;
  private output: GainNode;
  private voices: { osc1: OscillatorNode; osc2: OscillatorNode; gain: GainNode; filter: BiquadFilterNode; lfo: OscillatorNode; lfoGain: GainNode }[] = [];
  private isOn = false;
  private currentOutputId = 'with-song';
  private breatheSec = 6;

  constructor(engineRef: AudioEngine) {
    this.engineRef = engineRef;
    this.ctx = engineRef.ctx;
    this.output = this.ctx.createGain();
    this.output.gain.value = 0.5;
    this.setOutput(this.currentOutputId);
  }

  setVolumeDb(db: number) {
    this.output.gain.setTargetAtTime(Math.pow(10, db / 20), this.ctx.currentTime, 0.05);
  }

  /** Troca pra onde o pad é enviado (junto com a música, ou numa saída separada) sem interromper o som. */
  setOutput(outputId: string) {
    this.currentOutputId = outputId;
    try { this.output.disconnect(); } catch { /* ainda não conectado */ }
    this.engineRef.connectMonoToOutput(this.output, outputId);
  }

  /** Duração (em segundos) do ciclo de "respiração" do pad — ver docstring da classe. */
  setBreatheSeconds(sec: number) {
    this.breatheSec = Math.max(1, sec);
    for (const v of this.voices) v.lfo.frequency.setTargetAtTime(1 / this.breatheSec, this.ctx.currentTime, 0.2);
  }

  start(note: string, fadeSec: number) {
    this.stopInternal(fadeSec);
    const t = this.ctx.currentTime;
    const freq = noteFrequency(note, 2);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(1, t + Math.max(0.05, fadeSec));

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1200;

    // LFO lento modulando o corte do filtro: dá a "respiração" do pad.
    const lfo = this.ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 1 / this.breatheSec;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 300; // +-300Hz ao redor do corte base
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);
    lfo.start(t);

    const osc1 = this.ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.value = freq;
    osc1.detune.value = -6;
    const osc2 = this.ctx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.frequency.value = freq;
    osc2.detune.value = 6;

    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(gain);
    gain.connect(this.output);

    osc1.start();
    osc2.start();
    this.voices.push({ osc1, osc2, gain, filter, lfo, lfoGain });
    this.isOn = true;
  }

  changeKey(note: string, crossfadeSec: number) {
    if (!this.isOn) return;
    this.start(note, crossfadeSec);
  }

  stop(fadeSec = 1.5) {
    this.stopInternal(fadeSec);
    this.isOn = false;
  }

  private stopInternal(fadeSec: number) {
    const t = this.ctx.currentTime;
    const old = [...this.voices];
    this.voices = [];
    for (const v of old) {
      v.gain.gain.cancelScheduledValues(t);
      v.gain.gain.setValueAtTime(v.gain.gain.value, t);
      v.gain.gain.linearRampToValueAtTime(0, t + Math.max(0.05, fadeSec));
      v.osc1.stop(t + fadeSec + 0.1);
      v.osc2.stop(t + fadeSec + 0.1);
      v.lfo.stop(t + fadeSec + 0.1);
    }
  }

  get playing() {
    return this.isOn;
  }
}
