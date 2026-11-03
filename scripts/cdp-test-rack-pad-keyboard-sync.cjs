// Teste via CDP pro comportamento ATUAL (pós-correção pedida pelo usuário)
// da camada PAD do Rack em relação ao Teclado Virtual e ao indicador de
// acorde/nota da barra de título (ChordIndicator):
//
//   - Clicar num PAD deve: acender o próprio botão do pad (.active) e TOCAR
//     o som (quando há instrumento carregado) — mas NÃO deve acender
//     nenhuma tecla no Teclado Virtual nem mudar o indicador de acorde da
//     barra de título. Pad é só um gatilho, não deve "parecer uma tecla
//     pressionada".
//   - Tocar de fato no Teclado Virtual (clique numa tecla) deve acender a
//     própria tecla E atualizar o indicador de acorde — esse caminho não
//     pode ter sido quebrado pela mudança acima.
//
// Ver RackEngine.ts: dispatchNoteOnToLayer/dispatchNoteOffFromLayer agora
// recebem um `source: 'keyboard' | 'pad'`; só 'keyboard' atualiza
// layer.keyboardActiveNotes, que é o que getActiveNotesSnapshot() expõe
// pra UI (RackKeyboardStrip e ChordIndicator). noteOnLayer/noteOffLayer
// (usados exclusivamente pelos pads) sempre passam 'pad'.
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
  async function click(x, y) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await new Promise((r) => setTimeout(r, 150));
  }
  async function release(x, y) {
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await new Promise((r) => setTimeout(r, 150));
  }

  await new Promise((resolve) => ws.on('open', resolve));
  await send('Runtime.enable');
  await send('Page.enable');

  for (let i = 0; i < 30; i++) {
    const r = await evaluate('!!document.querySelector(".titlebar")');
    if (val(r)) break;
    await new Promise((r2) => setTimeout(r2, 500));
  }

  await evaluate(`
    (function() {
      const btns = Array.from(document.querySelectorAll('button'));
      const rackBtn = btns.find(b => (b.getAttribute('title')||'').trim() === 'Rack de instrumentos');
      if (rackBtn) rackBtn.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 1000));

  await evaluate(`
    (function() {
      const strip = document.querySelector('.rack-keyboard-strip');
      if (strip && strip.classList.contains('collapsed')) {
        const btn = strip.querySelector('.rack-strip-toggle');
        if (btn) btn.click();
      }
    })()
  `);
  await new Promise((r) => setTimeout(r, 300));

  let allOk = true;

  // ===== Parte 1: clique no PAD não deve acender tecla nem indicador =====
  console.log('--- Parte 1: clique no PAD ---');
  await evaluate(`document.querySelector('.rack-pad-btn').scrollIntoView({ block: 'center', inline: 'center' })`);
  await new Promise((r) => setTimeout(r, 200));
  const padRect = val(await evaluate(`(function(){const b=document.querySelector('.rack-pad-btn');const r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`));

  const chordBefore = val(await evaluate(`document.querySelector('.chord-indicator-label')?.textContent`));
  console.log('indicador de acorde ANTES:', JSON.stringify(chordBefore));

  await click(padRect.x, padRect.y);
  const padActive = val(await evaluate(`document.querySelector('.rack-pad-btn').classList.contains('active')`));
  const keyHighlightedDuringPad = val(await evaluate(`!!document.querySelector('.rack-key-active')`));
  const chordDuringPad = val(await evaluate(`document.querySelector('.chord-indicator-label')?.textContent`));
  console.log('1a) pad com classe "active" (esperado true):', JSON.stringify(padActive));
  console.log('1b) alguma tecla do Teclado Virtual acesa DURANTE o clique no pad (esperado FALSE):', JSON.stringify(keyHighlightedDuringPad));
  console.log('1c) indicador de acorde DURANTE o clique no pad (esperado continuar "—"):', JSON.stringify(chordDuringPad));
  await release(padRect.x, padRect.y);

  if (padActive !== true) { console.log('FALHA 1a'); allOk = false; }
  if (keyHighlightedDuringPad !== false) { console.log('FALHA 1b — pad está vazando pro teclado virtual'); allOk = false; }
  if (chordDuringPad !== '—') { console.log('FALHA 1c — pad está vazando pro indicador de acorde'); allOk = false; }

  // ===== Parte 2: tocar de fato numa tecla do teclado virtual DEVE acender a própria tecla e o indicador =====
  console.log('--- Parte 2: clique numa tecla do Teclado Virtual ---');
  const whiteKey = val(await evaluate(`
    (function() {
      const keys = Array.from(document.querySelectorAll('.rack-keyboard-body [data-note]'));
      const k = keys.find(k => !k.classList.contains('rack-key-black')) || keys[0];
      if (!k) return null;
      k.scrollIntoView({ block: 'center', inline: 'center' });
      return k.getAttribute('data-note');
    })()
  `));
  console.log('nota MIDI da tecla escolhida:', JSON.stringify(whiteKey));
  await new Promise((r) => setTimeout(r, 200));
  const keyRect = val(await evaluate(`
    (function() {
      const keys = Array.from(document.querySelectorAll('.rack-keyboard-body [data-note]'));
      const k = keys.find(k => !k.classList.contains('rack-key-black')) || keys[0];
      const r = k.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height * 0.8 };
    })()
  `));

  await click(keyRect.x, keyRect.y);
  const keyHighlightedDuringKb = val(await evaluate(`!!document.querySelector('.rack-key-active')`));
  const chordDuringKb = val(await evaluate(`document.querySelector('.chord-indicator-label')?.textContent`));
  console.log('2a) alguma tecla acesa DURANTE o clique no teclado (esperado TRUE):', JSON.stringify(keyHighlightedDuringKb));
  console.log('2b) indicador de acorde DURANTE o clique no teclado (esperado != "—"):', JSON.stringify(chordDuringKb));
  await release(keyRect.x, keyRect.y);
  const keyHighlightedAfterKb = val(await evaluate(`!!document.querySelector('.rack-key-active')`));
  const chordAfterKb = val(await evaluate(`document.querySelector('.chord-indicator-label')?.textContent`));
  console.log('2c) depois de soltar — tecla acesa (esperado false):', JSON.stringify(keyHighlightedAfterKb), '| acorde (esperado "—"):', JSON.stringify(chordAfterKb));

  if (keyHighlightedDuringKb !== true) { console.log('FALHA 2a'); allOk = false; }
  if (chordDuringKb === '—') { console.log('FALHA 2b'); allOk = false; }
  if (keyHighlightedAfterKb !== false) { console.log('FALHA 2c (tecla)'); allOk = false; }
  if (chordAfterKb !== '—') { console.log('FALHA 2c (acorde)'); allOk = false; }

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result && shot.result.data) {
    require('fs').writeFileSync('/tmp/pad-no-sync-screenshot.png', Buffer.from(shot.result.data, 'base64'));
    console.log('screenshot salvo em /tmp/pad-no-sync-screenshot.png');
  }

  console.log('');
  console.log(allOk ? 'RESULTADO: OK — pad não vaza pro teclado/indicador, e o teclado virtual continua funcionando normalmente.' : 'RESULTADO: FALHA — ver detalhes acima.');
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error('erro no teste:', err);
  process.exit(1);
});
