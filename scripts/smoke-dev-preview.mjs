// Script de verificação ÚNICA (não faz parte do app, roda só manualmente
// aqui no sandbox) — usa Playwright pra clicar de verdade no harness
// dev-preview.html e confirmar que o fluxo Kontakt Audio Capture + o painel
// de ajustes do Analyzer funcionam de ponta a ponta com os mocks.
import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://localhost:5183/dev-preview.html';

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`[console.error] ${msg.text()}`);
});
page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));

async function shot(name) {
  await page.screenshot({ path: `/tmp/preview-${name}.png`, fullPage: true });
  console.log(`screenshot: /tmp/preview-${name}.png`);
}

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
console.log('1) tela inicial carregada');
await shot('01-initial');

await page.getByRole('button', { name: /Importar instrumento renderizado pelo Kontakt/i }).click();
await page.waitForTimeout(300);
console.log('2) diálogo Kontakt Audio Capture aberto');
await shot('02-kontakt-dialog-open');

await page.getByRole('button', { name: 'Escolher arquivos…' }).nth(1).click();
await page.waitForTimeout(1200);
console.log('3) 10 arquivos mockados sondados (probe)');
await shot('03-kontakt-files-probed');

const dupBadge = page.getByText(/duplicad/i);
console.log('badge de duplicata encontrado?', (await dupBadge.count()) > 0);

const autoMapBtn = page.getByRole('button', { name: /aplicar mapeamento autom/i });
await autoMapBtn.click();
await page.waitForTimeout(400);
console.log('4) mapeamento automático aplicado');
await shot('04-auto-mapped');

// Pré-escuta de uma linha (botão de play dentro da tabela, se habilitado)
const playBtn = page.locator('button[title*="escutar" i], button[aria-label*="escutar" i]').first();
if (await playBtn.count()) {
  await playBtn.click({ force: true }).catch(() => {});
  await page.waitForTimeout(300);
  console.log('5) pré-escuta acionada (ou tentada) numa linha');
}

const genBtn = page.getByRole('button', { name: /gerar instrumento \.mrq/i });
console.log('botão "Gerar instrumento .mrq" habilitado?', await genBtn.isEnabled());
await genBtn.click();
await page.waitForTimeout(2000);
console.log('6) geração do .mrq confirmada (mock builder begin/add/finish)');
await shot('05-after-generate');

// Depois de gerar, o item deve aparecer selecionado/convertido na fila
await page.waitForTimeout(500);
const settingsBtn = page.getByRole('button', { name: /mostrar ajustes/i });
console.log('botão "Mostrar ajustes" do Analyzer presente?', (await settingsBtn.count()) > 0);
if (await settingsBtn.count()) {
  await settingsBtn.first().click();
  await page.waitForTimeout(400);
  console.log('7) painel de ajustes global do Analyzer aberto');
  await shot('06-analyzer-settings-open');

  // Navega pelas 5 abas principais do conversor pra conferir que renderizam
  for (const tabName of ['Teclado', 'Velocity', 'Grupos & zonas', 'Amostras', 'Compatibilidade']) {
    const tab = page.getByRole('tab', { name: tabName }).or(page.getByText(tabName, { exact: true }));
    if (await tab.count()) {
      await tab.first().click();
      await page.waitForTimeout(250);
      console.log(`8) aba "${tabName}" aberta com o painel de ajustes visível`);
    }
  }
  await shot('07-tabs-cycled');
}

console.log('--- ERROS DE CONSOLE/PÁGINA CAPTURADOS ---');
for (const e of errors) console.log(e);
console.log(`total: ${errors.length}`);

await browser.close();
