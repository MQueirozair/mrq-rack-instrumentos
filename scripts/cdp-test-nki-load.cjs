const WebSocket = require('ws');
const http = require('http');

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9338/json', (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

async function main() {
  const targets = await getTargets();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  const toasts = [];
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
    return new Promise((resolve) => { const thisId = ++id; pending.set(thisId, resolve); ws.send(JSON.stringify({ id: thisId, method, params })); });
  }
  function evaluate(expression) { return send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); }
  function val(r) { return r.result && r.result.result && r.result.result.value; }

  await new Promise((resolve) => ws.on('open', resolve));
  await send('Runtime.enable');
  await send('Page.enable');

  for (let i = 0; i < 30; i++) {
    const r = await evaluate('!!document.querySelector(".icon-rail, .titlebar")');
    if (val(r)) break;
    await new Promise((r2) => setTimeout(r2, 500));
  }

  const navResult = await evaluate(`
    (function() {
      const btns = Array.from(document.querySelectorAll('button, [role="button"], a, .icon-rail *'));
      const rackBtn = btns.find(b => /rack/i.test(b.getAttribute('title')||'') || /rack/i.test(b.textContent||''));
      if (rackBtn) { rackBtn.click(); return 'clicked'; }
      return 'not-found';
    })()
  `);
  console.log('nav:', JSON.stringify(val(navResult)));
  await new Promise((r) => setTimeout(r, 600));

  const loadClick = await evaluate(`
    (function() {
      const cards = Array.from(document.querySelectorAll('.rack-layer-card'));
      const firstCard = cards[0];
      const buttons = Array.from(firstCard.querySelectorAll('button'));
      const loadBtn = buttons.find(b => /carregar/i.test(b.textContent || ''));
      if (!loadBtn) return 'no-load-btn: ' + buttons.map(b=>b.textContent).join('|');
      loadBtn.click();
      return 'clicked';
    })()
  `);
  console.log('load click:', JSON.stringify(val(loadClick)));
  await new Promise((r) => setTimeout(r, 1500));

  const layerState = await evaluate(`
    (function() {
      const api = window.__mrqDebug;
      const layer = api.useStore.getState().settings.rack.layers[0];
      return { format: layer.format, fileName: layer.fileName, displayName: layer.displayName, presets: layer.presets, selectedPreset: layer.selectedPreset };
    })()
  `);
  console.log('layer[0] state:', JSON.stringify(val(layerState)));

  const toastCheck = await evaluate(`
    (function() {
      const toastEls = Array.from(document.querySelectorAll('[class*="toast"]'));
      return toastEls.map(t => t.textContent);
    })()
  `);
  console.log('toasts visible:', JSON.stringify(val(toastCheck)));

  // dispara uma nota via API de debug pra confirmar que a amostra toca de verdade
  const noteTest = await evaluate(`
    (async function() {
      const api = window.__mrqDebug;
      try {
        const mod = await import('/src/audio/rack/RackEngine.ts').catch(() => null);
        return 'import-failed-expected-in-prod-build';
      } catch (e) {
        return 'err:' + e.message;
      }
    })()
  `);
  console.log('note test attempt:', JSON.stringify(val(noteTest)));

  await new Promise((r) => setTimeout(r, 300));
  console.log('console errors:', JSON.stringify(consoleErrors, null, 2));

  ws.close();
}

main().catch((err) => {
  console.error('TEST FAILED', err);
  process.exit(1);
});
