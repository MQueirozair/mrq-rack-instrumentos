// Copia arquivos estáticos que o tsc não processa (HTML da página remota, etc.)
const fs = require('node:fs');
const path = require('node:path');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

const root = path.join(__dirname, '..');
copyDir(path.join(root, 'electron/remote-ui'), path.join(root, 'dist-electron/electron/remote-ui'));

// O package.json da raiz tem "type": "module" (por causa do Vite/renderer), mas o
// processo main do Electron é compilado para CommonJS. Este arquivo garante que o
// Node trate dist-electron/** como CommonJS, independente da raiz.
fs.writeFileSync(path.join(root, 'dist-electron/package.json'), JSON.stringify({ type: 'commonjs' }, null, 2));

console.log('[copy-static] remote-ui copiado e package.json de override criado em dist-electron/');
