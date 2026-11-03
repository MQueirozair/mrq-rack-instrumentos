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

  const before = await evaluate(`window.__mrqDebug.rackEngine.getActiveNotesSnapshot()`);
  console.log('active before:', JSON.stringify(val(before)));

  const noteOnResult = await evaluate(`
    (async function() {
      const rackEngine = window.__mrqDebug.rackEngine;
      await rackEngine.resume();
      rackEngine.noteOn(60, 100, 1);
      await new Promise(r => setTimeout(r, 100));
      const active = rackEngine.getActiveNotesSnapshot();
      return { active };
    })()
  `);
  console.log('after noteOn(60):', JSON.stringify(val(noteOnResult)));

  await new Promise((r) => setTimeout(r, 200));
  const offResult = await evaluate(`
    (function() {
      const rackEngine = window.__mrqDebug.rackEngine;
      rackEngine.noteOff(60, 1);
      return 'sent';
    })()
  `);
  console.log('noteOff:', JSON.stringify(val(offResult)));

  ws.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
