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
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
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

  // injeta uma música fake mínima no store pra testar o painel sem precisar importar áudio de verdade
  const inject = await evaluate(`
    (function() {
      const api = window.__mrqDebug;
      const song = {
        id: 'test-song',
        title: 'Música de Teste',
        artist: '',
        currentKey: 0,
        currentBpm: 120,
        timeSignatureNum: 4,
        timeSignatureDen: 4,
        tracks: [],
        parts: [
          { id: 'p1', name: 'Intro', color: '#d6455d', startBar: 0, lengthBars: 4 },
          { id: 'p2', name: 'Verso', color: '#2fb8c6', startBar: 4, lengthBars: 8 },
          { id: 'p3', name: 'Refrão', color: '#8a5fd6', startBar: 12, lengthBars: 8 },
        ],
        arrangement: [],
      };
      api.useStore.setState({ currentSong: song });
      return 'injected';
    })()
  `);
  console.log('inject:', JSON.stringify(val(inject)));
  await new Promise((r) => setTimeout(r, 400));

  const panelCheck = await evaluate(`
    (function() {
      const panel = document.querySelector('.rack-music-panel');
      if (!panel) return { found: false };
      const transport = panel.querySelector('.transport-row');
      const parts = panel.querySelectorAll('.part-btn');
      const transportBtn = panel.querySelector('.transport-btn');
      const playBtn = panel.querySelector('.transport-btn.play');
      return {
        found: true,
        hasTransport: !!transport,
        partsCount: parts.length,
        transportBtnSize: transportBtn ? transportBtn.getBoundingClientRect().width : null,
        playBtnSize: playBtn ? playBtn.getBoundingClientRect().width : null,
        title: panel.querySelector('.rack-strip-title').textContent,
      };
    })()
  `);
  console.log('panel check (espera 3 partes + título com nome da música):', JSON.stringify(val(panelCheck)));

  // clica em "próxima parte" dentro do painel do Rack pra confirmar que o controle funciona de verdade
  const jumpClick = await evaluate(`
    (function() {
      const panel = document.querySelector('.rack-music-panel');
      const partBtn = panel.querySelectorAll('.part-btn')[1];
      if (!partBtn) return 'no-part-btn';
      partBtn.click();
      return 'clicked';
    })()
  `);
  await new Promise((r) => setTimeout(r, 300));
  const activeCheck = await evaluate(`
    (function() {
      const api = window.__mrqDebug;
      return api.useStore.getState().engineState.activePartId;
    })()
  `);
  console.log('jump click:', JSON.stringify(val(jumpClick)), 'activePartId agora (espera p2):', JSON.stringify(val(activeCheck)));

  ws.close();
}

main().catch((err) => {
  console.error('TEST FAILED', err);
  process.exit(1);
});
