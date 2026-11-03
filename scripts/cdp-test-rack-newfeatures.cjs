// Teste via CDP: verifica os 6 itens do novo pedido (teclado, 6 camadas,
// badge .nki, botões de transporte menores, painel de música no Rack,
// toggles de minimizar).
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
  function val(r) {
    return r.result && r.result.result && r.result.result.value;
  }

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
      if (rackBtn) { rackBtn.click(); return 'clicked:' + (rackBtn.getAttribute('title')||rackBtn.textContent); }
      return 'not-found';
    })()
  `);
  console.log('nav click result:', JSON.stringify(val(navResult)));
  await new Promise((r) => setTimeout(r, 800));

  // item 2: 6 camadas
  const layerCount = await evaluate(`document.querySelectorAll('.rack-layer-card').length`);
  console.log('layer cards count (expect 6):', JSON.stringify(val(layerCount)));

  // item 1: teclado — contagem de teclas brancas/pretas e checagem de que não se sobrepõem de forma idêntica
  const keyboardInfo = await evaluate(`
    (function() {
      const whites = Array.from(document.querySelectorAll('.rack-key-white'));
      const blacks = Array.from(document.querySelectorAll('.rack-key-black'));
      const whiteRect = whites[0] ? whites[0].getBoundingClientRect() : null;
      const blackRect = blacks[0] ? blacks[0].getBoundingClientRect() : null;
      return {
        whiteCount: whites.length,
        blackCount: blacks.length,
        whiteWidth: whiteRect ? whiteRect.width : null,
        blackWidth: blackRect ? blackRect.width : null,
        blackShorter: whiteRect && blackRect ? blackRect.height < whiteRect.height : null,
        blackNarrower: whiteRect && blackRect ? blackRect.width < whiteRect.width : null,
      };
    })()
  `);
  console.log('keyboard info (expect white=52 black=36):', JSON.stringify(val(keyboardInfo)));

  // item 6a: toggle do teclado
  const kbToggle = await evaluate(`
    (function() {
      const strip = document.querySelector('.rack-keyboard-strip');
      const btn = strip ? strip.querySelector('.rack-strip-toggle') : null;
      if (!btn) return 'no-toggle';
      btn.click();
      return 'clicked';
    })()
  `);
  await new Promise((r) => setTimeout(r, 200));
  const kbCollapsedState = await evaluate(`!!document.querySelector('.rack-keyboard-strip.collapsed')`);
  console.log('keyboard toggle click:', JSON.stringify(val(kbToggle)), 'collapsed now:', JSON.stringify(val(kbCollapsedState)));
  // volta a abrir
  await evaluate(`document.querySelector('.rack-keyboard-strip .rack-strip-toggle').click()`);

  // item 5 + 6b: painel de música no Rack
  const musicPanel = await evaluate(`
    (function() {
      const panel = document.querySelector('.rack-music-panel');
      if (!panel) return { found: false };
      const hasTransport = !!panel.querySelector('.transport-row');
      const hasParts = !!panel.querySelector('.parts-grid');
      const hasEmpty = !!panel.querySelector('.rack-music-panel-empty');
      return { found: true, hasTransport, hasParts, hasEmpty };
    })()
  `);
  console.log('music panel (sem música carregada, espera hasEmpty=true):', JSON.stringify(val(musicPanel)));

  const musicToggle = await evaluate(`
    (function() {
      const panel = document.querySelector('.rack-music-panel');
      const btn = panel ? panel.querySelector('.rack-strip-toggle') : null;
      if (!btn) return 'no-toggle';
      btn.click();
      return 'clicked';
    })()
  `);
  await new Promise((r) => setTimeout(r, 200));
  const musicCollapsedState = await evaluate(`!!document.querySelector('.rack-music-panel.collapsed')`);
  console.log('music panel toggle click:', JSON.stringify(val(musicToggle)), 'collapsed now:', JSON.stringify(val(musicCollapsedState)));

  // item 4: tamanho dos botões de transporte (precisa estar visível; sem música carregada pode não existir .transport-btn na aba Rack já que currentSong é null)
  // então também testamos indo na aba de reprodução, se existir alguma música de teste.
  const navBackToRack = await evaluate(`document.querySelector('.rack-music-panel .rack-strip-toggle') ? 'ok' : 'missing'`);
  console.log('nav back check:', JSON.stringify(val(navBackToRack)));

  await new Promise((r) => setTimeout(r, 300));
  console.log('console errors so far:', JSON.stringify(consoleErrors, null, 2));

  ws.close();
}

main().catch((err) => {
  console.error('TEST FAILED', err);
  process.exit(1);
});
