/* tslint:disable */
/* eslint-disable */

export class DecodedNpno {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly metadata_json: string;
    /**
     * PCM de 16 bits (little-endian, nativo do wasm) de todos os strokes,
     * concatenados na ordem em que aparecem em `metadata_json().strokes`.
     */
    readonly pcm: Uint8Array;
}

export class DecodedNsmp {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly metadata_json: string;
    /**
     * PCM de 16 bits (little-endian, nativo do wasm) de todas as zonas,
     * concatenadas na ordem em que aparecem em `metadata_json().zones`.
     */
    readonly pcm: Uint8Array;
}

/**
 * Decodifica os bytes brutos de um arquivo `.npno` (biblioteca de piano Nord).
 * Lança uma exceção JS (string) se o arquivo não for um `.npno` válido.
 */
export function npno_decode(bytes: Uint8Array | number[]): DecodedNpno;

/**
 * Só confere a assinatura/estrutura do contêiner, sem decodificar áudio — usado para
 * validar rapidamente um arquivo antes do usuário confirmar o carregamento de uma
 * biblioteca grande.
 */
export function npno_sniff(bytes: Uint8Array | number[]): string;

/**
 * Decodifica os bytes brutos de um arquivo `.nsmp`/`.nsmp3`/`.nsmp4` (amostra
 * Nord Sample Library). Lança uma exceção JS (string) se o arquivo não for
 * uma amostra Nord válida.
 */
export function nsmp_decode(bytes: Uint8Array | number[]): DecodedNsmp;

/**
 * Só confere a assinatura/estrutura do contêiner, sem decodificar áudio —
 * mesma ideia de `npno_sniff`, mas para amostras `.nsmp`/`.nsmp3`/`.nsmp4`.
 */
export function nsmp_sniff(bytes: Uint8Array | number[]): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_decodednpno_free: (a: number, b: number) => void;
    readonly __wbg_decodednsmp_free: (a: number, b: number) => void;
    readonly decodednpno_metadata_json: (a: number, b: number) => void;
    readonly decodednpno_pcm: (a: number, b: number) => void;
    readonly decodednsmp_metadata_json: (a: number, b: number) => void;
    readonly decodednsmp_pcm: (a: number, b: number) => void;
    readonly npno_decode: (a: number, b: number, c: number) => void;
    readonly npno_sniff: (a: number, b: number, c: number) => void;
    readonly nsmp_decode: (a: number, b: number, c: number) => void;
    readonly nsmp_sniff: (a: number, b: number, c: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
