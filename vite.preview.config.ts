/**
 * Config SEPARADA e SÓ PARA O HARNESS DE TESTE MANUAL (dev-preview.html) —
 * `vite.config.ts` (usado pelo build real/Tauri/Electron) continua
 * intocado. O único propósito deste arquivo é apontar os dois pacotes
 * `@tauri-apps/*` que os componentes de produção importam pros mocks em
 * `src/devPreview/`, pra dar pra abrir as telas num navegador comum sem
 * window nativa do Tauri. Ver src/devPreview/README (comentários em
 * mockShared.ts) pro que exatamente é mockado.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  base: './',
  plugins: [
    react(),
    {
      // Redireciona "/" -> "/dev-preview.html" só neste dev server de
      // teste, pra quem abrir o link da pré-visualização cair direto na
      // tela certa (o index.html de produção não é afetado — ele só
      // existe no mesmo diretório, não é servido por este config).
      name: 'redirect-root-to-dev-preview',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === '/') {
            res.writeHead(302, { Location: '/dev-preview.html' });
            res.end();
            return;
          }
          next();
        });
      },
    },
  ],
  resolve: {
    alias: {
      '@tauri-apps/plugin-dialog': path.resolve(__dirname, 'src/devPreview/mockDialog.ts'),
      '@tauri-apps/api/core': path.resolve(__dirname, 'src/devPreview/mockCore.ts'),
    },
  },
  server: {
    host: true,
    port: 5183,
    strictPort: true,
    // Necessário pro preview proxiado do sandbox (host dinâmico tipo
    // "5183-xxxx.e2b.app") não ser rejeitado pela checagem de Host header.
    allowedHosts: true,
  },
  appType: 'mpa',
});
