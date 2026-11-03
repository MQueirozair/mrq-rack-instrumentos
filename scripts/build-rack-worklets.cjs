// Compila artefatos do Rack de instrumentos que não podem passar pelo
// empacotamento normal do Vite (alvo es2019, ver vite.config.ts) e os deixa
// como arquivos JS autocontidos em public/vendor/, servidos por URL relativa
// simples (mesmo padrão usado pros arquivos do js-synthesizer):
//
//  1. dx7-processor.js — o AudioWorkletProcessor do motor FM do DX7.
//     AudioWorklet exige carregar o módulo por `audioWorklet.addModule(url)`
//     a partir de um arquivo real; pré-compilar com esbuild pra um arquivo
//     estático versionado é o jeito mais previsível/robusto de garantir isso
//     em dev e produção.
//  2. dx7-offline-render.js (Fase 5, importador .syx) — expõe a função
//     `render`/`dx7` de verdade do motor FM pra renderizar notas
//     representativas na conversão .syx → .mrq.
//
// Os dois existem fora do bundle principal pelo MESMO motivo de fundo: o
// núcleo @audio/synth-dx7 usa literais BigInt (`1n << 30n`, etc.) pra montar
// a tabela de seno do motor de forma bit-exata — sintaxe que o esbuild não
// consegue rebaixar pro alvo es2019 do bundle principal (é erro de build,
// confirmado tentando compilar `render`/`Voice` nesse alvo: "Big integer
// literals are not available in the configured target environment
// (\"es2019\")"). Compilamos os dois em es2020+ aqui, onde BigInt é sintaxe
// válida. `Dx7LayerVoice.ts` (reprodução ao vivo) só importa `parse` de
// sysex.js — que não usa BigInt — e o pacote declara `sideEffects: false`,
// então o Rollup consegue eliminar o resto (`dx7.js`) do bundle principal
// por tree-shaking, DESDE QUE nenhum módulo alcançável a partir da entrada
// principal importe `render`/`Voice`/o export default de dx7.js. Por isso
// `src/audio/rack/offline-src/Dx7OfflineRender.ts` (que usa o export
// default) também precisa ficar isolado aqui, como o worklet.
const esbuild = require('esbuild');
const path = require('node:path');

const root = path.join(__dirname, '..');

async function build() {
  await esbuild.build({
    entryPoints: [path.join(root, 'src/audio/rack/worklet-src/Dx7Processor.ts')],
    outfile: path.join(root, 'public/vendor/dx7-worklet/dx7-processor.js'),
    bundle: true,
    format: 'esm',
    target: 'es2020',
    minify: true,
    logLevel: 'info',
  });
  console.log('[build-rack-worklets] dx7-processor.js gerado em public/vendor/dx7-worklet/');

  await esbuild.build({
    entryPoints: [path.join(root, 'src/audio/rack/offline-src/Dx7OfflineRender.ts')],
    outfile: path.join(root, 'public/vendor/dx7-offline/dx7-offline-render.js'),
    bundle: true,
    format: 'esm',
    target: 'es2020',
    minify: true,
    logLevel: 'info',
  });
  console.log('[build-rack-worklets] dx7-offline-render.js gerado em public/vendor/dx7-offline/');
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
