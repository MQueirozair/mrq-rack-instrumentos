// Teste combinado: carrega um .npno real numa camada, mede o áudio, troca o
// tamanho do buffer (o que recria o AudioContext do zero), e confirma que o
// mesmo instrumento continua carregado e tocando corretamente depois.
const WebSocket = require('ws');
const http = require('http');
const PORT = 9338;

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
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
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

  async function evalExpr(expr) {
    const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    return res.result?.result?.value;
  }

  const navRes = await evalExpr(`
    (function() {
      const target = document.querySelector('button[title="Rack de instrumentos"]');
      if (target) { target.click(); return 'clicked'; }
      return 'not found';
    })()
  `);
  console.log('nav:', navRes);
  await new Promise((r) => setTimeout(r, 800));

  // carrega npno na camada 0 (vazia nesse user-data-dir limpo)
  const loadResult = await evalExpr(`
    (async function() {
      const cards = document.querySelectorAll('.rack-layer-card');
      const card = cards[0];
      const loadBtn = Array.from(card.querySelectorAll('button')).find(b => b.textContent.includes('Carregar'));
      loadBtn.click();
      return 'clicked load';
    })()
  `);
  console.log('load click:', loadResult);
  await new Promise((r) => setTimeout(r, 1500));

  const loadedState = await evalExpr(`
    (function() {
      const card = document.querySelectorAll('.rack-layer-card')[0];
      return card ? card.innerText.slice(0, 200) : 'no card';
    })()
  `);
  console.log('layer 0 state after load:', loadedState);

  function measure(note, velocity) {
    return evalExpr(`
      (async function() {
        window.__rackEngine.layers?.forEach && void 0;
        const ctx = window.__rackEngine.ctx;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        window.__rackEngine.masterGain.connect(analyser);
        window.__rackEngine.noteOn(${note}, ${velocity});
        await new Promise(r => setTimeout(r, 350));
        const data = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(data);
        let max = 0;
        for (const v of data) max = Math.max(max, Math.abs(v));
        window.__rackEngine.noteOff(${note});
        analyser.disconnect();
        return max;
      })()
    `);
  }

  const before = await measure(60, 100);
  console.log('measured level BEFORE buffer change (note 60 vel 100):', before);

  // troca o buffer (dispara reconstrução total + recarga automática do .npno)
  const panelOpen = await evalExpr(`
    (function() {
      const pill = document.querySelector('.rack-midi-pill');
      if (!document.querySelector('.rack-midi-popover')) pill.click();
      return 'ok';
    })()
  `);
  console.log('open panel:', panelOpen);
  await new Promise((r) => setTimeout(r, 400));

  const bufferBefore = await evalExpr(`document.querySelector('.rack-buffer-step-value').textContent`);
  console.log('buffer before change:', bufferBefore);

  await evalExpr(`
    (function() {
      const btns = Array.from(document.querySelectorAll('.rack-buffer-step-btn'));
      btns[1].click(); // "+" aumenta o buffer
      return 'clicked plus';
    })()
  `);

  // espera a reconstrução + recarga do .npno terminarem
  await new Promise((r) => setTimeout(r, 3000));

  const bufferAfter = await evalExpr(`document.querySelector('.rack-buffer-step-value').textContent`);
  console.log('buffer after change:', bufferAfter);

  const layerStateAfter = await evalExpr(`
    (function() {
      const card = document.querySelectorAll('.rack-layer-card')[0];
      return card ? card.innerText.slice(0, 200) : 'no card';
    })()
  `);
  console.log('layer 0 state AFTER buffer change:', layerStateAfter);

  const after = await measure(60, 100);
  console.log('measured level AFTER buffer change (note 60 vel 100):', after);

  await new Promise((r) => setTimeout(r, 300));
  console.log('console errors:', consoleErrors);
  ws.close();

  const ok =
    typeof before === 'number' && before > 0.01 &&
    typeof after === 'number' && after > 0.01 &&
    bufferAfter !== bufferBefore &&
    consoleErrors.length === 0;
  console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
