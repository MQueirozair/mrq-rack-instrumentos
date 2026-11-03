const WebSocket = require('ws');
async function main() {
  const listRes = await fetch('http://127.0.0.1:9338/json');
  const list = await listRes.json();
  const page = list.find((p) => p.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  function send(method, params = {}) { return new Promise((resolve) => { const thisId = ++id; pending.set(thisId, resolve); ws.send(JSON.stringify({ id: thisId, method, params })); }); }
  function evaluate(expression) { return send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); }
  await new Promise((resolve) => ws.on('open', resolve));
  await send('Runtime.enable');

  for (let i = 0; i < 30; i++) {
    const r = await evaluate('!!document.querySelector(".titlebar")');
    if (r.result?.result?.value) break;
    await new Promise((r2) => setTimeout(r2, 400));
  }

  await evaluate(`
    (function() {
      const btns = Array.from(document.querySelectorAll('button, [role="button"], a, .icon-rail *'));
      const rackBtn = btns.find(b => /rack/i.test(b.getAttribute('title')||'') || /rack/i.test(b.textContent||''));
      if (rackBtn) rackBtn.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 500));

  const loadClick = await evaluate(`
    (function() {
      const cards = Array.from(document.querySelectorAll('.rack-layer-card'));
      const card = cards[3];
      const btn = Array.from(card.querySelectorAll('.rack-bottom-row .btn')).find(b => /carregar/i.test(b.textContent||''));
      btn.click();
      return 'clicked';
    })()
  `);
  console.log('load click:', JSON.stringify(loadClick.result));

  await new Promise((r) => setTimeout(r, 2000));

  const toastText = await evaluate(`
    document.body.innerText
  `);
  // procura qualquer texto que pareça com mensagem de erro de carregamento
  const text = toastText.result?.result?.value || '';
  const idx = text.toLowerCase().indexOf('não foi possível');
  console.log('trecho relevante:', idx >= 0 ? text.slice(idx, idx + 300) : '(não encontrado) ' + text.slice(0, 500));

  ws.close();
}
main().catch(e=>{console.error(e);process.exit(1);});
