#!/usr/bin/env node
/**
 * Teste de regressão do bug "SF2 não carrega, trava tudo" (relatado pelo
 * usuário em arquivos SF2 grandes de biblioteca comercial).
 *
 * Causa raiz: `readFileHeaderBytes` (src/audio/rack/converterFormats.ts),
 * usada pra espiar só os primeiros ~32 bytes de QUALQUER arquivo antes de
 * adicioná-lo à fila de importação (conferência de assinatura binária),
 * fazia um `fetch()` SEM cabeçalho `Range`. O protocolo customizado
 * `mrqfile://` (src-tauri/src/protocol.rs) só devolve uma fatia parcial
 * quando recebe `Range` — sem ele, ele lê e devolve o ARQUIVO INTEIRO de
 * propósito (ver comentário em `serve_file`). Resultado: espiar 32 bytes
 * de uma SoundFont comercial de vários GB forçava o backend Rust a ler o
 * arquivo inteiro pra memória e mandar tudo pro WebView2 ANTES do item
 * sequer entrar na fila do React — exatamente o freeze relatado (nenhum
 * item aparece na lista, nenhuma linha nova no log).
 *
 * Mesmo padrão de scripts/test-mrq-rack-layer.mjs: compila o módulo TS de
 * verdade com esbuild pra CJS/Node, stuba `window.api.fs.toFileUrl` e
 * `global.fetch`, e testa a função exportada diretamente — sem precisar de
 * um app Tauri de verdade.
 *
 * Rode com: node scripts/test-converter-header-read.mjs
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
    `mrq-converter-header-test-${path.basename(entry, '.ts')}-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`
  );
  await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'es2020',
    outfile,
    // mrqFormat.ts/nkiImport.ts/syxImport.ts fazem `invoke('tauri...')` só
    // em tempo de execução dentro de funções que este teste nunca chama —
    // não precisa mockar isso aqui, só precisa resolver a importação.
  });
  return import(`file://${outfile}`);
}

const { readFileHeaderBytes } = await compileToNode('src/audio/rack/converterFormats.ts');

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  OK   - ${name}`);
  } else {
    console.error(`  FAIL - ${name}`);
    failures += 1;
  }
}

// Stub de `window.api.fs.toFileUrl` — igual ao bridge Tauri real, só não
// precisa ser exatamente a mesma URL, já que o fetch abaixo é mockado.
globalThis.window = { api: { fs: { toFileUrl: async (p) => `mrqfile://local-file/${encodeURIComponent(p)}` } } };

// ---------- 1) a requisição TEM que mandar Range, nunca pedir o corpo
// inteiro só pra espiar alguns bytes ----------
{
  let capturedHeaders = null;
  globalThis.fetch = async (_url, init) => {
    capturedHeaders = (init && init.headers) || {};
    const body = new Uint8Array([0x66, 0x4c, 0x61, 0x43]); // "fLaC"
    return {
      ok: true,
      body: {
        getReader() {
          let done = false;
          return {
            async read() {
              if (done) return { done: true, value: undefined };
              done = true;
              return { done: false, value: body };
            },
            async cancel() {},
          };
        },
      },
    };
  };

  const out = await readFileHeaderBytes('/caminho/qualquer/arquivo.sf2', 32);
  const rangeValue = capturedHeaders && (capturedHeaders.Range || capturedHeaders.range);
  check('fetch() manda cabeçalho Range (nunca pede o arquivo inteiro)', typeof rangeValue === 'string' && rangeValue.length > 0);
  check('Range pede exatamente bytes=0-31 pra maxBytes=32', rangeValue === 'bytes=0-31');
  check('devolve os bytes recebidos sem alterar o conteúdo', out.length === 4 && out[0] === 0x66 && out[3] === 0x43);
}

// ---------- 2) simula literalmente o comportamento real do protocolo:
// COM Range ele devolve só a fatia pedida (rápido); SEM Range ele
// devolveria o arquivo inteiro (o bug). Confirma que o código novo cai
// sempre no primeiro caso, mesmo pra um arquivo "gigante" simulado. ----------
{
  const GIANT_SIZE = 4 * 1024 * 1024 * 1024; // 4GB simulado — nunca deve ser materializado
  let wholeFileWouldHaveBeenRead = false;

  globalThis.fetch = async (_url, init) => {
    const headers = (init && init.headers) || {};
    const range = headers.Range || headers.range;
    if (!range) {
      // Replica o protocolo real (serve_file): sem Range, "lê" o arquivo
      // inteiro. Só sinaliza aqui (não aloca de verdade) pra não estourar
      // memória do ambiente de teste.
      wholeFileWouldHaveBeenRead = true;
      return { ok: true, body: null };
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!match) throw new Error('Range malformado');
    const start = Number(match[1]);
    const end = Number(match[2]);
    const slice = new Uint8Array(end - start + 1).fill(0xab);
    return {
      ok: true,
      body: {
        getReader() {
          let done = false;
          return {
            async read() {
              if (done) return { done: true, value: undefined };
              done = true;
              return { done: false, value: slice };
            },
            async cancel() {},
          };
        },
      },
    };
  };

  const out = await readFileHeaderBytes(`/caminho/biblioteca-${GIANT_SIZE}-bytes.sf2`, 32);
  check('nunca cai no caminho "arquivo inteiro" do protocolo (sem isso, travaria em SF2 grande)', wholeFileWouldHaveBeenRead === false);
  check('recebe só os 32 bytes pedidos, não o arquivo gigante simulado', out.length === 32);
}

// ---------- 3) maxBytes customizado continua respeitado no Range ----------
{
  let capturedRange = null;
  globalThis.fetch = async (_url, init) => {
    capturedRange = ((init && init.headers) || {}).Range;
    return {
      ok: true,
      body: {
        getReader() {
          let done = false;
          return {
            async read() {
              if (done) return { done: true, value: undefined };
              done = true;
              return { done: false, value: new Uint8Array(8).fill(1) };
            },
            async cancel() {},
          };
        },
      },
    };
  };
  await readFileHeaderBytes('/qualquer.wav', 8);
  check('Range respeita um maxBytes customizado (bytes=0-7)', capturedRange === 'bytes=0-7');
}

if (failures > 0) {
  console.error(`\n${failures} falha(s) em test-converter-header-read.mjs`);
  process.exit(1);
} else {
  console.log('\nTodos os testes de test-converter-header-read.mjs passaram.');
}
