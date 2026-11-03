const WebSocket = require('ws');
const fs = require('fs');

async function main() {
  const outPath = process.argv[2] || 'screenshot.png';
  const listRes = await fetch('http://127.0.0.1:9338/json');
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
        if (msg.error) reject(msg.error);
        else resolve(msg.result);
      }
    });
    ws.send(JSON.stringify({ id, method: 'Page.captureScreenshot', params: { format: 'png' } }));
  });
  fs.writeFileSync(outPath, Buffer.from(result.data, 'base64'));
  console.log('salvo em', outPath);
  ws.close();
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
