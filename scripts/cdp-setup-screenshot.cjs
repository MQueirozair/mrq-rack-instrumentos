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
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  function send(method, params = {}) {
    return new Promise((resolve) => { const thisId = ++id; pending.set(thisId, resolve); ws.send(JSON.stringify({ id: thisId, method, params })); });
  }
  function evaluate(expression) { return send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); }
  function val(r) { return r.result && r.result.result && r.result.result.value; }
  await new Promise((resolve) => ws.on('open', resolve));
  await send('Runtime.enable');

  for (let i = 0; i < 30; i++) {
    const r = await evaluate('!!document.querySelector(".icon-rail, .titlebar")');
    if (val(r)) break;
    await new Promise((r2) => setTimeout(r2, 500));
  }

  await evaluate(`
    (function() {
      const btns = Array.from(document.querySelectorAll('button, [role="button"], a, .icon-rail *'));
      const rackBtn = btns.find(b => /rack/i.test(b.getAttribute('title')||'') || /rack/i.test(b.textContent||''));
      if (rackBtn) rackBtn.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 500));

  await evaluate(`
    (function() {
      const song = {
        id: 'test-song', title: 'Música de Teste', artist: '', currentKey: 0, currentBpm: 120,
        timeSignatureNum: 4, timeSignatureDen: 4, tracks: [],
        parts: [
          { id: 'p1', name: 'Intro', color: '#d6455d', startBar: 0, lengthBars: 4 },
          { id: 'p2', name: 'Verso', color: '#2fb8c6', startBar: 4, lengthBars: 8 },
          { id: 'p3', name: 'Refrão', color: '#8a5fd6', startBar: 12, lengthBars: 8 },
          { id: 'p4', name: 'Ponte', color: '#d6b23c', startBar: 20, lengthBars: 8 },
        ],
        arrangement: [],
      };
      window.__mrqDebug.useStore.setState({ currentSong: song });
    })()
  `);
  await new Promise((r) => setTimeout(r, 400));

  console.log('ready');
  ws.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
