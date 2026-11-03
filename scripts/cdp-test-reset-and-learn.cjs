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

  console.log('edit panel open? ->', await ev(`!!document.querySelector('.rack-edit-panel')`));

  console.log('set drive db to 12 ->', await ev(`(function(){
    const label = Array.from(document.querySelectorAll('label')).find(l => l.textContent.includes('Drive (dB)'));
    const input = label?.parentElement?.querySelector('input[type=range]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 12);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.value;
  })()`));
  await new Promise((r) => setTimeout(r, 200));
  console.log('engine driveDb after manual set ->', await ev(`window.__rackEngine.layers[0] ? 'n/a - no direct getter' : 'n/a'`));
  console.log('label text after manual set ->', await ev(`Array.from(document.querySelectorAll('label')).find(l => l.textContent.includes('Drive (dB)'))?.textContent`));

  console.log('click reset effects ->', await ev(`(function(){
    const btn = document.querySelector('button[title^="Resetar"]');
    if (btn) { btn.click(); return 'clicked'; }
    return 'not-found';
  })()`));
  await new Promise((r) => setTimeout(r, 300));
  console.log('label text after reset ->', await ev(`Array.from(document.querySelectorAll('label')).find(l => l.textContent.includes('Drive (dB)'))?.textContent`));
  console.log('pan after reset (should be 0) ->', await ev(`(function(){
    const label = Array.from(document.querySelectorAll('label')).find(l => l.textContent.includes('Pan'));
    const input = label?.parentElement?.querySelector('input[type=range]');
    return input ? input.value : 'not-found';
  })()`));

  // --- Feature 10: Aprender faixa ---
  console.log('learn btn click ->', await ev(`(function(){
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Aprender faixa'));
    if (btn) { btn.click(); return 'clicked'; }
    return 'not-found';
  })()`));
  await new Promise((r) => setTimeout(r, 300));
  console.log('armed label ->', await ev(`document.body.innerText.includes('Toque as teclas')`));

  console.log('note range before ->', await ev(`(function(){
    const startLabel = Array.from(document.querySelectorAll('label')).find(l => /nota inicial|faixa.*de/i.test(l.textContent));
    return Array.from(document.querySelectorAll('label')).filter(l => /[0-9]/.test(l.textContent) && /note|faixa|nota/i.test(l.textContent)).map(l=>l.textContent);
  })()`));

  console.log('simulate key presses 48 and 72 ->', await ev(`(function(){
    window.__rackMidiTestDispatch([0x90, 48, 100]);
    window.__rackMidiTestDispatch([0x80, 48, 0]);
    window.__rackMidiTestDispatch([0x90, 72, 100]);
    window.__rackMidiTestDispatch([0x80, 72, 0]);
    return 'sent';
  })()`));
  await new Promise((r) => setTimeout(r, 6500));
  console.log('armed label after wait (should be false) ->', await ev(`document.body.innerText.includes('Toque as teclas')`));
  console.log('note range labels after learn ->', await ev(`Array.from(document.querySelectorAll('label')).filter(l => /note|faixa|nota/i.test(l.textContent)).map(l=>l.textContent)`));

  console.log('console errors so far:', JSON.stringify(consoleErrors));
  ws.close();
}

main().catch((err) => { console.error('ERRO:', err); process.exit(1); });
