#!/usr/bin/env node
/**
 * Teste de regressão do "Kontakt Audio Capture" (fluxo opcional do MRQ
 * Instrument Converter — src/audio/rack/kontaktCapture.ts). Mesmo padrão de
 * scripts/test-syx-import.mjs e scripts/test-mrq-rack-layer.mjs: compila o
 * módulo TS de verdade com esbuild pra CJS/Node e testa as funções puras
 * exportadas diretamente (parsing de nome de arquivo, mapeamento automático
 * de velocity/round-robin, detecção de duplicados, montagem do
 * MrqInstrumentModel/relatório de compatibilidade). A orquestração real
 * (`runKontaktCapture`, que chama `invoke()` do Tauri) não é testável aqui
 * sem um app Tauri de verdade — isso é coberto pelos testes Rust de
 * `src-tauri/src/importers/kontakt_capture.rs` (`cargo test`), que
 * exercitam o mesmo begin/add/finish por baixo.
 *
 * Rode com: node scripts/test-kontakt-capture.mjs
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

async function compileToNode(entry) {
  const outfile = path.join(
    os.tmpdir(),
    `mrq-kontakt-capture-test-${path.basename(entry, '.ts')}-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`
  );
  await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'es2020',
    outfile,
    // mrqFormat.ts faz `invoke('tauri...')` só em tempo de execução dentro
    // de funções que este teste nunca chama (`mrqBuilderBegin`/etc.) — não
    // precisa mockar `window`/Tauri aqui, só resolver a importação.
  });
  return import(`file://${outfile}`);
}

const {
  parseCapturedFileName,
  computeAutoVelocityAndRoundRobin,
  computeAutoKeyRanges,
  findDuplicateGroups,
  buildCaptureInstrumentModel,
} = await compileToNode('src/audio/rack/kontaktCapture.ts');

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  OK   - ${name}`);
  } else {
    console.error(`  FAIL - ${name}`);
    failures += 1;
  }
}

// ---------- parseCapturedFileName ----------
console.log('parseCapturedFileName: heurística de nome de arquivo');
{
  const r = parseCapturedFileName('Piano_C3_v100.wav');
  check('nota por nome (C3 -> 60, convenção C3=60)', r.rootNote === 60);
  check('velocidade por prefixo v100', r.velocity === 100);
  check('sem round robin detectado', r.roundRobinTag === null);
}
{
  const r = parseCapturedFileName('Strings_Db4_vel064_rr2.aiff');
  check('nota com bemol (Db4)', r.rootNote !== null);
  check('velocidade por prefixo vel064', r.velocity === 64);
  check('round robin explícito rr2', r.roundRobinTag === '2');
}
{
  const r = parseCapturedFileName('Brass-key060-100vel-a.wav');
  check('nota por número explícito key060', r.rootNote === 60);
  check('velocidade por sufixo 100vel', r.velocity === 100);
  check('round robin por sufixo de letra (a)', r.roundRobinTag === 'a');
}
{
  const r = parseCapturedFileName('Sustain_A4_pp.wav');
  check('articulação reconhecida (sustain)', r.articulation === 'sustain');
}
{
  const r = parseCapturedFileName('arquivo-sem-padrao-nenhum.wav');
  check('nome sem padrão reconhecível: nota null (nunca um palpite)', r.rootNote === null);
  check('nome sem padrão reconhecível: velocidade null', r.velocity === null);
}
{
  // "v" sozinho (sem dígitos) não deveria casar com nada.
  const r = parseCapturedFileName('Violin_v_sustain.wav');
  check('"v" sem número não é confundido com velocidade', r.velocity === null);
}

// ---------- computeAutoVelocityAndRoundRobin ----------
console.log('\ncomputeAutoVelocityAndRoundRobin: faixas de velocity + round robin automáticos');
{
  const entries = [
    { id: 's32', group: 'Sustain', rootNote: 60, velocity: 32 },
    { id: 's64', group: 'Sustain', rootNote: 60, velocity: 64 },
    { id: 's96', group: 'Sustain', rootNote: 60, velocity: 96 },
    { id: 's127', group: 'Sustain', rootNote: 60, velocity: 127 },
  ];
  const result = computeAutoVelocityAndRoundRobin(entries);
  const bands = ['s32', 's64', 's96', 's127'].map((id) => result.get(id));
  check('todas as 4 amostras receberam uma faixa', bands.every(Boolean));
  check('faixas contíguas começam em 0', bands[0].loVel === 0);
  check('faixas contíguas terminam em 127', bands[3].hiVel === 127);
  check(
    'faixas não se sobrepõem e são contíguas (sem buraco)',
    bands[0].hiVel + 1 === bands[1].loVel && bands[1].hiVel + 1 === bands[2].loVel && bands[2].hiVel + 1 === bands[3].loVel
  );
  check('nenhuma das 4 (velocidades distintas) virou round robin', bands.every((b) => !b.roundRobinGroup));
}
{
  // Duas amostras na MESMA nota+velocidade = candidatas a round robin da
  // MESMA camada (não duas faixas de velocity separadas).
  const entries = [
    { id: 'rr-a', group: 'Sustain', rootNote: 67, velocity: 100 },
    { id: 'rr-b', group: 'Sustain', rootNote: 67, velocity: 100 },
    { id: 'rr-c', group: 'Sustain', rootNote: 67, velocity: 100 },
  ];
  const result = computeAutoVelocityAndRoundRobin(entries);
  const a = result.get('rr-a');
  const b = result.get('rr-b');
  const c = result.get('rr-c');
  check('as 3 amostras ficam na MESMA faixa de velocity (0-127, única velocidade na nota)', a.loVel === 0 && a.hiVel === 127);
  check('todas no mesmo grupo de round robin', a.roundRobinGroup && a.roundRobinGroup === b.roundRobinGroup && b.roundRobinGroup === c.roundRobinGroup);
  check('índices de round robin distintos e em ordem (0,1,2)', [a, b, c].map((x) => x.roundRobinIndex).join(',') === '0,1,2');
}
{
  // Notas diferentes têm faixas independentes uma da outra.
  const entries = [
    { id: 'n60', group: 'Sustain', rootNote: 60, velocity: 50 },
    { id: 'n72', group: 'Sustain', rootNote: 72, velocity: 50 },
  ];
  const result = computeAutoVelocityAndRoundRobin(entries);
  check('notas diferentes não compartilham round robin mesmo com velocidade igual', !result.get('n60').roundRobinGroup && !result.get('n72').roundRobinGroup);
  check('ambas cobrem 0-127 (única velocidade em cada nota)', result.get('n60').loVel === 0 && result.get('n60').hiVel === 127);
}
{
  // Amostra sem velocidade detectada (null) fica de fora do cálculo.
  const entries = [{ id: 'novel', group: 'Sustain', rootNote: 60, velocity: null }];
  const result = computeAutoVelocityAndRoundRobin(entries);
  check('amostra sem velocidade detectada não recebe faixa automática', !result.has('novel'));
}
{
  // Mesma nota+velocidade, mas em GRUPOS diferentes (ex.: "Sustain" vs
  // "Staccato") NUNCA deve virar round robin cruzado entre grupos.
  const entries = [
    { id: 'sus-c3', group: 'Sustain', rootNote: 60, velocity: 100 },
    { id: 'stac-c3', group: 'Staccato', rootNote: 60, velocity: 100 },
  ];
  const result = computeAutoVelocityAndRoundRobin(entries);
  check(
    'mesma nota+velocidade em grupos diferentes não vira round robin entre grupos',
    !result.get('sus-c3').roundRobinGroup && !result.get('stac-c3').roundRobinGroup
  );
}

// ---------- computeAutoKeyRanges ----------
console.log('\ncomputeAutoKeyRanges: faixas de tecla automáticas por grupo');
{
  const entries = [
    { id: 'c2', group: 'Sustain', rootNote: 36 },
    { id: 'c3', group: 'Sustain', rootNote: 48 },
    { id: 'c4', group: 'Sustain', rootNote: 60 },
  ];
  const result = computeAutoKeyRanges(entries);
  const c2 = result.get('c2');
  const c3 = result.get('c3');
  const c4 = result.get('c4');
  check('primeira nota do grupo começa em 0', c2.loKey === 0);
  check('última nota do grupo termina em 127', c4.hiKey === 127);
  check('faixas contíguas e sem sobreposição', c2.hiKey + 1 === c3.loKey && c3.hiKey + 1 === c4.loKey);
}
{
  // Grupos diferentes têm faixas de tecla totalmente independentes.
  const entries = [
    { id: 'sus-60', group: 'Sustain', rootNote: 60 },
    { id: 'stac-72', group: 'Staccato', rootNote: 72 },
  ];
  const result = computeAutoKeyRanges(entries);
  check('grupo com uma única nota cobre o teclado inteiro (0-127), independente do outro grupo', result.get('sus-60').loKey === 0 && result.get('sus-60').hiKey === 127);
  check('o outro grupo também cobre 0-127 isoladamente', result.get('stac-72').loKey === 0 && result.get('stac-72').hiKey === 127);
}
{
  // Notas repetidas (round robin) no mesmo grupo/nota compartilham a faixa.
  const entries = [
    { id: 'rr1', group: 'Sustain', rootNote: 60 },
    { id: 'rr2', group: 'Sustain', rootNote: 60 },
  ];
  const result = computeAutoKeyRanges(entries);
  check('amostras round-robin da mesma nota compartilham faixa de tecla idêntica', JSON.stringify(result.get('rr1')) === JSON.stringify(result.get('rr2')));
}

// ---------- findDuplicateGroups ----------
console.log('\nfindDuplicateGroups: detecção de duplicados por hash de conteúdo');
{
  const groups = findDuplicateGroups([
    { id: 'a', hash: 'h1' },
    { id: 'b', hash: 'h2' },
    { id: 'c', hash: 'h1' },
    { id: 'd', hash: 'h3' },
    { id: 'e', hash: 'h2' },
  ]);
  check('encontra exatamente 2 grupos de duplicados (h1 e h2)', groups.length === 2);
  check('arquivo único (h3) não aparece em nenhum grupo', !groups.some((g) => g.includes('d')));
  const flat = groups.flat().sort();
  check('grupos cobrem exatamente a,b,c,e', JSON.stringify(flat) === JSON.stringify(['a', 'b', 'c', 'e']));
}
{
  const groups = findDuplicateGroups([{ id: 'a', hash: 'h1' }, { id: 'b', hash: 'h2' }]);
  check('nenhum duplicado quando todos os hashes são únicos', groups.length === 0);
}

// ---------- buildCaptureInstrumentModel ----------
console.log('\nbuildCaptureInstrumentModel: montagem do MrqInstrumentModel + relatório');
{
  let threw = false;
  try {
    buildCaptureInstrumentModel('Vazio', []);
  } catch {
    threw = true;
  }
  check('rejeita instrumento sem nenhuma zona (nunca grava um .mrq vazio)', threw);
}
{
  const { instrument, compatibility } = buildCaptureInstrumentModel('Meu Piano Capturado', [
    { sampleId: 's1', group: 'Sustain', rootNote: 60, loKey: 48, hiKey: 60, loVel: 0, hiVel: 127, stereo: 'stereo' },
    { sampleId: 's2', group: 'Sustain', rootNote: 72, loKey: 61, hiKey: 84, loVel: 0, hiVel: 127, stereo: 'mono' },
    { sampleId: 's3', group: 'Staccato', rootNote: 60, loKey: 48, hiKey: 84, loVel: 0, hiVel: 127, exclusiveGroup: 1 },
  ]);
  check('sourceFormat é "kontakt-capture"', instrument.sourceFormat === 'kontakt-capture');
  check('um único preset', instrument.presets.length === 1);
  check('dois grupos (Sustain e Staccato), na ordem de primeira aparição', instrument.presets[0].groups.map((g) => g.name).join(',') === 'Sustain,Staccato');
  check('grupo Sustain tem as 2 zonas certas', instrument.presets[0].groups[0].zones.length === 2);
  check('grupo Staccato tem a zona certa (com exclusiveGroup preservado)', instrument.presets[0].groups[1].zones[0].exclusiveGroup === 1);
  check('nome do instrumento preservado', instrument.name === 'Meu Piano Capturado');

  check('relatório marca Áudio como Preserved', compatibility.preserved.some((i) => i.field === 'Áudio'));
  check(
    'relatório marca nota/tecla/velocidade como Approximated (nunca Preserved — não vem do Kontakt original)',
    compatibility.approximated.some((i) => i.field.includes('velocidade'))
  );
  check('relatório marca grupo de exclusividade como Approximated (zona 3 usa exclusiveGroup)', compatibility.approximated.some((i) => i.field.includes('exclusividade')));
  check('relatório marca scripts KSP/efeitos como Unsupported', compatibility.unsupported.some((i) => i.field.toLowerCase().includes('ksp')));
  check('relatório marca pontos de loop como Unsupported', compatibility.unsupported.some((i) => i.field.toLowerCase().includes('loop')));
  check(
    'relatório NUNCA afirma que a captura recupera a estrutura original do Kontakt',
    !JSON.stringify(compatibility).toLowerCase().includes('estrutura original') ||
      compatibility.unsupported.some((i) => i.field.toLowerCase().includes('estrutura original'))
  );
}
{
  const { compatibility } = buildCaptureInstrumentModel('Sem round robin', [
    { sampleId: 's1', group: 'G', rootNote: 60, loKey: 0, hiKey: 127, loVel: 0, hiVel: 127 },
  ]);
  check('sem round robin em nenhuma zona: relatório não menciona Round robin', !compatibility.approximated.some((i) => i.field === 'Round robin'));
  check('sem exclusiveGroup em nenhuma zona: relatório não menciona Grupo de exclusividade', !compatibility.approximated.some((i) => i.field.includes('exclusividade')));
}

if (failures > 0) {
  console.error(`\n${failures} falha(s) em test-kontakt-capture.mjs`);
  process.exit(1);
} else {
  console.log('\nTodos os testes de test-kontakt-capture.mjs passaram.');
}
