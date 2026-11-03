#!/usr/bin/env node
/**
 * Teste de regressão pra stripUnknownSf2InfoChunks
 * (src/audio/rack/sf2InfoSanitize.ts) — a sanitização defensiva de SF2 feita
 * ANTES de entregar o arquivo pro FluidSynth-WASM (ver nota longa no topo
 * daquele arquivo, e o uso em Sf2LayerVoice.ts#load).
 *
 * Mesmo padrão de scripts/test-mrq-rack-layer.mjs: compila o módulo TS de
 * verdade com esbuild pra CJS/Node e testa a função exportada diretamente —
 * aqui isso é trivial porque o módulo não tem NENHUMA dependência de
 * browser/AudioContext/js-synthesizer, foi extraído justamente por isso.
 *
 * Rode com: node scripts/test-sf2-info-sanitize.mjs
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
    `sf2-sanitize-test-${path.basename(entry, '.ts')}-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`
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

const { stripUnknownSf2InfoChunks } = await compileToNode('src/audio/rack/sf2InfoSanitize.ts');

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  OK   - ${name}`);
  } else {
    console.error(`  FAIL - ${name}`);
    failures += 1;
  }
}

// ---------- helpers pra montar um .sf2 sintético mínimo ----------

function u32le(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

function chunk(id, dataBuf) {
  const size = dataBuf.length;
  const padded = size % 2 === 0 ? dataBuf : Buffer.concat([dataBuf, Buffer.from([0])]);
  return Buffer.concat([Buffer.from(id, 'ascii'), u32le(size), padded]);
}

function listChunk(formType, innerChunksBuf) {
  const body = Buffer.concat([Buffer.from(formType, 'ascii'), innerChunksBuf]);
  return chunk('LIST', body);
}

function sfbk(listChunks) {
  const body = Buffer.concat([Buffer.from('sfbk', 'ascii'), Buffer.concat(listChunks)]);
  return chunk('RIFF', body);
}

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function readFourCC(view, offset) {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );
}

// ---------- caso 1: SF2 100% padrão, nenhum chunk desconhecido ----------
{
  const info = Buffer.concat([
    chunk('ifil', Buffer.from([2, 0, 4, 0])),
    chunk('isng', Buffer.from('EMU8000\0', 'ascii')),
    chunk('INAM', Buffer.from('Piano Teste\0', 'ascii')),
  ]);
  const sdta = Buffer.concat([chunk('smpl', Buffer.alloc(10))]);
  const pdta = Buffer.concat([chunk('phdr', Buffer.alloc(38))]);
  const file = sfbk([listChunk('INFO', info), listChunk('sdta', sdta), listChunk('pdta', pdta)]);
  const inputAb = toArrayBuffer(file);

  const result = stripUnknownSf2InfoChunks(inputAb);
  check('arquivo sem chunks desconhecidos: nenhum removido', result.removedChunkIds.length === 0);
  check('arquivo sem chunks desconhecidos: buffer retornado é o MESMO objeto (sem cópia)', result.buffer === inputAb);
}

// ---------- caso 2: SF2 com chunk INFO desconhecido (ex.: DMOD) ----------
{
  const info = Buffer.concat([
    chunk('ifil', Buffer.from([2, 0, 4, 0])),
    chunk('isng', Buffer.from('EMU8000\0', 'ascii')),
    chunk('INAM', Buffer.from('Piano Teste\0', 'ascii')),
    chunk('DMOD', Buffer.alloc(10, 0xff)), // chunk fora do whitelist, que o FluidSynth 2.4.6 rejeita
    chunk('ISFT', Buffer.from('Polyphone\0', 'ascii')),
  ]);
  const sdta = Buffer.concat([chunk('smpl', Buffer.alloc(10))]);
  const pdta = Buffer.concat([chunk('phdr', Buffer.alloc(38))]);
  const file = sfbk([listChunk('INFO', info), listChunk('sdta', sdta), listChunk('pdta', pdta)]);
  const inputAb = toArrayBuffer(file);

  const result = stripUnknownSf2InfoChunks(inputAb);
  check('DMOD é detectado e removido', result.removedChunkIds.includes('DMOD'));
  check('só o DMOD foi removido (1 chunk)', result.removedChunkIds.length === 1);
  check('buffer de saída é uma cópia nova (não o mesmo objeto)', result.buffer !== inputAb);

  const outView = new DataView(result.buffer);
  check('RIFF/sfbk ainda válidos depois da sanitização', readFourCC(outView, 0) === 'RIFF' && readFourCC(outView, 8) === 'sfbk');

  // Reconstroi manualmente a lista de chunks pra confirmar que ifil/isng/INAM/ISFT sobreviveram e DMOD sumiu.
  const outBytes = new Uint8Array(result.buffer);
  const ids = [];
  let offset = 12;
  while (offset + 8 <= outBytes.length) {
    const id = readFourCC(outView, offset);
    const size = outView.getUint32(offset + 4, true);
    if (id === 'LIST' && readFourCC(outView, offset + 8) === 'INFO') {
      let io = offset + 12;
      const end = offset + 8 + size;
      while (io + 8 <= end) {
        const subId = readFourCC(outView, io);
        const subSize = outView.getUint32(io + 4, true);
        ids.push(subId);
        io += 8 + subSize + (subSize % 2);
      }
    }
    offset += 8 + size + (size % 2);
  }
  check('ifil sobreviveu', ids.includes('ifil'));
  check('isng sobreviveu', ids.includes('isng'));
  check('INAM sobreviveu', ids.includes('INAM'));
  check('ISFT sobreviveu', ids.includes('ISFT'));
  check('DMOD não está mais presente', !ids.includes('DMOD'));
  check('RIFF declarado bate com o tamanho real do buffer', outView.getUint32(4, true) === result.buffer.byteLength - 8);
}

// ---------- caso 3: buffer que não é um RIFF/sfbk válido ----------
{
  const notSf2 = toArrayBuffer(Buffer.from('isso definitivamente não é um soundfont', 'utf8'));
  const result = stripUnknownSf2InfoChunks(notSf2);
  check('buffer inválido: devolve o original sem lançar exceção', result.buffer === notSf2 && result.removedChunkIds.length === 0);
}

// ---------- caso 4: buffer vazio / minúsculo demais ----------
{
  const tiny = toArrayBuffer(Buffer.from('RIFF', 'ascii'));
  const result = stripUnknownSf2InfoChunks(tiny);
  check('buffer minúsculo demais: devolve o original sem lançar exceção', result.buffer === tiny && result.removedChunkIds.length === 0);
}

console.log('');
if (failures > 0) {
  console.error(`${failures} falha(s).`);
  process.exit(1);
} else {
  console.log('Todos os testes de stripUnknownSf2InfoChunks passaram.');
}
