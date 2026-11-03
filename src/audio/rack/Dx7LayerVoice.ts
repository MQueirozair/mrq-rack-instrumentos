import { parse } from '@audio/synth-dx7';
import type { RackPresetOption } from '../../../shared/types';

// Pré-compilado por scripts/build-rack-worklets.cjs (esbuild) a partir de
// src/audio/rack/worklet-src/Dx7Processor.ts, e servido como arquivo estático
// — mesmo padrão usado pros arquivos do js-synthesizer em public/vendor/.
// AudioWorklet exige uma URL real pra carregar o módulo; não compilamos isso
// pelo pipeline normal do Vite porque o empacotamento de `new URL()`/`?url`
// pra esse caso (módulo sem export usado só por efeito colateral dentro de um
// AudioWorkletGlobalScope) não é confiável em todas as versões/consumidores
// do Vite — pré-compilar deixa o resultado previsível em dev e produção.
const DX7_WORKLET_URL = './vendor/dx7-worklet/dx7-processor.js';

const moduleReadyByContext = new WeakMap<AudioContext, Promise<void>>();

function ensureWorkletModuleReady(ctx: AudioContext): Promise<void> {
  // Ver o mesmo comentário em Sf2LayerVoice.ts — sem essa checagem, um
  // WebKit sem AudioWorklet (recurso só chegou no Safari 14.1/2021) lançaria
  // um TypeError genérico e confuso em vez de uma mensagem clara.
  if (!ctx.audioWorklet) {
    throw new Error(
      'este navegador/WebView não tem suporte a AudioWorklet, necessário pra tocar bancos DX7 (.syx). Tente um formato diferente (ex.: .npno) ou atualize o sistema.'
    );
  }
  let ready = moduleReadyByContext.get(ctx);
  if (!ready) {
    ready = ctx.audioWorklet.addModule(DX7_WORKLET_URL);
    moduleReadyByContext.set(ctx, ready);
  }
  return ready;
}

/**
 * Uma camada que toca um banco/voz real do Yamaha DX7 (.syx), usando o núcleo
 * FM "MSFA" (o mesmo que o Google abriu publicamente e que o Dexed usa),
 * portado bit a bit para JavaScript pelo pacote @audio/synth-dx7 — rodando
 * dentro de um AudioWorklet (ver Dx7Processor.worklet.ts) em vez do antigo
 * ScriptProcessorNode, pra eliminar o atraso perceptível ao tocar.
 */
export class Dx7LayerVoice {
  private ctx: AudioContext;
  private node: AudioWorkletNode | null = null;
  private voices: { name: string; patch: Uint8Array }[] = [];
  readonly output: GainNode;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.output = ctx.createGain();
  }

  async load(buffer: ArrayBuffer): Promise<RackPresetOption[]> {
    await ensureWorkletModuleReady(this.ctx);
    this.dispose();
    const parsed = parse(new Uint8Array(buffer));
    if (parsed.length === 0) {
      throw new Error('Nenhuma voz DX7 válida foi encontrada neste arquivo .syx.');
    }
    this.voices = parsed;
    const node = new AudioWorkletNode(this.ctx, 'dx7-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.connect(this.output);
    this.node = node;
    this.selectPreset('0');
    return parsed.map((v, i) => ({ value: String(i), label: `${i + 1}. ${v.name}` }));
  }

  selectPreset(value: string) {
    const idx = Number(value);
    const voice = this.voices[idx];
    if (voice) this.node?.port.postMessage({ type: 'patch', patch: voice.patch });
  }

  noteOn(note: number, velocity: number) {
    this.node?.port.postMessage({ type: 'noteOn', note, velocity });
  }

  noteOff(note: number) {
    this.node?.port.postMessage({ type: 'noteOff', note });
  }

  allNotesOff() {
    this.node?.port.postMessage({ type: 'allNotesOff' });
  }

  dispose() {
    if (this.node) {
      try {
        this.node.port.postMessage({ type: 'allNotesOff' });
        this.node.disconnect();
      } catch {
        /* já desconectado */
      }
    }
    this.node = null;
    this.voices = [];
  }
}
