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
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') consoleErrors.push(msg.params.args.map((a) => a.value || a.description).join(' '));
    if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push(JSON.stringify(msg.params.exceptionDetails));
  });
  function send(method, params = {}) {
    return new Promise((resolve) => { const thisId = ++id; pending.set(thisId, resolve); ws.send(JSON.stringify({ id: thisId, method, params })); });
  }
  async function ev(expression) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) { console.log('EXCEPTION:', JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails)); return undefined; }
    return r.result?.result?.value;
  }
  await new Promise((resolve) => ws.on('open', resolve));
  await send('Runtime.enable');
  await send('Page.enable');

  // Garante cena salva com pan = 0.8 (tempo de acomodação do setTargetAtTime: ~200ms)
  console.log('set pan 0.8 ->', await ev(`window.__rackEngine.setPan(0, 0.8)`));
  await new Promise((r) => setTimeout(r, 250));
  console.log('pan after settle ->', await ev(`window.__rackEngine.layers[0].panNode.pan.value`));

  console.log('click save scene ->', await ev(`(function(){ const b = Array.from(document.querySelectorAll('button')).find(x=>x.textContent.includes('Salvar cena atual')); b.click(); return 'ok'; })()`));
  await new Promise((r) => setTimeout(r, 300));
  await ev(`(function(){
    const input = document.querySelector('.rack-modal-input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'Cena Pan 0.8');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    Array.from(document.querySelectorAll('.rack-modal-actions button')).find(b => b.textContent.includes('Salvar')).click();
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  console.log('scenes after save ->', await ev(`Array.from(document.querySelectorAll('.rack-scene-btn')).map(b=>b.textContent)`));

  // muda pan pra -0.5 e espera acomodar, confirma mudança real
  console.log('set pan -0.5 ->', await ev(`window.__rackEngine.setPan(0, -0.5)`));
  await new Promise((r) => setTimeout(r, 250));
  console.log('pan is now ->', await ev(`window.__rackEngine.layers[0].panNode.pan.value`));

  // Feature 4: Program Change 0 deve recarregar "Cena Pan 0.8"
  console.log('program change 0 ->', await ev(`window.__rackMidiTestDispatch([0xC0, 0])`));
  await new Promise((r) => setTimeout(r, 1800));
  console.log('pan after PC recall ->', await ev(`window.__rackEngine.layers[0].panNode.pan.value`));
  console.log('toast after PC ->', await ev(`document.body.innerText.includes('carregada')`));

  console.log('console errors so far:', JSON.stringify(consoleErrors));
  ws.close();
}

main().catch((err) => { console.error('ERRO:', err); process.exit(1); });
