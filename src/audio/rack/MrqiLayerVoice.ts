import type { RackPresetOption } from '../../../shared/types';
import { unpackMrqi, sampleInputToAudioBuffer, type MrqiZoneDef } from './mrqiFormat';

const ATTACK_SEC = 0.003;
const RELEASE_SEC = 0.12;

interface ResolvedZone extends MrqiZoneDef {
  buffer: AudioBuffer;
}

/**
 * Camada ".mrqi" — carrega o formato leve/nativo do MRQ Multitracks Play
 * (ver mrqiFormat.ts e docs em HelpPanel). Diferente de NkiLayerVoice e
 * SfzLayerVoice, aqui NÃO existe decodeAudioData nenhum: o áudio já está
 * guardado dentro do pacote como PCM Float32 cru, então reconstituir cada
 * AudioBuffer é só uma cópia de memória — é exatamente esse passo a menos
 * que torna abrir um `.mrqi` mais rápido que reabrir o instrumento original
 * (Kontakt ou qualquer outra fonte) toda vez.
 */
export class MrqiLayerVoice {
  private ctx: AudioContext;
  private groups: { name: string; zones: ResolvedZone[] }[] = [];
  private zones: ResolvedZone[] = [];
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

  async load(buffer: ArrayBuffer, sourcePath?: string): Promise<RackPresetOption[]> {
    this.dispose();
    const { manifest, samplesByPath } = unpackMrqi(new Uint8Array(buffer));
    this.instrumentName = manifest.name || (sourcePath ? sourcePath.split(/[\\/]/).pop() ?? '' : '');

    const zonesByGroup = new Map<string, ResolvedZone[]>();
    for (const zone of manifest.zones) {
      const sample = samplesByPath.get(zone.sample);
      if (!sample) continue; // referência quebrada dentro do próprio pacote — pula, não derruba o resto
      const resolved: ResolvedZone = { ...zone, buffer: sampleInputToAudioBuffer(this.ctx, sample) };
      const list = zonesByGroup.get(zone.groupId) ?? [];
      list.push(resolved);
      zonesByGroup.set(zone.groupId, list);
    }

    this.groups = manifest.groups
      .map((g) => ({ name: g.name, zones: zonesByGroup.get(g.id) ?? [] }))
      .filter((g) => g.zones.length > 0);

    if (this.groups.length === 0) {
      throw new Error('Este .mrqi não tem nenhuma zona válida (áudio referenciado ausente ou pacote corrompido).');
    }

    this.zones = this.groups[0].zones;

    if (this.groups.length > 1) {
      return this.groups.map((g, i) => ({ value: String(i), label: g.name }));
    }
    return [{ value: 'default', label: this.instrumentName || 'Instrumento' }];
  }

  selectPreset(value: string) {
    if (this.groups.length <= 1) return;
    const idx = Number(value);
    const group = Number.isFinite(idx) ? this.groups[idx] : undefined;
    if (group) this.zones = group.zones;
  }

  private zonesFor(note: number, velocity: number): ResolvedZone[] {
    const matches = this.zones.filter(
      (z) => note >= z.loKey && note <= z.hiKey && velocity >= z.loVel && velocity <= z.hiVel
    );
    return matches.length > 0 ? matches : this.zones.filter((z) => note >= z.loKey && note <= z.hiKey);
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
      const target = Math.max(0, Math.min(1, (velocity / 127) * (zone.volume || 1)));
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(target, now + ATTACK_SEC);
      let node: AudioNode = gain;
      if (zone.pan) {
        const panner = this.ctx.createStereoPanner();
        panner.pan.value = Math.max(-1, Math.min(1, zone.pan));
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
    this.groups = [];
    this.zones = [];
  }
}
