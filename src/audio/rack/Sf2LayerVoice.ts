import * as JSSynth from 'js-synthesizer';
import { SoundFont2 } from 'soundfont2';
import type { RackPresetOption } from '../../../shared/types';
import { stripUnknownSf2InfoChunks } from './sf2InfoSanitize';

// Caminhos relativos ao index.html publicado (ver public/vendor/js-synthesizer/*,
// copiado verbatim pelo Vite pro build final — vite.config.ts usa base: './').
const LIBFLUIDSYNTH_URL = './vendor/js-synthesizer/libfluidsynth-2.4.6-with-libsndfile.js';
const WORKLET_URL = './vendor/js-synthesizer/js-synthesizer.worklet.min.js';

// Tamanho do buffer do ScriptProcessorNode usado no modo de compatibilidade
// (ver ensureScriptProcessorReady abaixo). 4096 amostras é o
// valor historicamente usado antes da migração pro AudioWorklet — maior
// buffer = mais estável em hardware/WebKit antigo, ao custo de mais atraso
// perceptível ao tocar (até ~185ms no pior caso).
const SCRIPT_PROCESSOR_BUFFER_SIZE = 4096;

// Teto de segurança pro tamanho do arquivo SF2/SF3 carregado DIRETO numa
// camada do Rack (fora disso, recusa com um erro claro em vez de arriscar
// travar o app inteiro). O FluidSynth-WASM (libfluidsynth-*-with-libsndfile)
// roda com memória WASM inicial de 64MB crescendo até um teto de 2GB (ver
// https://deepwiki.com/jet2jet/js-synthesizer/7.1-fluidsynth-wasm-modules);
// o SoundFont carregado precisa caber nesse teto JUNTO com toda a estrutura
// interna do FluidSynth (pools de voz, amostras já convertidas pro formato
// dele etc.), que historicamente soma bem mais que 1x o tamanho do arquivo
// em RAM — daí a margem generosa aqui embaixo do teto de 2GB em vez de usar
// o teto em si. Quando esse limite estoura DENTRO do WebAssembly (em vez de
// lançar uma exceção JS normal e capturável), o comportamento observado em
// WebView2 (Windows) é a janela inteira do app fechar sem aviso nenhum —
// nem o React nem o Rust conseguem pegar esse tipo de falha pra mostrar uma
// tela de erro, porque o processo de renderização em si morre. Esta
// checagem SÓ existe pra nunca deixar o usuário chegar nesse estado: com um
// arquivo grande demais, melhor um erro claro (toast + mrq-debug.log) do que
// o app sumir da tela. SF2/SF3 muito grandes continuam totalmente possíveis
// de usar — só não direto numa camada do Rack; convertendo primeiro pro
// formato .mrq no Conversor de Instrumentos (que lê o SF2/SF3 com o parser
// nativo em Rust, sem esse teto de memória) e carregando o .mrq resultante
// na camada, funciona normalmente.
const SF2_MAX_BYTES_FOR_LIVE_RACK = 400 * 1024 * 1024; // 400MB

// Os dois módulos de AudioWorklet (libfluidsynth + js-synthesizer) só podem ser
// adicionados uma vez por AudioContext. Como as 4 camadas do rack compartilham
// um único AudioContext (ver RackEngine), guardamos a promessa por instância de
// contexto para todas as camadas reaproveitarem o mesmo carregamento.
const workletReadyByContext = new WeakMap<AudioContext, Promise<void>>();

function ensureWorkletReady(ctx: AudioContext): Promise<void> {
  let ready = workletReadyByContext.get(ctx);
  if (!ready) {
    ready = ctx.audioWorklet
      .addModule(LIBFLUIDSYNTH_URL)
      .then(() => ctx.audioWorklet.addModule(WORKLET_URL));
    workletReadyByContext.set(ctx, ready);
  }
  return ready;
}

