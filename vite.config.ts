import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Alvo de compatibilidade EXPLÍCITO (em vez de confiar no default do Vite,
    // que já mudou de versão pra versão — em builds recentes do Vite o default
    // é "baseline-widely-available", que hoje em dia já pressupõe Safari 16.4+).
    // O app declara suporte a macOS 10.15/Catalina em
    // src-tauri/tauri.conf.json (bundle.macOS.minimumSystemVersion) — cujo
    // WebKit embutido (WKWebView) é equivalente ao Safari ~13. Se o bundle
    // usar sintaxe mais nova que isso (ex.: teria acontecido silenciosamente
    // numa futura atualização do Vite), o <script type="module"> inteiro falha
    // com SyntaxError ANTES de qualquer linha do app rodar — nenhum
    // try/catch em main.tsx consegue pegar isso, porque o módulo nunca chega
    // a executar. O resultado visível pro usuário é a janela só com a cor de
    // fundo (#0b0b0d, quase preta) pra sempre: a "tela preta" relatada no Mac.
    // es2019 cobre Safari 12+ com folga (fica abaixo até do nosso piso
    // declarado), então o bundle sempre vai ao menos EXECUTAR em qualquer Mac
    // suportado — mesmo que algum recurso específico (ex.: AudioWorklet, só
    // usado por alguns formatos de instrumento) ainda dependa de um SO mais
    // novo em tempo de execução.
    target: 'es2019',
  },
});
