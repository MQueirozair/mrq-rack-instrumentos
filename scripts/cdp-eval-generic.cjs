// Variante do cdp-eval.cjs com porta configurável via env CDP_PORT (default 9333).
const WebSocket = require('ws');

async function main() {
  const port = process.env.CDP_PORT || '9333';
  const expr = process.argv[2];
  const listRes = await fetch(`http://127.0.0.1:${port}/json`);
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
