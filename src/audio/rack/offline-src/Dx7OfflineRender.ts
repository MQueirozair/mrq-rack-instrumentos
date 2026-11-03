/**
 * Pré-compilado separadamente (ver scripts/build-rack-worklets.cjs) e servido
 * como arquivo estático em public/vendor/dx7-offline/ — carregado via
 * `import()` dinâmico em tempo de execução por syxImport.ts, nunca pelo
 * bundle normal do Vite/Rollup (alvo es2019, ver vite.config.ts).
 *
 * Motivo: @audio/synth-dx7 usa literais BigInt (ex.: `1n << 30n`) pra montar
 * a tabela de seno do motor FM de forma bit-exata — sintaxe que o esbuild
 * não consegue rebaixar pra es2019 (erro de build, não falta de polyfill).
 * `Dx7LayerVoice.ts` (reprodução ao vivo) só importa `parse` de sysex.js, que
 * não usa BigInt, e o pacote declara `sideEffects: false`, então o Rollup
 * consegue eliminar o resto (`dx7.js`, com a tabela BigInt) do bundle
 * principal por tree-shaking — desde que nada mais alcançável a partir da
 * entrada principal importe `render`/`Voice`/o export default de dx7.js.
 * Este arquivo é exatamente esse "nada mais": isola o único ponto do app que
 * usa o render de verdade, compilado num alvo mais novo (es2020+, ver o
 * script) pra nunca entrar no bundle principal em es2019.
 *
 * Compatibilidade: BigInt só existe a partir do Safari 14.1/WebKit
 * equivalente (2021) — mais novo que o piso declarado do app (macOS
 * 10.15/Catalina, WebKit ~Safari 13, ver vite.config.ts). Isso não é uma
 * limitação nova desta fase: a reprodução ao vivo de DX7 já exige
 * AudioWorklet (também só a partir do Safari 14.1) pelo mesmo motivo.
 * `isDx7RenderSupported()` em syxImport.ts detecta isso ANTES de tentar
 * carregar este arquivo, e falha com uma mensagem clara em vez de uma
 * tela preta ou um SyntaxError genérico.
 */
import dx7 from '@audio/synth-dx7';

export interface Dx7OfflineRenderRequest {
  /** voz VCED de 155 bytes (`parse(bytes)[i].patch`, ver sysex.js). */
  patch: Uint8Array;
  /** nota MIDI (0-127) — convertida pra Hz aqui, não repassada direto. */
  note: number;
  /** velocidade MIDI (0-127). */
  velocity: number;
  /** taxa de amostragem, precisa ser > 16384 Hz (tabela de frequência do motor). */
  sampleRateHz: number;
  /** segundos com a tecla pressionada. */
  durationSeconds: number;
  /** segundos de cauda depois de soltar a tecla. */
  releaseSeconds: number;
}

/**
 * Renderiza uma nota do motor FM DX7 "offline" (sem AudioContext, sem rodar
 * em tempo real) — mono, Float32 normalizado como um AudioBuffer do Web
 * Audio (1.0 = escala cheia da MSFA). Picos acima de 1.0 são esperados em
 * vozes com vários operadores portadores altos (ver README do
 * @audio/synth-dx7); o gravador .mrq já faz clamp disso ao converter pra PCM
 * inteiro (src-tauri/src/mrq/writer.rs::float32_to_integer_pcm).
 */
export function renderDx7Note(req: Dx7OfflineRenderRequest): Float32Array {
  const freqHz = 440 * Math.pow(2, (req.note - 69) / 12);
  return dx7(freqHz, {
    patch: req.patch,
    velocity: Math.max(0, Math.min(127, req.velocity)) / 127,
    duration: req.durationSeconds,
    release: req.releaseSeconds,
    fs: req.sampleRateHz,
    msfa: false,
  });
}
