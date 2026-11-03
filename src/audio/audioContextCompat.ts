/**
 * Fallback de compatibilidade para `AudioContext` / `OfflineAudioContext`.
 *
 * Em WebViews com WebKit desatualizado — como em Macs antigos sem suporte
 * oficial da Apple, rodando macOS via OpenCore Legacy Patcher, que às vezes
 * ficam presos numa versão de Safari/WebKit de antes de ~2017 — o construtor
 * global `AudioContext` (sem prefixo) pode simplesmente não existir, só a
 * forma antiga com prefixo `webkitAudioContext`.
 *
 * Sem este fallback, `new AudioContext()` lança um `ReferenceError`
 * SÍNCRONO assim que o módulo que o referencia é carregado — e como
 * `src/audio/engineInstance.ts` cria o `AudioEngine` (que por sua vez cria
 * o `AudioContext`) no topo (top-level) do módulo, esse erro acontece ANTES do
 * React conseguir montar `#root`, resultando numa tela 100% preta sem
 * nenhum log visível no processo nativo (só aparece no console do
 * WebView). Ver diagnóstico via Web Inspector que identificou exatamente
 * esse erro: "Can't find variable: AudioContext".
 */
export const AudioContextCompat: typeof AudioContext = (
  typeof window !== 'undefined'
    ? window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    : undefined
) as typeof AudioContext;

export const OfflineAudioContextCompat: typeof OfflineAudioContext = (
  typeof window !== 'undefined'
    ? window.OfflineAudioContext ||
      (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext
    : undefined
) as typeof OfflineAudioContext;

/**
 * Fallback para `AudioContext.prototype.createConstantSource` — usado pelo
 * allpass modulado do reverb (ver `createAllpassNode` em RackEngine.ts) pra
 * gerar o offset central da excursão do LFO de pitch. `ConstantSourceNode`
 * chegou ao WebKit praticamente junto com a unprefixação do `AudioContext`
 * (~2021), então no mesmo WebKit antigo que já exigiu o fallback acima,
 * `ctx.createConstantSource` também não existe — sem isso, `buildGraph()`
 * lança um erro NO MEIO da montagem do grafo de áudio do Rack, depois de
 * `this.ctx` já ter sido setado (então `ensureStarted()` nunca tenta de
 * novo) mas antes de `this.layers` ser preenchido — todo "Carregar" depois
 * disso falha com "undefined is not an object (evaluating 'layer.voice')",
 * porque a camada pedida nem existe no array.
 *
 * O shim replica a parte da API de `ConstantSourceNode` que o código usa
 * (`.offset.value`, `.connect(destino)`, `.start()`) com uma técnica clássica
 * pré-ConstantSourceNode: um `AudioBufferSourceNode` tocando em loop um
 * buffer de 1.0 constante, ligado numa `GainNode` cujo `.gain` funciona como
 * o `.offset` (saída = 1 × gain = gain, constante).
 */
export function createConstantSourceCompat(ctx: AudioContext): ConstantSourceNode {
  if (typeof ctx.createConstantSource === 'function') return ctx.createConstantSource();
  const buffer = ctx.createBuffer(1, 2, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  data[0] = 1;
  data[1] = 1;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  source.connect(gain);
  const shim = {
    offset: gain.gain,
    connect: (...args: Parameters<AudioNode['connect']>) => (gain.connect as (...a: unknown[]) => unknown)(...args),
    disconnect: (...args: unknown[]) => (gain.disconnect as (...a: unknown[]) => unknown)(...args),
    start: (when?: number) => source.start(when),
    stop: (when?: number) => source.stop(when),
  };
  return shim as unknown as ConstantSourceNode;
}

