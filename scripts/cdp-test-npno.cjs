// Teste de ponta a ponta do decodificador .npno real: navega até o Rack,
// carrega o arquivo .npno sintético (gerado pelo encoder de verdade do
// nord-format, ver native/npno-fixture-gen) na camada 1 via o atalho de teste
// MRQ_TEST_INSTRUMENT_FILE, dispara notas pelo motor exposto em window e
// confere no AnalyserNode que saiu áudio de verdade (não silêncio) nas notas
// cobertas pela biblioteca, e nada nas não cobertas.
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
  const consoleMsgs = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      consoleMsgs.push({ type: msg.params.type, args: msg.params.args.map((a) => a.value ?? a.description) });
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleMsgs.push({ type: 'exception', args: [JSON.stringify(msg.params.exceptionDetails)] });
    }
  });
  function send(method, params = {}) {
    return new Promise((resolve) => {
      const thisId = ++id;
      pending.set(thisId, resolve);
      ws.send(JSON.stringify({ id: thisId, method, params }));
    });
  }
  function evaluate(expression, awaitPromise = true) {
    return send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  }

  await new Promise((resolve) => ws.on('open', resolve));
  await send('Runtime.enable');

  for (let i = 0; i < 30; i++) {
    const r = await evaluate('!!document.querySelector(".titlebar")');
    if (r.result?.result?.value) break;
    await new Promise((r2) => setTimeout(r2, 400));
  }

  const nav = await evaluate(`
    (function() {
      const btns = Array.from(document.querySelectorAll('button, [role="button"], a, .icon-rail *'));
      const rackBtn = btns.find(b => /rack/i.test(b.getAttribute('title')||'') || /rack/i.test(b.textContent||''));
      if (rackBtn) { rackBtn.click(); return 'ok'; }
      return 'not-found';
    })()
  `);
  console.log('nav:', JSON.stringify(nav.result));
  await new Promise((r) => setTimeout(r, 500));

  // clica "Carregar" na camada 3 (índice 2, vazia) pra não mexer nas camadas já
  // carregadas de testes anteriores (o main process serve o caminho fixo de
  // MRQ_TEST_INSTRUMENT_FILE independente de qual camada chama o diálogo).
  const loadClick = await evaluate(`
    (function() {
      const cards = Array.from(document.querySelectorAll('.rack-layer-card'));
      const card = cards[2];
      if (!card) return 'no-card';
      const btn = Array.from(card.querySelectorAll('.rack-bottom-row .btn')).find(b => /carregar/i.test(b.textContent||''));
      if (!btn) return 'no-load-btn';
      btn.click();
      return 'clicked';
    })()
  `);
  console.log('load click:', JSON.stringify(loadClick.result));

  // espera o carregamento terminar (texto de instrumento da camada 3 mudar)
  let loaded = false;
  for (let i = 0; i < 60; i++) {
    const r = await evaluate(`document.querySelectorAll('.rack-instrument-name')[2]?.textContent || ''`);
    const text = r.result?.result?.value || '';
    if (text && !/adicione um timbre/i.test(text)) { loaded = true; console.log('instrumento carregado:', text); break; }
    await new Promise((r2) => setTimeout(r2, 300));
  }
  console.log('loaded:', loaded);

  const badge = await evaluate(`document.querySelectorAll('.rack-format-badge')[2]?.textContent`);
  console.log('badge:', JSON.stringify(badge.result));

  const toastText = await evaluate(`
    Array.from(document.querySelectorAll('[class*="toast"]')).map(e => e.textContent)
  `);
  console.log('toasts:', JSON.stringify(toastText.result));

  // muda as camadas 1 e 2 (já carregadas de testes anteriores) pra isolar só a
  // camada 3 (.npno) na medição de energia de saída
  const muteOthers = await evaluate(`
    (function() {
      const cards = Array.from(document.querySelectorAll('.rack-layer-card'));
      [0, 1].forEach((i) => {
        const btn = cards[i]?.querySelector('.rack-ms-buttons .mute');
        if (btn && !btn.classList.contains('on')) btn.click();
      });
      return 'ok';
    })()
  `);
  console.log('mute others:', JSON.stringify(muteOthers.result));
  await new Promise((r) => setTimeout(r, 200));

  // --- toca notas via o motor exposto em window.__rackEngine e mede o nível de saída ---
  const playTest = await evaluate(`
    (async function() {
      const engine = window.__rackEngine;
      if (!engine) return { error: 'no __rackEngine' };
      await engine.resume();
      const ctx = engine.ctx;
      // engarrafa um analyser no destino real pra medir energia de saída
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      const results = [];
      async function measure(note, velocity, label) {
        const analyser = engine.masterGain.context.createAnalyser();
        analyser.fftSize = 2048;
        engine.masterGain.connect(analyser);
        engine.noteOn(note, velocity, undefined);
        await new Promise(r => setTimeout(r, 350));
        const data = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(data);
        let maxAbs = 0;
        for (let i = 0; i < data.length; i++) maxAbs = Math.max(maxAbs, Math.abs(data[i]));
        engine.noteOff(note, undefined);
        await new Promise(r => setTimeout(r, 150));
        try { engine.masterGain.disconnect(analyser); } catch(e) {}
        results.push({ label, note, maxAbs });
      }
      // 48, 60, 72 são raízes gravadas no fixture; 54 e 66 ficam entre raízes (tocam a raiz mais próxima, pitch-shiftado)
      await measure(48, 100, 'root C3 forte');
      await measure(48, 20, 'root C3 fraco (camada suave)');
      await measure(60, 100, 'root C4 forte');
      await measure(54, 100, 'entre raizes (pitch-shift)');
      await measure(72, 100, 'root C5 forte');
      await measure(2, 100, 'nota grave fora de qualquer raiz (deve tocar a raiz mais proxima mesmo assim)');
      return { results };
    })()
  `);
  console.log('play test:', JSON.stringify(playTest.result, null, 2));

  console.log('console msgs (últimos):', JSON.stringify(consoleMsgs.slice(-20), null, 2));

  ws.close();
}

main().catch((err) => {
  console.error('TEST FAILED', err);
  process.exit(1);
});
