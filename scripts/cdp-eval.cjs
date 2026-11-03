// Pequeno utilitário para executar JS no renderer via Chrome DevTools Protocol,
// usado apenas para testes manuais neste ambiente de sandbox (sem janela de
// diálogo nativa interativa). Uso: node scripts/cdp-eval.cjs "1+1"
const WebSocket = require('ws');

async function main() {
  const expr = process.argv[2];
  const listRes = await fetch('http://127.0.0.1:9333/json');
  const list = await listRes.json();
  const page = list.find((p) => p.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  const result = await new Promise((resolve, reject) => {
    const id = 1;
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        if (msg.result?.exceptionDetails) reject(msg.result.exceptionDetails);
        else resolve(msg.result);
      }
    });
    ws.send(
      JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression: expr, awaitPromise: true, returnByValue: true },
      })
    );
  });

  console.log(JSON.stringify(result, null, 2));
  ws.close();
}

main().catch((err) => {
  console.error('ERRO:', err);
  process.exit(1);
});
