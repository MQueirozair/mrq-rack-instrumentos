// Clica em algo (via seletor) e tira um screenshot pouco tempo depois, tudo numa única
// conexão CDP, pra minimizar o atraso entre a ação e a foto (útil pra pegar estados
// efêmeros como a contagem de entrada). Uso: node scripts/cdp-click-and-shot.cjs <seletor> <espera_ms> <saida.png>
const WebSocket = require('ws');
const fs = require('fs');

async function main() {
  const selector = process.argv[2];
  const waitMs = parseInt(process.argv[3] || '500', 10);
  const outPath = process.argv[4] || 'screenshot.png';
  const listRes = await fetch('http://127.0.0.1:9333/json');
  const list = await listRes.json();
  const page = list.find((p) => p.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  let nextId = 1;
  function send(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const handler = (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          ws.off('message', handler);
          if (msg.error) reject(msg.error);
          else resolve(msg.result);
        }
      };
      ws.on('message', handler);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  await send('Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(selector)})?.click()`,
    awaitPromise: true,
  });
  await new Promise((r) => setTimeout(r, waitMs));
  const result = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(outPath, Buffer.from(result.data, 'base64'));
  console.log('salvo em', outPath);
  ws.close();
}

main().catch((err) => {
  console.error('ERRO:', err);
  process.exit(1);
});
