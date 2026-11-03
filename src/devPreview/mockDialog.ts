// Shim de pré-visualização — substitui '@tauri-apps/plugin-dialog' só
// dentro do harness de teste (ver vite.preview.config.ts e o comentário em
// mockCore.ts sobre por que o reexport usa um caminho relativo direto em
// vez do nome do pacote).
export * from '../../node_modules/@tauri-apps/plugin-dialog/dist-js/index.js';
export { mockOpenDialog as open, mockSaveDialog as save, mockAskDialog as ask } from './mockShared';
