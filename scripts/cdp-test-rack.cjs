// Teste rápido via Chrome DevTools Protocol: navega até a aba Rack, abre o
// modal Editar da camada 1, alterna os toggles, e reporta erros de console.
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

  function evaluate(expression) {
    return send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  }

  await new Promise((resolve) => ws.on('open', resolve));
  await send('Runtime.enable');
  await send('Page.enable');

  // espera o app montar
  for (let i = 0; i < 30; i++) {
    const r = await evaluate('!!document.querySelector(".icon-rail, .titlebar")');
    if (r.result && r.result.result && r.result.result.value) break;
    await new Promise((r2) => setTimeout(r2, 500));
  }

  const navResult = await evaluate(`
    (function() {
      const btns = Array.from(document.querySelectorAll('button, [role="button"], a, .icon-rail *'));
      const rackBtn = btns.find(b => /rack/i.test(b.getAttribute('title')||'') || /rack/i.test(b.textContent||''));
      if (rackBtn) { rackBtn.click(); return 'clicked:' + (rackBtn.getAttribute('title')||rackBtn.textContent); }
      return 'not-found';
    })()
  `);
  console.log('nav click result:', JSON.stringify(navResult.result));

  await new Promise((r) => setTimeout(r, 800));

  const rackPresence = await evaluate(`
    (function() {
      return {
        rackPage: !!document.querySelector('.rack-page'),
        midiPill: !!document.querySelector('.rack-midi-pill'),
        layerCards: document.querySelectorAll('.rack-layer-card').length,
        editBtns: document.querySelectorAll('.rack-edit-btn').length,
      };
    })()
  `);
  console.log('rack presence:', JSON.stringify(rackPresence.result && rackPresence.result.result && rackPresence.result.result.value));

  // clica no botão Editar da primeira camada
  const editClick = await evaluate(`
    (function() {
      const btn = document.querySelector('.rack-edit-btn');
      if (!btn) return 'no-edit-btn';
      btn.click();
      return 'clicked';
    })()
  `);
  console.log('edit click:', JSON.stringify(editClick.result));

  await new Promise((r) => setTimeout(r, 400));

  const modalPresence = await evaluate(`
    (function() {
      const panel = document.querySelector('.rack-edit-panel');
      const headers = Array.from(document.querySelectorAll('.rack-toggle-header')).map(h => h.textContent);
      const sliders = document.querySelectorAll('.rack-edit-panel input[type=range]').length;
      return { hasPanel: !!panel, headers, sliders };
    })()
  `);
  console.log('modal presence:', JSON.stringify(modalPresence.result && modalPresence.result.result && modalPresence.result.result.value));

  // alterna cada toggle header ON/OFF e confere que o texto muda
  const toggleResult = await evaluate(`
    (function() {
      const headers = Array.from(document.querySelectorAll('.rack-toggle-header'));
      const results = [];
      headers.forEach((h) => {
        const before = h.textContent;
        h.click();
        results.push({ before, after: h.textContent });
      });
      return results;
    })()
  `);
  console.log('toggle result:', JSON.stringify(toggleResult.result && toggleResult.result.result && toggleResult.result.result.value));

  // move alguns sliders dentro do modal
  const sliderResult = await evaluate(`
    (function() {
      const sliders = Array.from(document.querySelectorAll('.rack-edit-panel input[type=range]'));
      sliders.slice(0, 5).forEach((s) => {
        const max = Number(s.max || 100);
        s.value = String(Math.round(max * 0.6));
        s.dispatchEvent(new Event('input', { bubbles: true }));
        s.dispatchEvent(new Event('change', { bubbles: true }));
      });
      return sliders.length;
    })()
  `);
  console.log('sliders moved of:', JSON.stringify(sliderResult.result));

  // testa a abertura do painel de MIDI na titlebar
  const midiClick = await evaluate(`
    (function() {
      const pill = document.querySelector('.rack-midi-pill');
      if (!pill) return 'no-pill';
      pill.click();
      return 'clicked';
    })()
  `);
  console.log('midi pill click:', JSON.stringify(midiClick.result));
  await new Promise((r) => setTimeout(r, 300));
  const midiPopover = await evaluate(`!!document.querySelector('.rack-midi-popover')`);
  console.log('midi popover visible:', JSON.stringify(midiPopover.result));

  await new Promise((r) => setTimeout(r, 300));
  console.log('console errors so far:', JSON.stringify(consoleErrors, null, 2));

  ws.close();
}

main().catch((err) => {
  console.error('TEST FAILED', err);
  process.exit(1);
});
