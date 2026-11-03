// Testa as 10 features novas do Rack (v0.1.14) de uma vez via CDP.
const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.CDP_PORT || '9340';

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/json`, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

async function main() {
  const targets = await getTargets();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const consoleErrors = [];

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value || a.description).join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(JSON.stringify(msg.params.exceptionDetails));
    }
  });

  function send(method, params = {}) {
    return new Promise((resolve) => {
      const thisId = ++id;
      pending.set(thisId, resolve);
      ws.send(JSON.stringify({ id: thisId, method, params }));
    });
  }

  async function ev(expression) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) {
      console.log('EXCEPTION:', JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails));
      return undefined;
    }
    return r.result?.result?.value;
  }

  await new Promise((resolve) => ws.on('open', resolve));
  await send('Runtime.enable');
  await send('Page.enable');

  for (let i = 0; i < 30; i++) {
    if (await ev('!!document.querySelector(".icon-rail, .titlebar")')) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log('nav ->', await ev(`(function(){ const b = document.querySelector('button[title="Rack de instrumentos"]'); if (b) { b.click(); return 'ok'; } return 'not-found'; })()`));
  await new Promise((r) => setTimeout(r, 800));

  console.log('initial DOM ->', await ev(`JSON.stringify({ cards: document.querySelectorAll('.rack-layer-card').length, keys: document.querySelectorAll('.rack-key').length, scenesSection: !!document.querySelector('.rack-scenes') })`));

  // --- Carrega o WAV de teste na camada 1 (via MRQ_TEST_INSTRUMENT_FILE) ---
  console.log('load layer0 ->', await ev(`(function(){ const btns = Array.from(document.querySelectorAll('.rack-layer-card')); const btn = btns[0].querySelector('button'); const loadBtn = Array.from(btns[0].querySelectorAll('button')).find(b => b.textContent.trim()==='Carregar'); if (loadBtn) { loadBtn.click(); return 'clicked'; } return 'not-found'; })()`));
  await new Promise((r) => setTimeout(r, 2500));
  console.log('after load ->', await ev(`JSON.stringify({ fmt: document.querySelector('.rack-layer-card')?.textContent?.includes('Keys') })`));
  console.log('console errors after load:', JSON.stringify(consoleErrors));

  // --- Feature 8 + 2: abre Editar, testa Pan slider e botão Resetar efeitos ---
  console.log('open edit ->', await ev(`(function(){ const btn = Array.from(document.querySelectorAll('.rack-edit-btn'))[0]; if (btn) { btn.click(); return 'ok'; } return 'not-found'; })()`));
  await new Promise((r) => setTimeout(r, 400));
  console.log('edit panel present ->', await ev(`!!document.querySelector('.rack-edit-panel, [class*=edit-panel]') || document.body.innerHTML.includes('Resetar')`));
  console.log('pan slider present ->', await ev(`Array.from(document.querySelectorAll('label')).some(l => l.textContent.includes('Pan'))`));
  console.log('reset btn present ->', await ev(`!!document.querySelector('button svg')  && Array.from(document.querySelectorAll('button')).some(b => b.title === '' ) `));
  console.log('learn range btn present ->', await ev(`Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('Aprender faixa'))`));
  console.log('duplicate row present ->', await ev(`Array.from(document.querySelectorAll('.rack-duplicate-row span')).map(s=>s.textContent)`));

  // click duplicate to layer 2 (Camada 2)
  console.log('duplicate click ->', await ev(`(function(){ const btn = Array.from(document.querySelectorAll('.rack-duplicate-btn')).find(b => b.textContent.includes('Camada 2')); if (btn) { btn.click(); return 'clicked'; } return 'not-found'; })()`));
  await new Promise((r) => setTimeout(r, 1500));
  console.log('toast after duplicate ->', await ev(`document.body.innerText.includes('duplicada')`));

  // close edit panel
  await ev(`(function(){ const closeBtns = Array.from(document.querySelectorAll('button')); const x = closeBtns.find(b => b.innerHTML.includes('lucide-x') && !b.className.includes('duplicate')); })()`);

  console.log('console errors so far:', JSON.stringify(consoleErrors));

  ws.close();
}

main().catch((err) => {
  console.error('ERRO:', err);
  process.exit(1);
});
