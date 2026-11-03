/**
 * Harness de pré-visualização SÓ PARA TESTE MANUAL em navegador comum (fora
 * do Tauri) — NÃO faz parte do app de produção, não é importado por
 * nenhum arquivo de produção, e não troca nenhuma linha dos componentes
 * reais. Mocka só as DUAS bordas externas que os componentes reais chamam
 * (`@tauri-apps/api/core`'s `invoke` e `@tauri-apps/plugin-dialog`'s
 * `open`/`save`) + `window.api` (ponte do build Electron), com dados
 * sintéticos (áudio gerado por síntese simples, nunca arquivo real), pra
 * dar pra clicar em "Importar instrumento renderizado pelo Kontakt…" e no
 * "⚙ Mostrar ajustes" do Analyzer sem precisar compilar o app Tauri inteiro
 * (que exige GUI nativa, indisponível neste sandbox).
 *
 * Ver vite.preview.config.ts (alias que aponta os dois pacotes `@tauri-apps/*`
 * pra cá) e src/devPreview/{mockCore,mockDialog}.ts (shims finos).
 */

// ---------------------------------------------------------------------------
// Síntese de áudio determinística — nunca lê arquivo real, só gera um tom
// (com decaimento, pra soar como uma nota dedilhada/percutida) a partir do
// hash do PATH/ID, pra cada "arquivo" fake soar diferente e de forma
// consistente entre a sondagem (probe) e a pré-escuta/waveform depois.
// ---------------------------------------------------------------------------

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

// Pares de arquivos que devem ser tratados como DUPLICATA de conteúdo (pra
// testar o badge "duplicado" do KontaktCaptureDialog) — tudo que não está
// aqui recebe um hash único derivado só do próprio nome.
const DUPLICATE_GROUPS: string[][] = [['Kick.wav', 'Kick_copy.wav']];

function duplicateKeyFor(fileName: string): string | null {
  const group = DUPLICATE_GROUPS.find((g) => g.includes(fileName));
  return group ? group[0] : null;
}

export interface SynthParams {
  frequencyHz: number;
  durationSeconds: number;
  sampleRateHz: number;
  channels: number;
}

export function synthParamsForPath(path: string): SynthParams {
  const fileName = path.split(/[\\/]/).pop() ?? path;
  const dupKey = duplicateKeyFor(fileName);
  const h = hashString(dupKey ?? fileName);
  // IMPORTANTE: nunca usar operadores bitwise (`>>`, `|`, etc.) em cima de
  // `h` aqui — `hashString` devolve um uint32 que pode passar de 2^31, e
  // operadores bitwise em JS convertem pra Int32 primeiro, virando negativo
  // e produzindo duração negativa (=> `new Float32Array(-N)` explode). Só
  // aritmética normal (`%`, `/`, `Math.floor`) a partir daqui.
  return {
    frequencyHz: 180 + (h % 500), // 180–680 Hz, só pra variar o timbre entre arquivos
    durationSeconds: 0.6 + (Math.floor(h / 16) % 26) / 10, // 0.6–3.2s
    sampleRateHz: h % 7 === 0 ? 48000 : 44100,
    channels: /kick|hat|snare|perc|clap/i.test(fileName) ? 1 : 2,
  };
}

export function fakeSha256For(path: string): string {
  const fileName = path.split(/[\\/]/).pop() ?? path;
  const dupKey = duplicateKeyFor(fileName);
  const h = hashString(dupKey ?? fileName);
  return `mock${h.toString(16).padStart(8, '0')}`.repeat(4).slice(0, 64);
}

function synthInterleaved(params: SynthParams): Float32Array {
  const frameCount = Math.round(params.durationSeconds * params.sampleRateHz);
  const out = new Float32Array(frameCount * params.channels);
  for (let i = 0; i < frameCount; i += 1) {
    const t = i / params.sampleRateHz;
    const envelope = Math.exp(-t * 1.8); // decaimento tipo nota dedilhada
    const sample = Math.sin(2 * Math.PI * params.frequencyHz * t) * envelope * 0.6;
    for (let ch = 0; ch < params.channels; ch += 1) {
      // leve diferença de fase entre canais só pra não ser um mono idêntico
      const phase = ch === 0 ? 0 : 0.02;
      out[i * params.channels + ch] = Math.sin(2 * Math.PI * params.frequencyHz * (t + phase)) * envelope * 0.6;
    }
  }
  return out;
}

