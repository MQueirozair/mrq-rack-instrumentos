const fs = require('node:fs');
const path = require('node:path');
const png2icons = require('png2icons');
const sharp = require('sharp');

async function main() {
  const root = path.join(__dirname, '..');
  const srcPath = path.join(root, 'appResources/logo-source.png');
  const input = fs.readFileSync(srcPath);

  // png2icons funciona melhor com cantos "quadrados" (ele aplica máscara);
  // já exportamos um PNG 1024x1024.
  const icoBuf = png2icons.createICO(input, png2icons.BILINEAR, 0, false, true);
  if (icoBuf) fs.writeFileSync(path.join(root, 'appResources/icon.ico'), icoBuf);

  const icnsBuf = png2icons.createICNS(input, png2icons.BILINEAR, 0);
  if (icnsBuf) fs.writeFileSync(path.join(root, 'appResources/icon.icns'), icnsBuf);

  await sharp(srcPath).resize(512, 512).toFile(path.join(root, 'appResources/icon.png'));
  await sharp(srcPath).resize(256, 256).toFile(path.join(root, 'public/app-icon-256.png'));
  await sharp(srcPath).resize(64, 64).toFile(path.join(root, 'public/app-icon-64.png'));

  console.log('[make-icons] ícones gerados em appResources/ e public/');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
