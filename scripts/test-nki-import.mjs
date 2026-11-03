#!/usr/bin/env node
/**
 * Teste de regressão do importador .nki (Fase 6 do MRQ Instrument Converter,
 * src/audio/rack/nkiImport.ts).
 *
 * Mesmo padrão de scripts/test-syx-import.mjs: compila o módulo TS de
 * verdade com esbuild pra CJS/Node e testa as funções exportadas
 * diretamente. Diferente de syxImport.ts, o parsing do .nki em si
 * (NkiLayerVoice.ts) depende de APIs só de navegador (DOMParser,
 * DecompressionStream, AudioContext.decodeAudioData, window.api.fs) — não
 * dá pra testar esse meio-caminho em Node puro sem reimplementar um
 * navegador inteiro. Por isso este teste cobre exatamente o que é NOVO
 * nesta fase (a parte que não depende de navegador):
 *
 *  1. `checkKnownUnsupportedExtension` — detecção de .nkx/.nkc/.nkb/.nkm
 *     (ver §6 do documento de arquitetura).
 *  2. `linearGainToDb` — conversão de ganho pro campo volumeDb do .mrq.
 *  3. `buildInstrumentModel`/`buildCompatibilityReport` — a adaptação de
 *     saída em si (zonas Kontakt → MrqInstrumentModel + relatório), usando
 *     um `NkiExportedInstrument` falso (a mesma forma que
 *     `NkiLayerVoice.exportForMrqi()` devolve de verdade) — não precisa de
 *     navegador porque a interface é estrutural (`NkiAudioBufferLike`, ver
 *     o comentário dela em nkiImport.ts).
 *  4. `describeUnresolved` — mensagens honestas pra amostra não encontrada
 *     vs. codec .ncw não suportado.
 *
 * A metade que SÓ dá pra testar manualmente/num WebView real (parsing do
 * zlib+XML, decodeAudioData, resolução de caminho no disco) continua sendo
 * a mesma lógica já usada (e presumivelmente já validada manualmente) pela
 * exportação .mrqi existente — nenhuma mudança foi feita nela além de
 * expor `unresolvedSamples` (ver NkiLayerVoice.ts).
 *
 * Rode com: node scripts/test-nki-import.mjs
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

async function compileToNode(entry) {
  const outfile = path.join(os.tmpdir(), `nki-test-${path.basename(entry, '.ts')}-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`);
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

const {
  checkKnownUnsupportedExtension,
  linearGainToDb,
  buildInstrumentModel,
  buildCompatibilityReport,
  describeUnresolved,
} = await compileToNode('src/audio/rack/nkiImport.ts');

// `inflateZlibPureJs` (NkiLayerVoice.ts) não depende de nenhuma API de
// navegador — é o fallback puro-JS (fflate) usado quando `DecompressionStream`
// não existe (WebKit do macOS 10.15-12.x, abaixo do Safari 16.4 — ver
// revisão técnica de compatibilidade NKI no macOS). Testável direto em Node.
const { inflateZlibPureJs } = await compileToNode('src/audio/rack/NkiLayerVoice.ts');

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

function throws(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}

section('checkKnownUnsupportedExtension: rejeita companheiros conhecidos do .nki', () => {
  check('.nkx (biblioteca protegida) lança erro', throws(() => checkKnownUnsupportedExtension('/libs/Piano.nkx')) !== null);
  check('.nkb (banco) lança erro', throws(() => checkKnownUnsupportedExtension('C:\\Kontakt\\Bank.nkb')) !== null);
  check('.nkm (multi) lança erro', throws(() => checkKnownUnsupportedExtension('multi.nkm')) !== null);
  check('.nkc lança erro', throws(() => checkKnownUnsupportedExtension('cache.nkc')) !== null);
  check('.nki de verdade NÃO lança erro', throws(() => checkKnownUnsupportedExtension('/patches/Rhodes.nki')) === null);
  check('maiúsculas também são pegas (.NKX)', throws(() => checkKnownUnsupportedExtension('Piano.NKX')) !== null);
});

section('linearGainToDb: conversão de ganho linear pra dB', () => {
  check('ganho 1.0 = 0dB', Math.abs(linearGainToDb(1.0) - 0) < 1e-9);
  check('ganho 0.5 ≈ -6.02dB', Math.abs(linearGainToDb(0.5) - -6.0206) < 0.01);
  check('ganho 2.0 ≈ +6.02dB', Math.abs(linearGainToDb(2.0) - 6.0206) < 0.01);
  check('ganho 0 não gera NaN/Infinity (piso em -120dB)', linearGainToDb(0) === -120);
  check('ganho negativo também cai no piso, não gera NaN', linearGainToDb(-5) === -120);
});

function fakeBuffer(channels = 1) {
  return {
    numberOfChannels: channels,
    length: 4,
    sampleRate: 44100,
    getChannelData: () => new Float32Array(4),
  };
}

function fakeZone(overrides = {}) {
  return {
    buffer: fakeBuffer(),
    samplePath: 'Samples/Note_C3.wav',
    rootNote: 60,
    loNote: 48,
    hiNote: 72,
    loVel: 0,
    hiVel: 127,
    tuneCents: 0,
    volume: 1,
    pan: 0,
    ...overrides,
  };
}

section('buildInstrumentModel: zonas Kontakt → MrqInstrumentModel', () => {
  const exported = {
    instrumentName: 'Rhodes Teste',
    groups: [
      { name: 'Grupo A', zones: [fakeZone(), fakeZone({ rootNote: 72, loNote: 73, hiNote: 96 })] },
      { name: 'Grupo B', zones: [fakeZone({ buffer: fakeBuffer(2), volume: 0.5 })] },
    ],
  };
  const { instrument, sampleRefs } = buildInstrumentModel(exported);
  check('sourceFormat é "nki"', instrument.sourceFormat === 'nki');
  check('nome do instrumento preservado', instrument.name === 'Rhodes Teste');
  check('2 grupos de timbre viram 2 presets', instrument.presets.length === 2);
  check('zonas do Grupo A preservadas (2 zonas)', instrument.presets[0].groups[0].zones.length === 2);
  check('zonas do Grupo B preservadas (1 zona)', instrument.presets[1].groups[0].zones.length === 1);
  check('3 referências de amostra no total (2+1)', sampleRefs.length === 3);
  check('sampleId de cada zona é único', new Set(sampleRefs.map((s) => s.sampleId)).size === sampleRefs.length);
  const zoneB = instrument.presets[1].groups[0].zones[0];
  check('volume 0.5 convertido pra dB (≈ -6dB)', Math.abs(zoneB.volumeDb - -6.0206) < 0.01);
  check('buffer estéreo marcado como "stereo"', zoneB.stereo === 'stereo');
  const zoneA = instrument.presets[0].groups[0].zones[0];
  check('buffer mono marcado como "mono"', zoneA.stereo === 'mono');
  check('rootNote/loKey/hiKey preservados', zoneA.rootNote === 60 && zoneA.loKey === 48 && zoneA.hiKey === 72);
});

section('buildCompatibilityReport: relatório honesto, inclusive sem falhas', () => {
  const clean = buildCompatibilityReport([]);
  check('sem amostras não resolvidas: preserved/approximated/unsupported não vazios', 
    clean.preserved.length > 0 && clean.approximated.length > 0 && clean.unsupported.length > 0);
  check('sem falhas: não inventa um item de "amostras não resolvidas"', 
    !clean.unsupported.some((i) => i.field.includes('não resolvida')));

  const withFailures = buildCompatibilityReport([
    { samplePath: 'Samples/Lost.wav', reason: 'not-found' },
    { samplePath: 'Samples/Comp.ncw', reason: 'unsupported-codec' },
  ]);
  const failureItem = withFailures.unsupported.find((i) => i.field.includes('não resolvida'));
  check('com falhas: relatório menciona "2 amostra(s) não resolvida(s)"', failureItem?.field.includes('2 amostra'));
  check('detalhe cobre a amostra não encontrada', failureItem?.detail.includes('Lost.wav'));
  check('detalhe cobre o codec .ncw não suportado', failureItem?.detail.includes('Comp.ncw'));
});

section('describeUnresolved: mensagens distinguem o motivo real', () => {
  const notFound = describeUnresolved({ samplePath: 'x/Y.wav', reason: 'not-found' });
  const codec = describeUnresolved({ samplePath: 'x/Y.ncw', reason: 'unsupported-codec' });
  check('"not-found" menciona não encontrada no disco', notFound.includes('não encontrada'));
  check('"unsupported-codec" menciona .ncw/codec proprietário', codec.includes('.ncw') && codec.toLowerCase().includes('codec'));
  check('as duas mensagens são diferentes (motivo real, não genérico)', notFound !== codec);
});

section('inflateZlibPureJs: fallback puro-JS (fflate) de descompressão zlib, sem DecompressionStream', () => {
  const original = Buffer.from('<Instrument><Name>Teste Catalina 🎹</Name></Instrument>', 'utf8');
  const zlibWrapped = zlib.deflateSync(original); // mesmo formato RFC1950 que DecompressionStream('deflate') espera
  const inflated = Buffer.from(inflateZlibPureJs(zlibWrapped));
  check('conteúdo decodificado bate exatamente com o original (inclusive UTF-8 não-ASCII)', inflated.equals(original));

  const raw = zlib.deflateRawSync(original); // sem cabeçalho zlib — não deve "acidentalmente" funcionar
  const rawFails = throws(() => inflateZlibPureJs(raw));
  check('corpo deflate "raw" (sem header zlib) lança erro em vez de devolver lixo', rawFails !== null);

  const garbage = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const garbageFails = throws(() => inflateZlibPureJs(garbage));
  check('bytes aleatórios lançam erro tratável (sem travar/pendurar o processo)', garbageFails !== null);

  const truncated = zlibWrapped.subarray(0, Math.floor(zlibWrapped.length / 2));
  const truncatedFails = throws(() => inflateZlibPureJs(truncated));
  check('zlib truncado no meio lança erro tratável', truncatedFails !== null);
});

console.log(failures === 0 ? `\nTodos os testes passaram.` : `\n${failures} teste(s) falharam.`);
process.exit(failures === 0 ? 0 : 1);