function encodeWav(interleaved: Float32Array, sampleRateHz: number, channels: number): Blob {
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataSize = interleaved.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  function writeStr(offset: number, s: string) {
    for (let i = 0; i < s.length; i += 1) view.setUint8(offset + i, s.charCodeAt(i));
  }
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, sampleRateHz * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < interleaved.length; i += 1) {
    const s = Math.max(-1, Math.min(1, interleaved[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export function fakeAudioUrlForPath(path: string): string {
  const params = synthParamsForPath(path);
  const blob = encodeWav(synthInterleaved(params), params.sampleRateHz, params.channels);
  return URL.createObjectURL(blob);
}

function decodedSampleForParams(sampleId: string, params: SynthParams) {
  return {
    sampleId,
    interleaved: synthInterleaved(params),
    sampleRateHz: params.sampleRateHz,
    channels: params.channels,
    bitsPerSampleEncoded: 16,
  };
}

// ---------------------------------------------------------------------------
// Estado em memória do "backend" mockado — espelha só o suficiente de
// src-tauri/src/importers/kontakt_capture.rs e mrq/writer.rs pra exercitar
// de verdade o fluxo begin → add (em loop) → finish → read_metadata/extract
// que os componentes reais (kontaktCapture.ts, mrqFormat.ts) chamam.
// ---------------------------------------------------------------------------

interface MockSession {
  finalPath: string;
  instrument: unknown;
  added: Map<string, { originalPath: string; params: SynthParams; sha256: string }>;
}

interface MockFileMetadata {
  formatVersion: number;
  instrument: unknown;
  samples: Array<{
    id: string;
    relativeOffset: number;
    length: number;
    sha256: string;
    sampleRateHz: number;
    channels: number;
    bitsPerSampleOriginal?: number;
    bitsPerSampleEncoded: number;
    convertedFromFloat32: boolean;
    codec: string;
  }>;
}

const sessions = new Map<string, MockSession>();
const metadataByPath = new Map<string, MockFileMetadata>();
const sampleOriginByCompositeKey = new Map<string, SynthParams>();
let sessionCounter = 0;

function newSessionId(): string {
  sessionCounter += 1;
  return `mock-session-${sessionCounter}`;
}

export async function mockInvoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 60 + Math.random() * 120)); // simula latência real

  switch (cmd) {
    // --- Kontakt Audio Capture (kontaktCapture.ts) -------------------------
    case 'mrq_capture_probe_audio_file': {
      const path = String(args.path);
      const params = synthParamsForPath(path);
      return {
        durationSeconds: params.durationSeconds,
        sampleRateHz: params.sampleRateHz,
        channels: params.channels,
        bitsPerSampleOriginal: 24,
        contentSha256: fakeSha256For(path),
      };
    }
    case 'mrq_capture_add_sample': {
      const sessionId = String(args.sessionId);
      const sampleId = String(args.sampleId);
      const path = String(args.path);
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`[mock] sessão desconhecida: ${sessionId}`);
      const params = synthParamsForPath(path);
      const sha256 = fakeSha256For(path);
      session.added.set(sampleId, { originalPath: path, params, sha256 });
      return {
        id: sampleId,
        relativeOffset: session.added.size * 4096,
        length: Math.round(params.durationSeconds * params.sampleRateHz * params.channels * 2),
        sha256,
        sampleRateHz: params.sampleRateHz,
        channels: params.channels,
        bitsPerSampleOriginal: 24,
        bitsPerSampleEncoded: 16,
        convertedFromFloat32: false,
        codec: 'flac',
      };
    }

    // --- Pipeline genérico .mrq (mrqFormat.ts) ------------------------------
    case 'mrq_builder_begin': {
      const sessionId = newSessionId();
      sessions.set(sessionId, { finalPath: String(args.finalPath), instrument: args.instrument, added: new Map() });
      return sessionId;
    }
    case 'mrq_builder_finish': {
      const sessionId = String(args.sessionId);
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`[mock] sessão desconhecida: ${sessionId}`);
      const samples = [...session.added.entries()].map(([id, info], i) => {
        sampleOriginByCompositeKey.set(`${session.finalPath}::${id}`, info.params);
        return {
          id,
          relativeOffset: i * 4096,
          length: Math.round(info.params.durationSeconds * info.params.sampleRateHz * info.params.channels * 2),
          sha256: info.sha256,
          sampleRateHz: info.params.sampleRateHz,
          channels: info.params.channels,
          bitsPerSampleOriginal: 24,
          bitsPerSampleEncoded: 16,
          convertedFromFloat32: false,
          codec: 'flac',
        };
      });
      metadataByPath.set(session.finalPath, { formatVersion: 1, instrument: session.instrument, samples });
      sessions.delete(sessionId);
      return { path: session.finalPath, sampleCount: samples.length };
    }
    case 'mrq_builder_abort': {
      sessions.delete(String(args.sessionId));
      return undefined;
    }
    case 'mrq_read_metadata': {
      const path = String(args.path);
      const meta = metadataByPath.get(path);
      if (!meta) throw new Error(`[mock] nenhum .mrq "gravado" neste caminho na sessão de teste: ${path}`);
      return meta;
    }
    case 'mrq_extract_sample': {
      const path = String(args.path);
      const sampleId = String(args.sampleId);
      const params = sampleOriginByCompositeKey.get(`${path}::${sampleId}`) ?? synthParamsForPath(sampleId);
      return decodedSampleForParams(sampleId, params);
    }
    case 'mrq_validate_integrity': {
      return { ok: true, issues: [] };
    }

    // --- Importador de áudio avulso (WAV/AIFF/FLAC/MP3/OGG) — usado pelo
    //     botão genérico "Escolher arquivos…" do topo do conversor --------
    case 'mrq_inspect_audio_file': {
      const path = String(args.path);
      return {
        instrument: {
          name: path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? 'Amostra',
          sourceFormat: 'wav',
          importedAt: new Date().toISOString(),
          presets: [
            {
              id: 'preset-0',
              name: 'Amostra única',
              groups: [
                {
                  id: 'group-0',
                  name: 'Amostra',
                  zones: [
                    {
                      sampleId: 'audio-sample-0',
                      rootNote: 72,
                      loKey: 0,
                      hiKey: 127,
                      loVel: 0,
                      hiVel: 127,
                      tuneCents: 0,
                      volumeDb: 0,
                      pan: 0,
                      stereo: synthParamsForPath(path).channels >= 2 ? 'stereo' : 'mono',
                    },
                  ],
                },
              ],
            },
          ],
        },
        compatibility: {
          preserved: [{ field: 'Áudio', detail: '(mock de pré-visualização) tom sintetizado no navegador, não o arquivo real.' }],
          approximated: [],
          unsupported: [],
        },
      };
    }
    case 'mrq_convert_audio_file_to_mrq': {
      const sourcePath = String(args.sourcePath);
      const destPath = String(args.destPath);
      const params = synthParamsForPath(sourcePath);
      sampleOriginByCompositeKey.set(`${destPath}::audio-sample-0`, params);
      const inspectResult = await mockInvoke('mrq_inspect_audio_file', { path: sourcePath });
      metadataByPath.set(destPath, {
        formatVersion: 1,
        instrument: (inspectResult as { instrument: unknown }).instrument,
        samples: [
          {
            id: 'audio-sample-0',
            relativeOffset: 0,
            length: Math.round(params.durationSeconds * params.sampleRateHz * params.channels * 2),
            sha256: fakeSha256For(sourcePath),
            sampleRateHz: params.sampleRateHz,
            channels: params.channels,
            bitsPerSampleOriginal: 24,
            bitsPerSampleEncoded: 16,
            convertedFromFloat32: false,
            codec: 'flac',
          },
        ],
      });
      return { finish: { path: destPath, sampleCount: 1 }, compatibility: (inspectResult as { compatibility: unknown }).compatibility };
    }

    default:
      throw new Error(`[mock] comando Tauri "${cmd}" não implementado neste harness de pré-visualização (só roda de verdade no app Tauri).`);
  }
}

