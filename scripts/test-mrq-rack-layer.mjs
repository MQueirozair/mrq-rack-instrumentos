#!/usr/bin/env node
/**
 * Teste de regressão da camada ".mrq" do Rack (Fase 9 do MRQ Instrument
 * Converter, src/audio/rack/MrqLayerVoice.ts).
 *
 * Mesmo padrão de scripts/test-syx-import.mjs e scripts/test-nki-import.mjs:
 * compila o módulo TS de verdade com esbuild pra CJS/Node e testa as funções
 * exportadas diretamente. A classe `MrqLayerVoice` em si depende de
 * AudioContext/AudioBufferSourceNode/window.api — não dá pra testar isso em
 * Node puro sem reimplementar um WebView inteiro. Por isso este teste cobre
 * exatamente as duas peças de lógica NOVAS e não-triviais desta fase, que
 * foram deliberadamente extraídas como funções puras só por isso:
 *
 *  1. `selectRoundRobinZones` — alternância round robin entre zonas do
 *     mesmo grupo (zonas sem grupo sempre tocam; zonas agrupadas alternam
 *     em ordem, voltando ao início ao estourar o tamanho do grupo).
 *  2. `effectiveStereoPan` — pan é respeitado como está exceto quando a
 *     amostra é mono E `stereo` é 'left'/'right' (caso de par estéreo SF2
 *     feito de duas amostras mono), caso em que o pan vai pro extremo.
 *
 * Rode com: node scripts/test-mrq-rack-layer.mjs
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

async function compileToNode(entry) {
  const outfile = path.join(os.tmpdir(), `mrq-rack-test-${path.basename(entry, '.ts')}-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`);
  await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'es2020',
    outfile,
    // mrqFormat.ts/mrqReadMetadata etc. fazem `invoke('tauri...')` só em
    // tempo de execução dentro de funções que este teste nunca chama — não
    // precisa (nem dá, sem um app Tauri de verdade) mockar isso aqui.
  });
  return import(`file://${outfile}`);
}

const { selectRoundRobinZones, effectiveStereoPan } = await compileToNode('src/audio/rack/MrqLayerVoice.ts');

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  OK   - ${name}`);
  } else {
    console.error(`  FAIL - ${name}`);
    failures += 1;
  }
}

// ---------- selectRoundRobinZones ----------
{
  const noGroup = [{ sampleId: 'a' }, { sampleId: 'b' }];
  const counters = new Map();
  const result = selectRoundRobinZones(noGroup, counters);
  check('zonas sem roundRobinGroup tocam sempre, todas juntas', result.length === 2 && result[0].sampleId === 'a' && result[1].sampleId === 'b');
}

{
  const grouped = [
    { sampleId: 'rr0', roundRobinGroup: 'g1', roundRobinIndex: 0 },
    { sampleId: 'rr1', roundRobinGroup: 'g1', roundRobinIndex: 1 },
    { sampleId: 'rr2', roundRobinGroup: 'g1', roundRobinIndex: 2 },
  ];
  const counters = new Map();
  const picks = [0, 1, 2, 3, 4].map(() => selectRoundRobinZones(grouped, counters)[0].sampleId);
  check('round robin alterna em ordem e dá a volta (0,1,2,0,1)', JSON.stringify(picks) === JSON.stringify(['rr0', 'rr1', 'rr2', 'rr0', 'rr1']));
}

{
  // zonas de grupos DIFERENTES avançam seus próprios contadores
  // independentemente uma da outra.
  const zones = [
    { sampleId: 'A0', roundRobinGroup: 'A', roundRobinIndex: 0 },
    { sampleId: 'A1', roundRobinGroup: 'A', roundRobinIndex: 1 },
    { sampleId: 'B0', roundRobinGroup: 'B', roundRobinIndex: 0 },
    { sampleId: 'B1', roundRobinGroup: 'B', roundRobinIndex: 1 },
    { sampleId: 'solo' }, // sem grupo: sempre junto
  ];
  const counters = new Map();
  const first = selectRoundRobinZones(zones, counters).map((z) => z.sampleId).sort();
  const second = selectRoundRobinZones(zones, counters).map((z) => z.sampleId).sort();
  check(
    'grupos de round robin independentes + zona solo sempre presente',
    JSON.stringify(first) === JSON.stringify(['A0', 'B0', 'solo']) && JSON.stringify(second) === JSON.stringify(['A1', 'B1', 'solo'])
  );
}

{
  // ordem de entrada embaralhada: a seleção deve respeitar roundRobinIndex,
  // não a ordem em que as zonas aparecem no array de entrada.
  const shuffled = [
    { sampleId: 'last', roundRobinGroup: 'g', roundRobinIndex: 2 },
    { sampleId: 'first', roundRobinGroup: 'g', roundRobinIndex: 0 },
    { sampleId: 'mid', roundRobinGroup: 'g', roundRobinIndex: 1 },
  ];
  const counters = new Map();
  const pick = selectRoundRobinZones(shuffled, counters)[0].sampleId;
  check('respeita roundRobinIndex mesmo com zonas fora de ordem no array', pick === 'first');
}

// ---------- effectiveStereoPan ----------
check('amostra mono + stereo=left força pan -1', effectiveStereoPan(0, 'left', 1) === -1);
check('amostra mono + stereo=right força pan +1', effectiveStereoPan(0, 'right', 1) === 1);
check('amostra mono sem stereo respeita zone.pan', effectiveStereoPan(0.4, undefined, 1) === 0.4);
check('amostra estéreo (2 canais) ignora stereo e respeita zone.pan', effectiveStereoPan(-0.3, 'left', 2) === -0.3);
check('amostra estéreo (2 canais) com pan 0 continua 0', effectiveStereoPan(0, 'right', 2) === 0);

console.log('');
if (failures > 0) {
  console.error(`${failures} teste(s) falharam.`);
  process.exit(1);
}
console.log('Todos os testes de src/audio/rack/MrqLayerVoice.ts passaram.');
