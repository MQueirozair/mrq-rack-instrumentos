// Carregador compartilhado do módulo wasm `npno-wasm` (ver native/npno-wasm/):
// o mesmo binário decodifica tanto bibliotecas de piano Nord (`.npno`, via
// npno_decode/npno_sniff) quanto amostras da Nord Sample Library (`.nsmp`,
// `.nsmp3`, `.nsmp4`, via nsmp_decode/nsmp_sniff) — ambos usando o crate Rust
// `nord-format`. Fica num único módulo pra NpnoLayerVoice.ts e
// NsmpLayerVoice.ts nunca instanciarem o wasm duas vezes.

// Caminho relativo ao index.html publicado (ver public/vendor/npno-wasm e
// vite.config.ts, base: './'). Diferente de `audioWorklet.addModule` (que
// resolve relativo ao documento), o `import()` dinâmico do ES resolve
// relativo ao módulo bundlado que o chama — então aqui é preciso montar a URL
// a partir de `document.baseURI` explicitamente, senão o caminho acaba
// relativo ao chunk JS dentro de `dist/assets/`, não a `dist/`.
function wasmJsUrl(): string {
  return new URL('vendor/npno-wasm/npno_wasm.js', document.baseURI).href;
}

export interface NordWasmModule {
  default: (input?: unknown) => Promise<unknown>;
  npno_decode: (bytes: Uint8Array) => { metadata_json: string; pcm: Uint8Array };
  npno_sniff: (bytes: Uint8Array) => string;
  nsmp_decode: (bytes: Uint8Array) => { metadata_json: string; pcm: Uint8Array };
  nsmp_sniff: (bytes: Uint8Array) => string;
}

let wasmModulePromise: Promise<NordWasmModule> | null = null;
export function loadNordWasmModule(): Promise<NordWasmModule> {
  if (!wasmModulePromise) {
    wasmModulePromise = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = (await import(/* @vite-ignore */ wasmJsUrl())) as any as NordWasmModule;
      await mod.default();
      return mod;
    })();
  }
  return wasmModulePromise;
}