// Modo de compatibilidade pra WebKit/navegadores sem AudioWorklet (recurso
// que só chegou no Safari 14.1/2021, então falta em macOS mais antigos):
// carrega o mesmo FluidSynth WebAssembly, mas na thread principal (via tag
// <script>, exatamente como o próprio js-synthesizer documenta como "From
// main thread"), e usa a classe `JSSynth.Synthesizer` — que roda num
// ScriptProcessorNode (API mais antiga e depreciada do Web Audio, mas
// suportada desde as primeiras versões com Web Audio, bem antes do
// AudioWorklet) — em vez de `JSSynth.AudioWorkletNodeSynthesizer`. O binário
// .wasm é o mesmo nos dois casos (compilado via Emscripten/C, sem os
// recursos pós-MVP tipo reference-types/multivalue que afetaram o .npno).
// `Module` (variável global que o script define) é compartilhada por todas
// as camadas, então o carregamento só acontece uma vez.
let scriptProcessorReady: Promise<void> | null = null;

function ensureScriptProcessorReady(): Promise<void> {
  if (!scriptProcessorReady) {
    scriptProcessorReady = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = LIBFLUIDSYNTH_URL;
      script.onload = () => {
        JSSynth.waitForReady().then(resolve, reject);
      };
      script.onerror = () => {
        reject(
          new Error(
            'não foi possível carregar o motor de SoundFont (FluidSynth) neste navegador/WebView.'
          )
        );
      };
      document.head.appendChild(script);
    });
  }
  return scriptProcessorReady;
}

/**
 * Uma camada que toca um SoundFont (.sf2/.sf3) real, via FluidSynth compilado
 * pra WebAssembly (js-synthesizer). Preferencialmente roda dentro de um
 * AudioWorklet (baixa latência: "render quantum" nativo do Web Audio, 128
 * amostras / ~3ms, eventos de nota via porta de mensagens de altíssima
 * prioridade sem depender da thread principal). Em navegadores/WebKit sem
 * suporte a AudioWorklet (ver ensureScriptProcessorReady acima), cai pra um
 * ScriptProcessorNode (mais atraso perceptível, até ~185ms no pior caso, mas
 * pelo menos toca em vez de simplesmente recusar o arquivo).
 */
