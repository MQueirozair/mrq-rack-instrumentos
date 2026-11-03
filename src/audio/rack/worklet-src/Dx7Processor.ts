import { Voice } from '@audio/synth-dx7';

// Processor de AudioWorklet para o motor FM "MSFA" do DX7 (@audio/synth-dx7).
// Substitui o antigo ScriptProcessorNode (Dx7LayerVoice.ts usava um buffer de
// 512 amostras rodando na thread principal, ~23ms de atraso no pior caso e
// sujeito a engasgos quando a UI React está ocupada). Rodando aqui dentro do
// AudioWorklet, o cálculo das vozes FM acontece numa thread de áudio dedicada
// e de alta prioridade, no "render quantum" nativo do navegador (128
// amostras, ~3ms), e os eventos de nota chegam pela MessagePort sem depender
// da thread principal.

const BLOCK = 64; // tamanho fixo de bloco do motor MSFA
const FULL_SCALE = 2 ** -28; // escala do int32 bruto do motor (ver dx7.js: SCALE)

class Dx7Processor extends AudioWorkletProcessor {
  private active = new Map<number, Voice>();
  private currentPatch: Uint8Array | null = null;
  private blockBuf = new Int32Array(BLOCK);

  constructor() {
    super();
    this.port.onmessage = (ev: MessageEvent) => {
      const msg = ev.data;
      switch (msg?.type) {
        case 'patch':
          this.currentPatch = msg.patch as Uint8Array;
          break;
        case 'noteOn':
          if (this.currentPatch) {
            this.active.delete(msg.note);
            this.active.set(
              msg.note,
              new Voice(this.currentPatch, { note: msg.note, velocity: msg.velocity, fs: sampleRate })
            );
          }
          break;
        case 'noteOff':
          this.active.get(msg.note)?.keyup();
          break;
        case 'allNotesOff':
          for (const voice of this.active.values()) voice.keyup();
          this.active.clear();
          break;
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] ?? output[0];
    const frameCount = left.length;
    for (let offset = 0; offset < frameCount; offset += BLOCK) {
      this.blockBuf.fill(0);
      for (const [note, voice] of this.active) {
        voice.block(this.blockBuf);
        if (voice.done) this.active.delete(note);
      }
      const n = Math.min(BLOCK, frameCount - offset);
      for (let i = 0; i < n; i++) {
        const sample = this.blockBuf[i] * FULL_SCALE;
        left[offset + i] = sample;
        right[offset + i] = sample;
      }
    }
    return true;
  }
}

registerProcessor('dx7-processor', Dx7Processor);
