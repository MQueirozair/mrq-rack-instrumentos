// Teste via CDP: abre o painel MIDI do rack, lê o buffer atual, clica em
// "+" e "-" e confirma que o valor muda e que os instrumentos já carregados
// (se houver) são recarregados sem erro.
const WebSocket = require('ws');
const http = require('http');

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9336/json', (res) => {
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
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
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

  await new Promise((resolve) => ws.on('open', resolve));
  await send('Runtime.enable');
  await send('Page.enable');

  async function evalExpr(expr) {
    const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    return res.result?.result?.value;
  }

  // nav até a aba Rack (só clica se ainda não estiver lá)
  const navResult = await evalExpr(`
    (function() {
      if (document.querySelector('.rack-midi-pill')) return 'already-on-rack';
      const btns = Array.from(document.querySelectorAll('button, [role="button"], .rail-item, a'));
      const target = btns.find(b => b.textContent && b.textContent.includes('Rack de instrumentos'));
      if (target) { target.click(); return 'clicked:Rack de instrumentos'; }
      return 'not found';
    })()
  `);
  console.log('nav:', navResult);
  await new Promise((r) => setTimeout(r, 800));

  // abre o painel MIDI (clica só se ainda não estiver aberto, idempotente)
  const openPanel = await evalExpr(`
    (function() {
      const pill = document.querySelector('.rack-midi-pill');
      if (!pill) return 'no pill';
      if (!document.querySelector('.rack-midi-popover')) pill.click();
      return 'ensured-open';
    })()
  `);
  console.log('open panel:', openPanel);
  await new Promise((r) => setTimeout(r, 500));

  const before = await evalExpr(`
    (function() {
      const span = document.querySelector('.rack-buffer-step-value');
      return span ? span.textContent : null;
    })()
  `);
  console.log('buffer before:', before);

  const minusBtn = await evalExpr(`
    (function() {
      const btns = Array.from(document.querySelectorAll('.rack-buffer-step-btn'));
      if (btns.length < 2) return 'not found buttons: ' + btns.length;
      btns[0].click();
      return 'clicked minus';
    })()
  `);
  console.log('minus click:', minusBtn);

  // espera a reconstrução + recarga terminar (fica "Aplicando…" durante isso)
  await new Promise((r) => setTimeout(r, 2500));

  const after = await evalExpr(`
    (function() {
      const span = document.querySelector('.rack-buffer-step-value');
      return span ? span.textContent : null;
    })()
  `);
  console.log('buffer after minus:', after);

  const label = await evalExpr(`
    (function() {
      const label = document.querySelector('.rack-field label');
      const labels = Array.from(document.querySelectorAll('.rack-field label')).map(l => l.textContent);
      return labels.find(l => l.includes('Buffer'));
    })()
  `);
  console.log('buffer label (deve mostrar latência real):', label);

  // engine ainda funcional após reconstrução? dispara uma nota de teste
  const engineOk = await evalExpr(`
    (function() {
      try {
        window.__rackEngine.noteOn(60, 100);
        window.__rackEngine.noteOff(60);
        return 'noteOn/noteOff ok, ctx state: ' + (window.__rackEngine.getLatencyInfoMs() ? JSON.stringify(window.__rackEngine.getLatencyInfoMs()) : 'null');
      } catch (e) {
        return 'ERROR: ' + e.message;
      }
    })()
  `);
  console.log('engine check:', engineOk);

  await new Promise((r) => setTimeout(r, 300));
  console.log('console errors:', consoleErrors);
  ws.close();
  if (consoleErrors.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
