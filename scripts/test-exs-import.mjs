#!/usr/bin/env node
/**
 * Teste de regressão do importador Logic EXS24 (.exs) —
 * src/audio/rack/ExsFile.ts / ExsLayerVoice.ts / exsImport.ts.
 *
 * Ao contrário do .nki (que depende de DOMParser/DecompressionStream, só
 * disponíveis num WebView real — ver test-nki-import.mjs), o parsing do
 * `.exs` em si (ExsFile.ts) é binário puro, sem nenhuma API de navegador —
 * então este teste consegue validar o parser de verdade, montando um `.exs`
 * sintético byte a byte (réplica do layout de bloco/zona/grupo/amostra
 * documentado no comentário de ExsFile.ts, vindo do código-fonte do
 * ConvertWithMoss) e conferindo que `parseExsFile` extrai exatamente os
 * valores esperados — não é só um teste de fumaça.
 *
 * Rode com: node scripts/test-exs-import.mjs
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

async function compileToNode(entry) {
  const outfile = path.join(
    os.tmpdir(),
    `exs-test-${path.basename(entry, '.ts')}-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`
  );
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

const { parseExsFile } = await compileToNode('src/audio/rack/ExsFile.ts');
const { buildInstrumentModel, buildCompatibilityReport, describeUnresolved } = await compileToNode(
  'src/audio/rack/exsImport.ts'
);

// ---------------------------------------------------------------------------
// Encoder sintético — réplica de EXS24Block.write/EXS24Zone.write/
// EXS24Group.write/EXS24Sample.write (ConvertWithMoss, LGPLv3), só o
// suficiente pra montar um arquivo de teste válido (little-endian, o layout
// "padrão" — não o legado big-endian).
// ---------------------------------------------------------------------------

function asciiBuf(str, len) {
  const buf = Buffer.alloc(len, 0);
  buf.write(str, 0, 'ascii');
  return buf;
}

function u32le(n) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(n >>> 0, 0);
  return buf;
}

function i8(n) {
  return n < 0 ? n + 256 : n;
}

function block(type, name, content) {
  const header = Buffer.concat([
    Buffer.from([1, 1, 0, type]), // little-endian, version 1.0, type
    u32le(content.length),
    u32le(0), // index
    u32le(0), // flags reservadas
    asciiBuf('TBOS', 4), // magic little-endian
    asciiBuf(name, 64),
  ]);
  assert.equal(header.length, 84, 'cabeçalho de bloco precisa ter 84 bytes');
  return Buffer.concat([header, content]);
}

function instrumentBlock(name) {
  const content = Buffer.concat([u32le(0), u32le(1), u32le(1), u32le(1), u32le(1), u32le(0), u32le(0), u32le(0), u32le(0), u32le(0)]);
  return block(0x00, name, content);
}

function zoneBlock({
  name,
  key,
  fineTuning = 0,
  pan = 0,
  volumeAdjust = 0,
  keyLow,
  keyHigh,
  velocityRangeOn = false,
  velocityLow = 0,
  velocityHigh = 127,
  coarseTuning = 0,
  pitchOff = false,
  groupIndex = -1,
  sampleIndex,
}) {
  const content = Buffer.alloc(96, 0);
  let o = 0;
  const zoneOpts = (pitchOff ? 0x02 : 0) | (velocityRangeOn ? 0x08 : 0);
  content.writeUInt8(zoneOpts, o); o += 1;
  content.writeUInt8(key, o); o += 1;
  content.writeUInt8(i8(fineTuning), o); o += 1;
  content.writeUInt8(i8(pan), o); o += 1;
  content.writeUInt8(i8(volumeAdjust), o); o += 1;
  content.writeUInt8(0, o); o += 1; // volumeScale
  content.writeUInt8(keyLow, o); o += 1;
  content.writeUInt8(keyHigh, o); o += 1;
  o += 1; // reserved
  content.writeUInt8(velocityLow, o); o += 1;
  content.writeUInt8(velocityHigh, o); o += 1;
  o += 1; // reserved
  o += 4 + 4 + 4 + 4 + 4; // sampleStart/sampleEnd/loopStart/loopEnd/loopCrossfade (0)
  o += 1; // loopTune
  o += 1; // loopOptions
  o += 1; // loopDirection
  o += 42; // reserved
  o += 1; // flexOptions
  o += 1; // flexSpeed
  o += 1; // tailTune
  content.writeUInt8(i8(coarseTuning), o); o += 1;
  o += 1; // reserved
  o += 1; // output
  o += 5; // reserved
  content.writeInt32LE(groupIndex, o); o += 4;
  content.writeInt32LE(sampleIndex, o); o += 4;
  assert.ok(o <= content.length, 'zona sintética estourou o buffer de teste');
  return block(0x01, name, content);
}

function groupBlock(name, volume, pan) {
  const content = Buffer.alloc(92, 0);
  content.writeUInt8(i8(volume), 0);
  content.writeUInt8(i8(pan), 1);
  return block(0x02, name, content);
}

function sampleBlock({ fileName, filePath = '', sampleRate = 44100, bitDepth = 16, channels = 2, waveDataStart = 0, isCompressed = false }) {
  const content = Buffer.alloc(80 + 256 + 256, 0);
  let o = 0;
  content.writeUInt32LE(waveDataStart, o); o += 4;
  content.writeUInt32LE(1000, o); o += 4; // length
  content.writeUInt32LE(sampleRate, o); o += 4;
  content.writeUInt32LE(bitDepth, o); o += 4;
  content.writeUInt32LE(channels, o); o += 4;
  content.writeUInt32LE(channels, o); o += 4; // channels2
  o += 4; // reserved
  asciiBuf('WAVE', 4).copy(content, o); o += 4;
  content.writeUInt32LE(123456, o); o += 4; // size
  content.writeUInt32LE(isCompressed ? 1 : 0, o); o += 4;
  o += 40; // reserved
  asciiBuf(filePath, 256).copy(content, o); o += 256;
  asciiBuf(fileName, 256).copy(content, o); o += 256;
  assert.equal(o, content.length);
  return block(0x03, fileName, content);
}

// ---------------------------------------------------------------------------
// Caso 1: instrumento simples, uma zona por tecla, com grupo aplicando gain/pan
// ---------------------------------------------------------------------------

function buildSimpleExs() {
  const parts = [
    instrumentBlock('Piano Teste'),
    zoneBlock({ name: 'Zona C3', key: 60, keyLow: 48, keyHigh: 72, coarseTuning: 0, fineTuning: 25, groupIndex: 0, sampleIndex: 0, volumeAdjust: -3, pan: 10 }),
    zoneBlock({
      name: 'Zona Kick',
      key: 36,
      keyLow: 36,
      keyHigh: 36,
      pitchOff: true,
      velocityRangeOn: true,
      velocityLow: 100,
      velocityHigh: 127,
      groupIndex: -1,
      sampleIndex: 1,
    }),
    groupBlock('Grupo 1', 6, -20), // +6dB, pan -20 (-0.4 normalizado)
    sampleBlock({ fileName: 'piano_c3.wav' }),
    sampleBlock({ fileName: 'kick.wav' }),
  ];
  return Buffer.concat(parts).buffer.slice(0, Buffer.concat(parts).length);
}

function toArrayBuffer(buf) {
  const ab = new ArrayBuffer(buf.length);
  new Uint8Array(ab).set(buf);
  return ab;
}

function run() {
  const simpleBuf = toArrayBuffer(Buffer.concat([
    instrumentBlock('Piano Teste'),
    zoneBlock({ name: 'Zona C3', key: 60, keyLow: 48, keyHigh: 72, fineTuning: 25, groupIndex: 0, sampleIndex: 0, volumeAdjust: -3, pan: 10 }),
    zoneBlock({
      name: 'Zona Kick',
      key: 36,
      keyLow: 0,
      keyHigh: 127,
      pitchOff: true,
      velocityRangeOn: true,
      velocityLow: 100,
      velocityHigh: 127,
      groupIndex: -1,
      sampleIndex: 1,
    }),
    groupBlock('Grupo 1', 6, -20),
    sampleBlock({ fileName: 'piano_c3.wav' }),
    sampleBlock({ fileName: 'kick.wav' }),
  ]));

  const parsed = parseExsFile(simpleBuf);

  assert.equal(parsed.instrument?.name, 'Piano Teste', 'nome do instrumento');
  assert.equal(parsed.zones.length, 2, 'duas zonas');
  assert.equal(parsed.samples.length, 2, 'duas amostras');

  const [zoneC3, zoneKick] = parsed.zones;

  assert.equal(zoneC3.key, 60);
  assert.equal(zoneC3.keyLow, 48);
  assert.equal(zoneC3.keyHigh, 72);
  // tuneCents = coarseTuning*100 + fineTuning = 0*100 + 25 = 25
  assert.equal(zoneC3.tuneCents, 25, 'afinação fina em cents');
  // gainDb = volumeAdjust(-3) + group.volume(6) = 3, dentro do grupo 0
  assert.equal(zoneC3.gainDb, 3, 'ganho combinado zona+grupo');
  // pan = clamp(10,-50,50)/50 = 0.2, grupo não aplicado (zona sem grupo? tem groupIndex 0)
  assert.ok(Math.abs(zoneC3.pan - (0.2 + -20 / 50)) < 1e-9, 'pan combinado zona+grupo');
  assert.equal(zoneC3.unsupportedAudio, false, 'amostra comum, sem flags de monolito/compressão');

  assert.equal(zoneKick.pitch, false, 'switch de pitch desligado detectado');
  // zona sem pitch tracking: keyLow/keyHigh forçados pra key (36), mesmo
  // tendo sido escritos como 0..127 no arquivo sintético — valida a trava
  // de segurança descrita no comentário de ExsZone.pitch.
  assert.equal(zoneKick.keyLow, 36);
  assert.equal(zoneKick.keyHigh, 36);
  assert.equal(zoneKick.velocityRangeOn, true);
  assert.equal(zoneKick.velocityLow, 100);
  assert.equal(zoneKick.velocityHigh, 127);
  assert.equal(zoneKick.groupIndex, -1, 'zona sem grupo não deve ganhar gain/pan de grupo nenhum');
  assert.equal(zoneKick.gainDb, 0);

  assert.equal(parsed.samples[0].fileName, 'piano_c3.wav');
  assert.equal(parsed.samples[1].fileName, 'kick.wav');

  console.log('✓ parseExsFile: instrumento/zonas/grupo/amostras lidos corretamente');

  // -------------------------------------------------------------------------
  // Caso 2: amostra consolidada (waveDataStart != 0) marcada como
  // unsupportedAudio, sem derrubar o parsing do resto do arquivo.
  // -------------------------------------------------------------------------
  const consolidatedBuf = toArrayBuffer(Buffer.concat([
    instrumentBlock('Instrumento Consolidado'),
    zoneBlock({ name: 'Zona A', key: 60, keyLow: 60, keyHigh: 60, groupIndex: -1, sampleIndex: 0 }),
    sampleBlock({ fileName: 'tudo.caf', waveDataStart: 44100 }),
  ]));
  const parsedConsolidated = parseExsFile(consolidatedBuf);
  assert.equal(parsedConsolidated.zones[0].unsupportedAudio, true, 'waveDataStart != 0 deve marcar unsupportedAudio');
  console.log('✓ parseExsFile: amostra consolidada (waveDataStart != 0) marcada como não suportada, sem quebrar o parsing');

  // -------------------------------------------------------------------------
  // Caso 3: arquivo que não é um .exs de verdade — erro específico, não um
  // crash genérico.
  // -------------------------------------------------------------------------
  const garbage = toArrayBuffer(Buffer.from('isso definitivamente nao e um exs, so texto qualquer aqui pra encher 84+ bytes de lixo mesmo'));
  assert.throws(() => parseExsFile(garbage), /não parece ser um \.exs/, 'arquivo inválido deve lançar erro específico');
  console.log('✓ parseExsFile: arquivo inválido rejeitado com mensagem específica (não um crash genérico)');

  // -------------------------------------------------------------------------
  // buildInstrumentModel / buildCompatibilityReport (adaptação de saída,
  // mesmo padrão de nkiImport.ts) — usando uma instância falsa de
  // "ExsExportedInstrument" (a mesma forma que ExsLayerVoice.exportForMrqi()
  // devolve de verdade).
  // -------------------------------------------------------------------------
  const fakeBuffer = { numberOfChannels: 2, length: 10, sampleRate: 44100, getChannelData: () => new Float32Array(10) };
  const exported = {
    instrumentName: 'Piano Teste',
    zones: [
      {
        buffer: fakeBuffer,
        samplePath: 'piano_c3.wav',
        rootNote: 60,
        loNote: 48,
        hiNote: 72,
        loVel: 0,
        hiVel: 127,
        tuneCents: 25,
        gainDb: 3,
        pan: -0.2,
      },
    ],
  };
  const { instrument, sampleRefs } = buildInstrumentModel(exported);
  assert.equal(instrument.name, 'Piano Teste');
  assert.equal(instrument.sourceFormat, 'exs');
  assert.equal(instrument.presets[0].groups[0].zones[0].volumeDb, 3);
  assert.equal(sampleRefs.length, 1);
  console.log('✓ buildInstrumentModel: zona EXS24 convertida pro modelo .mrq corretamente');

  const report = buildCompatibilityReport([{ samplePath: 'tudo.caf', reason: 'unsupported-codec' }]);
  assert.ok(report.unsupported.some((u) => u.detail.includes('tudo.caf')), 'relatório deve citar a amostra não suportada por nome');
  console.log('✓ buildCompatibilityReport: amostra não suportada aparece no relatório, não é omitida');

  const msg = describeUnresolved({ samplePath: 'x/tudo.caf', reason: 'unsupported-codec' });
  assert.ok(msg.includes('tudo.caf'), 'describeUnresolved deve citar o nome do arquivo');
  console.log('✓ describeUnresolved: mensagem honesta gerada');

  console.log('\nTodos os testes do importador EXS24 passaram.');
}

run();