// ---------------------------------------------------------------------------
// @tauri-apps/plugin-dialog — "abre" seletor de arquivo/pasta devolvendo
// caminhos fictícios pré-definidos (nunca lê o disco de verdade: não existe
// disco de verdade acessível a partir do navegador aqui).
// ---------------------------------------------------------------------------

const MOCK_KONTAKT_FILES = [
  'Piano_C3_v032.wav',
  'Piano_C3_v064.wav',
  'Piano_C3_v100.wav',
  'Piano_E3_v032.wav',
  'Piano_E3_v064.wav',
  'Piano_E3_v100.wav',
  'Strings_sus_A3_v096_rr1.wav',
  'Strings_sus_A3_v096_rr2.wav',
  'Kick.wav',
  'Kick_copy.wav',
];

export async function mockOpenDialog(opts: Record<string, unknown> = {}): Promise<string[] | string | null> {
  await new Promise((r) => setTimeout(r, 200));
  if (opts.directory) {
    return '/mock-kontakt-render/Piano Expressivo';
  }
  const title = String(opts.title ?? '');
  if (title.includes('Kontakt')) {
    return MOCK_KONTAKT_FILES.map((f) => `/mock-kontakt-render/${f}`);
  }
  // Seletor genérico do topo do conversor (qualquer outro formato) — um
  // único WAV fake, só pra provar que o fluxo antigo continua funcionando.
  return ['/mock-instruments/Exemplo.wav'];
}

