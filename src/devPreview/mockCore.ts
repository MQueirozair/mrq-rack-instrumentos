/**
 * Shim de pré-visualização — substitui '@tauri-apps/api/core' só dentro do
 * harness de teste (ver vite.preview.config.ts). Reexporta TUDO do pacote
 * real (por um caminho relativo direto pro arquivo em node_modules, não
 * pelo nome do pacote — importar `'@tauri-apps/api/core'` aqui criaria uma
 * referência circular pra este próprio arquivo, já que é exatamente esse
 * specifier que o alias intercepta em todo o projeto) e sobrescreve só
 * `invoke`, que é a única função que os componentes reais (mrqFormat.ts,
 * kontaktCapture.ts) realmente chamam. Isso preserva `Resource`/`Channel`/
 * `convertFileSrc`/etc. — usados internamente por outros pacotes
 * `@tauri-apps/plugin-*` importados (sem relação com este teste) por
 * `src/tauriBridge.ts`, que o scanner de dependências do Vite alcança
 * mesmo sem esse arquivo rodar de verdade aqui.
 */
export * from '../../node_modules/@tauri-apps/api/core.js';
export { mockInvoke as invoke, mockConvertFileSrc as convertFileSrc } from './mockShared';
