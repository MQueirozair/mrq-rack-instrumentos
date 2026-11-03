#!/usr/bin/env node
/**
 * Teste de regressão do importador .syx (Fase 5 do MRQ Instrument Converter,
 * src/audio/rack/syxImport.ts + offline-src/Dx7OfflineRender.ts).
 *
 * Não usa um framework de testes (o projeto não tem um configurado, ver
 * scripts/test-part-recognition.mjs) — compila os dois módulos TS com
 * esbuild pra CJS/Node (o jeito mais direto de testar os módulos de verdade,
 * não uma reimplementação paralela da lógica) e roda cenários sintéticos
 * direto contra as funções exportadas.
 *
 * NÃO testa `convertSyxToMrq` (exige Tauri de verdade: `window.api.fs` e os
 * comandos `mrq_builder_*`) — só a metade pura/determinística: parsing
 * (`parseSyxVoices`), a matemática de zonas (`inspectSyx`) e o render em si
 * (`renderDx7Note`, que não depende de navegador/AudioContext, só de
 * BigInt — disponível em qualquer Node moderno).
 *
 * Rode com: node scripts/test-syx-import.mjs
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { INIT } from '@audio/synth-dx7';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

async function compileToNode(entry) {
  const outfile = path.join(os.tmpdir(), `syx-test-${path.basename(entry, '.ts')}-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`);
  await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'es2020',
    outfile,
  });
  return import(`file://${outfile}`);
}

const { parseSyxVoices, isDx7RenderSupported, inspectSyx } = await compileToNode(
  'src/audio/rack/syxImport.ts'
);
const { renderDx7Note } = await compileToNode('src/audio/rack/offline-src/Dx7OfflineRender.ts');

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  OK   - ${name}`);
  } else {
    failures++;
    console.log(`  FAIL - ${name}`);
  }
}

function section(title, fn) {
  console.log(`\n${title}`);
  fn();
}

/** Monta um .syx VCED (voz única) sintético a partir de um patch de 155
 *  bytes — header `F0 43 00 00 01 1B` (Yamaha, canal 0, sub-status 0 =
 *  VCED, contagem 155 em 14 bits: 0x01 0x1B), o patch, 1 byte de checksum
 *  (não verificado pelo parser) e `F7` de fim de sysex. Ver README do
 *  @audio/synth-dx7, seção "Sysex". */
function makeVcedSysex(patch) {
  return new Uint8Array([0xf0, 0x43, 0x00, 0x00, 0x01, 0x1b, ...patch, 0x00, 0xf7]);
}

const initVoiceSysex = makeVcedSysex(Array.from(INIT));

section('parseSyxVoices: VCED sintético (INIT VOICE)', () => {
  const voices = parseSyxVoices(initVoiceSysex);
  check('encontra exatamente 1 voz', voices.length === 1);
  check('nome é "INIT VOICE"', voices[0]?.name === 'INIT VOICE');
  check('index começa em 0', voices[0]?.index === 0);
});

section('parseSyxVoices: dados inválidos não derrubam o processo', () => {
  let threw = false;
  try {
    parseSyxVoices(new Uint8Array([1, 2, 3]));
  } catch {
    threw = true;
  }
  check('lança um erro JS normal (não trava/crasha) pra dado sem sentido', threw);
});

section('isDx7RenderSupported: Node tem BigInt', () => {
  check('retorna true', isDx7RenderSupported() === true);
});

function assertFullKeyCoverage(zones, label) {
  const sorted = [...zones].sort((a, b) => a.loKey - b.loKey);
  check(`${label}: primeira zona começa em 0`, sorted[0]?.loKey === 0);
  check(`${label}: última zona termina em 127`, sorted[sorted.length - 1]?.hiKey === 127);
  let gapOrOverlap = false;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].loKey !== sorted[i - 1].hiKey + 1) gapOrOverlap = true;
  }
  check(`${label}: zonas contíguas, sem buraco nem sobreposição`, !gapOrOverlap);
}

section('inspectSyx: modelo de instrumento (passo padrão, 7 semitons)', () => {
  const result = inspectSyx(initVoiceSysex, {}, 'Teste DX7');
  check('1 preset (1 voz)', result.instrument.presets.length === 1);
  check('sourceFormat é "syx-dx7"', result.instrument.sourceFormat === 'syx-dx7');
  const zones = result.instrument.presets[0].groups[0].zones;
  check('gera mais de uma zona (notas representativas)', zones.length > 1);
  assertFullKeyCoverage(zones, 'passo 7');
  check('relatório tem itens em preserved/approximated/unsupported', 
    result.compatibility.preserved.length > 0 &&
    result.compatibility.approximated.length > 0 &&
    result.compatibility.unsupported.length > 0);
});

section('inspectSyx: cobertura de teclado com passos extremos', () => {
  const dense = inspectSyx(initVoiceSysex, { noteStepSemitones: 1 }, 'Teste DX7').instrument.presets[0].groups[0].zones;
  check('passo 1 semitom: 128 zonas (uma por tecla)', dense.length === 128);
  assertFullKeyCoverage(dense, 'passo 1');

  const sparse = inspectSyx(initVoiceSysex, { noteStepSemitones: 127 }, 'Teste DX7').instrument.presets[0].groups[0].zones;
  assertFullKeyCoverage(sparse, 'passo 127 (mínimo de notas)');
});

section('renderDx7Note: INIT VOICE (um seno) produz áudio de verdade', () => {
  const samples = renderDx7Note({
    patch: INIT,
    note: 69, // A4 = 440Hz
    velocity: 100,
    sampleRateHz: 44100,
    durationSeconds: 0.2,
    releaseSeconds: 0.2,
  });
  check('retorna um Float32Array', samples instanceof Float32Array);
  check('não está vazio', samples.length > 0);
  check('duração aproximada (tecla + release, +/- um bloco de 64 amostras)',
    Math.abs(samples.length - 0.4 * 44100) < 64 * 4);
  let hasNonZero = false;
  let hasNaNOrInfinity = false;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i] !== 0) hasNonZero = true;
    if (!Number.isFinite(samples[i])) hasNaNOrInfinity = true;
  }
  check('tem amostras não-zero (realmente soou)', hasNonZero);
  check('nenhuma amostra NaN/Infinity', !hasNaNOrInfinity);
});

section('renderDx7Note: notas diferentes produzem áudio diferente', () => {
  const low = renderDx7Note({ patch: INIT, note: 36, velocity: 100, sampleRateHz: 44100, durationSeconds: 0.1, releaseSeconds: 0.1 });
  const high = renderDx7Note({ patch: INIT, note: 96, velocity: 100, sampleRateHz: 44100, durationSeconds: 0.1, releaseSeconds: 0.1 });
  check('nota grave e nota aguda não geram o mesmo áudio', low.length !== high.length || !low.every((v, i) => v === high[i]));
});

console.log(failures === 0 ? `\nTodos os testes passaram.` : `\n${failures} teste(s) falharam.`);
process.exit(failures === 0 ? 0 : 1);