export class Sf2LayerVoice {
  private ctx: AudioContext;
  private synth: JSSynth.ISynthesizer | null = null;
  private node: AudioNode | null = null;
  readonly output: GainNode;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.output = ctx.createGain();
  }

  async load(buffer: ArrayBuffer): Promise<RackPresetOption[]> {
    if (buffer.byteLength > SF2_MAX_BYTES_FOR_LIVE_RACK) {
      const mb = (buffer.byteLength / (1024 * 1024)).toFixed(0);
      const limitMb = (SF2_MAX_BYTES_FOR_LIVE_RACK / (1024 * 1024)).toFixed(0);
      throw new Error(
        `Este SoundFont tem ${mb}MB — maior que o limite de ${limitMb}MB pra tocar ao vivo direto numa camada do Rack ` +
          `(o motor de SoundFont deste app roda dentro de um limite de memória fixo e SoundFonts muito grandes podem travar ` +
          `o programa inteiro sem aviso, em vez de só dar um erro). Converta este arquivo pra .mrq no "Conversor de ` +
          `Instrumentos" primeiro (ele lê o SoundFont sem esse limite) e carregue o .mrq resultante nesta camada — mesmo ` +
          `som, sem esse risco.`
      );
    }
    this.dispose();
    let synth: JSSynth.ISynthesizer;
    if (this.ctx.audioWorklet) {
      await ensureWorkletReady(this.ctx);
      const workletSynth = new JSSynth.AudioWorkletNodeSynthesizer();
      workletSynth.init(this.ctx.sampleRate);
      // createAudioNode precisa ser chamado antes de qualquer outro método (é
      // o que estabelece a porta de mensagens com o worklet).
      this.node = workletSynth.createAudioNode(this.ctx);
      synth = workletSynth;
    } else {
      console.info(
        '[rack] este navegador/WebView não suporta AudioWorklet — usando modo de compatibilidade (ScriptProcessorNode) pra tocar SoundFont.'
      );
      await ensureScriptProcessorReady();
      const fallbackSynth = new JSSynth.Synthesizer();
      fallbackSynth.init(this.ctx.sampleRate);
      this.node = fallbackSynth.createAudioNode(this.ctx, SCRIPT_PROCESSOR_BUFFER_SIZE);
      synth = fallbackSynth;
    }
    this.node.connect(this.output);
    this.synth = synth;

    // Sanitiza o SoundFont ANTES de entregar pro FluidSynth-WASM: o
    // FluidSynth 2.4.6 vendorizado aqui (ver LIBFLUIDSYNTH_URL acima) tem um
    // bug documentado que rejeita com erro FATAL qualquer .sf2 que tenha
    // chunks "INFO" desconhecidos — algo comum em arquivos exportados por
    // editores modernos (ex.: Polyphone) e, pelo spec, deveria ser só
    // ignorado. Ver sf2InfoSanitize.ts pra detalhes completos e pro link do
    // issue upstream. Isso é puramente defensivo: se o arquivo não tiver
    // nenhum chunk fora do padrão, o buffer original é usado sem nenhuma
    // cópia.
    const { buffer: sanitizedBuffer, removedChunkIds } = stripUnknownSf2InfoChunks(buffer);
    if (removedChunkIds.length > 0) {
      console.info(
        `[rack] removidos ${removedChunkIds.length} chunk(s) INFO não-padrão do SoundFont antes de carregar no FluidSynth: ${removedChunkIds.join(', ')} ` +
          '(o FluidSynth 2.4.6 usado neste app rejeita o arquivo inteiro com erro fatal ao ver chunks INFO desconhecidos, embora o spec SF2 diga pra apenas ignorá-los).'
      );
    }
    await synth.loadSFont(sanitizedBuffer);

    let sf: SoundFont2 | null = null;
    try {
      sf = new SoundFont2(new Uint8Array(sanitizedBuffer));
    } catch (err) {
      console.warn('[rack] não foi possível ler a lista de presets do SoundFont', err);
    }
    const presets: RackPresetOption[] = (sf?.presets ?? [])
      .map((p) => ({
        value: `${p.header.bank}:${p.header.preset}`,
        label: `${p.header.bank}:${p.header.preset} ${p.header.name}`.trim(),
      }))
      .sort((a, b) => a.value.localeCompare(b.value, undefined, { numeric: true }));
    if (presets.length > 0) this.selectPreset(presets[0].value);
    return presets;
  }

  selectPreset(value: string) {
    if (!this.synth) return;
    const [bankStr, programStr] = value.split(':');
    const bank = Number(bankStr) || 0;
    const program = Number(programStr) || 0;
    this.synth.midiBankSelect(0, bank);
    this.synth.midiProgramChange(0, program);
  }

  noteOn(note: number, velocity: number) {
    this.synth?.midiNoteOn(0, note, velocity);
  }

  noteOff(note: number) {
    this.synth?.midiNoteOff(0, note);
  }

  /**
   * Pitch bend em semitons (ver RackEngine.PITCH_BEND_RANGE_SEMITONES) — usa
   * a roda de pitch bend nativa do FluidSynth, que já afeta as notas em
   * andamento (não só as novas). O valor bruto é de 14 bits (0..16383,
   * 8192 = centro), e o FluidSynth por padrão interpreta ±8192 como ±2
   * semitons (faixa de pitch bend padrão do General MIDI).
   */
  setPitchBend(semitones: number) {
    const raw = Math.round(8192 + (semitones / 2) * 8192);
    this.synth?.midiPitchBend(0, Math.max(0, Math.min(16383, raw)));
  }

  allNotesOff() {
    this.synth?.midiAllNotesOff(0);
  }

  dispose() {
    try {
      this.node?.disconnect();
    } catch {
      /* já desconectado */
    }
    try {
      this.synth?.close();
    } catch {
      /* ignorar erro ao fechar */
    }
    this.synth = null;
    this.node = null;
  }
}
