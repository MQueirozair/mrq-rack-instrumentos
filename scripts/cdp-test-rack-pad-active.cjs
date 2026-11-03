// Teste via CDP pro bug relatado: "quando clico nos botões do pad eles não
// ficam ativos" (camada PAD do Rack, .rack-pad-btn). Diferente de
// `.click()` (que só dispara um evento sintético "click", sem pointerdown/
// pointerup/boundary events), aqui usamos Input.dispatchMouseEvent via CDP
// pra simular um clique de verdade — os mesmos eventos de pointer que o
// navegador despacha de verdade, incluindo o teste geométrico de
// "pointerleave" que é a causa suspeita do bug (ver comentário em
// pressPad/InstrumentRack.tsx).
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
  const consoleErrors = [];

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value || a.description).join(' '));
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
  await send('Page.enable');
  await send('Input.setIgnoreInputEvents', { ignore: false });

  for (let i = 0; i < 30; i++) {
    const r = await evaluate('!!document.querySelector(".icon-rail, .titlebar")');
    if (val(r)) break;
    await new Promise((r2) => setTimeout(r2, 500));
  }

  // navega pra aba Rack — título exato do botão da barra lateral (ver lista
  // de títulos reais checada via CDP), pra não confundir com outros botões
  // que tenham "rack" em algum texto dentro do conteúdo da própria página.
  const navResult = await evaluate(`
    (function() {
      const btns = Array.from(document.querySelectorAll('button'));
      const rackBtn = btns.find(b => (b.getAttribute('title')||'').trim() === 'Rack de instrumentos');
      if (rackBtn) { rackBtn.click(); return 'clicked:' + (rackBtn.getAttribute('title')||rackBtn.textContent); }
      return 'not-found';
    })()
  `);
  console.log('nav click result:', JSON.stringify(val(navResult)));
  await new Promise((r) => setTimeout(r, 1000));

  const padCheck = await evaluate(`!!document.querySelector('.rack-pad-btn')`);
  console.log('pad grid found:', JSON.stringify(val(padCheck)));
  if (!val(padCheck)) {
    console.error('FALHA: nenhum .rack-pad-btn encontrado na tela — não dá pra testar.');
    process.exit(1);
  }

  // A página do Rack tem rolagem horizontal (6 camadas lado a lado) — traz o
  // pad pra dentro da viewport antes de calcular as coordenadas de clique.
  await evaluate(`document.querySelector('.rack-pad-btn').scrollIntoView({ block: 'center', inline: 'center' })`);
  await new Promise((r) => setTimeout(r, 200));

  // Pega as coordenadas de tela (viewport) do primeiro botão do pad.
  const rectInfo = await evaluate(`
    (function() {
      const btn = document.querySelector('.rack-pad-btn');
      const r = btn.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, left: r.left, width: r.width, height: r.height };
    })()
  `);
  const rect = val(rectInfo);
  console.log('primeiro pad em:', JSON.stringify(rect));

  // Limpa qualquer estado residual de classe 'active' antes do teste real.
  await evaluate(`document.querySelector('.rack-pad-btn').classList.remove('active')`);

  // --- Simula um clique BEM perto da borda SUPERIOR do botão (é ali que o
  // deslocamento translateY(2px)+scale(.97) do CSS .active tem mais chance
  // de empurrar a borda do botão pra baixo do cursor parado — ver conta no
  // comentário do commit) + um tremor mínimo de mouse (sub-pixel, só pra
  // forçar o navegador a recalcular o hit-test depois que o CSS mudou;
  // igual qualquer mouse real faz o tempo todo, mesmo "parado").
  const clickX = rect.x; // centro horizontal
  const clickY = rect.top + 1.5; // 1.5px abaixo da borda de cima original
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1,
  });
  await new Promise((r) => setTimeout(r, 40));
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: clickX, y: clickY + 0.2, button: 'left', buttons: 1,
  });

  // Checa o estado da classe 'active' BEM rápido depois do press (antes do
  // release) — é exatamente aqui que o bug devia aparecer: se o pointerleave
  // disparar sozinho por causa do translateY/scale do CSS .active, a classe
  // já teria sumido de novo neste ponto, mesmo sem soltar o botão ainda.
  await new Promise((r) => setTimeout(r, 120));
  const activeWhileHeld = await evaluate(`document.querySelector('.rack-pad-btn').classList.contains('active')`);
  console.log('classe "active" presente ENQUANTO o botão do mouse está pressionado (esperado: true):', JSON.stringify(val(activeWhileHeld)));

  // Screenshot com o pad pressionado, pra inspecionar visualmente o efeito.
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result && shot.result.data) {
    require('fs').writeFileSync('/tmp/pad-active-screenshot.png', Buffer.from(shot.result.data, 'base64'));
    console.log('screenshot salvo em /tmp/pad-active-screenshot.png');
  }

  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1,
  });
  await new Promise((r) => setTimeout(r, 150));
  const activeAfterRelease = await evaluate(`document.querySelector('.rack-pad-btn').classList.contains('active')`);
  console.log('classe "active" depois de soltar o botão (esperado: false):', JSON.stringify(val(activeAfterRelease)));

  console.log('');
  console.log('console errors capturados:', consoleErrors.length ? JSON.stringify(consoleErrors) : '(nenhum)');

  const held = val(activeWhileHeld);
  const released = val(activeAfterRelease);
  if (held === true && released === false) {
    console.log('\\nRESULTADO: OK — pad fica "active" durante o clique e solta corretamente ao soltar.');
    process.exit(0);
  } else {
    console.error('\\nRESULTADO: FALHA — comportamento inesperado (held=' + held + ', released=' + released + ').');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('erro no teste:', err);
  process.exit(1);
});
