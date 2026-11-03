/**
 * Detecção mínima (sem nenhum import, sem efeito colateral) de "este app
 * está rodando dentro de um webview do Tauri?" — mesma checagem usada em
 * main.tsx pra decidir se carrega tauriBridge.ts. Extraído pra um módulo
 * próprio pra poder ser importado por qualquer componente/módulo que
 * precise esconder ou bloquear uma funcionalidade exclusiva do Tauri (hoje,
 * o MRQ Instrument Converter inteiro e o formato `.mrq` no Rack) sem puxar
 * o bridge inteiro nem nenhum pacote `@tauri-apps/*` no bundle Electron.
 */
export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