export async function mockSaveDialog(opts: Record<string, unknown> = {}): Promise<string | null> {
  await new Promise((r) => setTimeout(r, 150));
  const defaultPath = String(opts.defaultPath ?? 'Instrumento.mrq');
  return `/mock-output/${defaultPath}`;
}

/**
 * Stubs nunca exercitados pelo fluxo real de teste (nem InstrumentConverter
 * nem MrqInstrumentAnalyzer usam `ask`/`convertFileSrc`) — existem só pra
 * satisfazer o scanner de dependências do Vite (esbuild), que faz uma
 * varredura estática de TODOS os `.html` do projeto (inclusive o
 * `index.html` de produção, que puxa `src/tauriBridge.ts` via import()
 * dinâmico em `main.tsx`) e precisa achar todo export nomeado importado em
 * qualquer arquivo alcançável, mesmo que o código nunca rode de verdade
 * aqui. Ver mockCore.ts/mockDialog.ts.
 */
export async function mockAskDialog(..._args: unknown[]): Promise<boolean> {
  return false;
}

export function mockConvertFileSrc(path: string): string {
  return fakeAudioUrlForPath(path);
}

// ---------------------------------------------------------------------------
// window.api — ponte do build Electron (ver tauriBridge.ts) que alguns
// componentes também chamam diretamente (fs.toFileUrl/scanFolderTracks,
// log.append). Stub genérico (Proxy) + as duas funções que o
// KontaktCaptureDialog realmente usa, implementadas de verdade com os
// mesmos tons sintéticos do `invoke` mockado acima.
// ---------------------------------------------------------------------------

export function installMockWindowApi() {
  const w = window as unknown as Record<string, unknown>;
  if (w.api) return;
  const genericStubGroup = new Proxy(
    {},
    {
      get: (_t, method: string) => async (...callArgs: unknown[]) => {
        // eslint-disable-next-line no-console
        console.warn(`[mock window.api] chamada não implementada no harness: ${String(method)}`, callArgs);
        return undefined;
      },
    }
  );
  const fs = {
    toFileUrl: async (path: string) => fakeAudioUrlForPath(path),
    scanFolderTracks: async (_folder: string) => MOCK_KONTAKT_FILES.map((f) => ({ name: f.replace(/\.[^.]+$/, ''), filePath: `/mock-kontakt-render/${f}` })),
  };
  w.api = new Proxy(
    { fs },
    {
      get: (target: Record<string, unknown>, prop: string) => (prop in target ? target[prop] : genericStubGroup),
    }
  );
}

export function installMockTauriFlag() {
  const w = window as unknown as Record<string, unknown>;
  if (!('__TAURI_INTERNALS__' in w)) {
    w.__TAURI_INTERNALS__ = {};
  }
}
