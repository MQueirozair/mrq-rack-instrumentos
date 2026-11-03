import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

/**
 * `.mrqi` — "MRQ Instrument": formato leve e 100% nosso (nenhum código ou
 * layout derivado de formato de terceiros) que o Rack usa como alvo de
 * conversão pra timbres importados de outros formatos (hoje: Kontakt
 * `.nki`). A ideia: em vez de reabrir/redecodificar várias amostras WAV
 * espalhadas em pastas toda vez que a camada carrega, empacota tudo (mapa
 * de zonas + áudio já em PCM) num único arquivo, pronto pra reconstruir os
 * AudioBuffer sem nenhuma decodificação de áudio (sem decodeAudioData) —
 * só leitura binária direta. Isso é o que torna o carregamento "mais
 * leve"/mais rápido pedido pelo usuário.
 *
 * Contêiner: um .zip comum (lido/escrito com a lib fflate, pura JS, sem
 * WASM) contendo:
 *   manifest.json       — ver MrqiManifest abaixo
 *   audio/000.pcmf32     — cabeçalho fixo (sampleRate, channels, frameCount)
 *                          + amostras Float32 intercaladas, cru. O próprio
 *                          zip já comprime essa entrada (DEFLATE), o que dá
 *                          um tamanho final bem menor que WAV solto, sem
 *                          precisar de um codec de áudio dedicado.
 *   artwork.png          — opcional, foto da camada (se houver)
 */

export const MRQI_FORMAT_VERSION = 1;

export interface MrqiZoneDef {
  groupId: string;
  sample: string; // caminho relativo dentro do pacote, ex: "audio/000.pcmf32"
  rootNote: number;
  loKey: number;
  hiKey: number;
  loVel: number;
  hiVel: number;
  tuneCents: number;
  volume: number;
  pan: number;
  loopEnabled?: boolean;
  loopStart?: number;
  loopEnd?: number;
}

export interface MrqiGroupDef {
  id: string;
  name: string;
}

export interface MrqiManifest {
  formatVersion: number;
  name: string;
  sourceFormat: string; // informativo apenas, ex: "kontakt-1-4"
  importedAt: string;
  groups: MrqiGroupDef[];
  zones: MrqiZoneDef[];
}

/** Uma amostra de áudio já decodificada, pronta pra empacotar. */
export interface MrqiSampleInput {
  sampleRate: number;
  channels: number;
  /** canais intercalados (ex.: [L0,R0,L1,R1,...] se channels=2) */
  data: Float32Array;
}

const PCMF32_MAGIC = 0x6d717066; // "mqpf" em little-endian, só uma assinatura simples pra sanity-check

function encodePcmF32(sample: MrqiSampleInput): Uint8Array {
  const frameCount = sample.channels > 0 ? Math.floor(sample.data.length / sample.channels) : 0;
  const header = new ArrayBuffer(16);
  const headerView = new DataView(header);
  headerView.setUint32(0, PCMF32_MAGIC, true);
  headerView.setUint32(4, sample.sampleRate, true);
  headerView.setUint32(8, sample.channels, true);
  headerView.setUint32(12, frameCount, true);
  const out = new Uint8Array(16 + sample.data.length * 4);
  out.set(new Uint8Array(header), 0);
  new Float32Array(out.buffer, 16, sample.data.length).set(sample.data);
  return out;
}

function decodePcmF32(bytes: Uint8Array): MrqiSampleInput {
  if (bytes.length < 16) throw new Error('Bloco de áudio .mrqi inválido (menor que o cabeçalho esperado).');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== PCMF32_MAGIC) throw new Error('Bloco de áudio .mrqi com assinatura inválida.');
  const sampleRate = view.getUint32(4, true);
  const channels = view.getUint32(8, true);
  const frameCount = view.getUint32(12, true);
  const dataBytes = bytes.subarray(16);
  // cópia (não view) pra garantir alinhamento de 4 bytes independente de onde
  // "bytes" começa dentro do ArrayBuffer original (fflate pode devolver
  // subarrays não alinhados).
  const data = new Float32Array(frameCount * channels);
  const dv = new DataView(dataBytes.buffer, dataBytes.byteOffset, dataBytes.byteLength);
  for (let i = 0; i < data.length; i++) data[i] = dv.getFloat32(i * 4, true);
  return { sampleRate, channels, data };
}

/** Monta o Uint8Array final de um pacote .mrqi a partir do manifesto (cujos
 *  `zones[].sample` já devem apontar pra "audio/NNN.pcmf32") e das amostras
 *  correspondentes, na mesma ordem. */
export function packMrqi(
  manifest: Omit<MrqiManifest, 'formatVersion'>,
  samples: MrqiSampleInput[],
  artworkPng?: Uint8Array
): Uint8Array {
  const full: MrqiManifest = { formatVersion: MRQI_FORMAT_VERSION, ...manifest };
  const files: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify(full)),
  };
  samples.forEach((sample, i) => {
    const name = `audio/${String(i).padStart(3, '0')}.pcmf32`;
    files[name] = encodePcmF32(sample);
  });
  if (artworkPng) files['artwork.png'] = artworkPng;
  // nível de compressão moderado: o conteúdo já é PCM (pouco compressível
  // por natureza), então um nível alto custaria CPU sem ganho relevante.
  return zipSync(files, { level: 6 });
}

export interface UnpackedMrqi {
  manifest: MrqiManifest;
  /** amostra decodificada por caminho relativo (ex.: "audio/000.pcmf32") */
  samplesByPath: Map<string, MrqiSampleInput>;
  artworkPng?: Uint8Array;
}

export function unpackMrqi(bytes: Uint8Array): UnpackedMrqi {
  const files = unzipSync(bytes);
  const manifestBytes = files['manifest.json'];
  if (!manifestBytes) throw new Error('Pacote .mrqi inválido: manifest.json ausente.');
  const manifest = JSON.parse(strFromU8(manifestBytes)) as MrqiManifest;
  if (manifest.formatVersion !== MRQI_FORMAT_VERSION) {
    throw new Error(
      `Pacote .mrqi de versão ${manifest.formatVersion} não suportada por esta versão do app (esperado ${MRQI_FORMAT_VERSION}).`
    );
  }
  const samplesByPath = new Map<string, MrqiSampleInput>();
  for (const [path, data] of Object.entries(files)) {
    if (path.startsWith('audio/') && path.endsWith('.pcmf32')) {
      samplesByPath.set(path, decodePcmF32(data));
    }
  }
  return { manifest, samplesByPath, artworkPng: files['artwork.png'] };
}

/** Converte um AudioBuffer do Web Audio em MrqiSampleInput (canais
 *  intercalados), pronto pra `packMrqi`. */
export function audioBufferToSampleInput(buffer: AudioBuffer): MrqiSampleInput {
  const { numberOfChannels: channels, length, sampleRate } = buffer;
  const data = new Float32Array(length * channels);
  const chans: Float32Array[] = [];
  for (let c = 0; c < channels; c++) chans.push(buffer.getChannelData(c));
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < channels; c++) data[i * channels + c] = chans[c][i];
  }
  return { sampleRate, channels, data };
}

/** Reconstrói um AudioBuffer a partir de um MrqiSampleInput, sem nenhuma
 *  decodificação de áudio (decodeAudioData) — é exatamente esse passo a
 *  menos que torna o carregamento de um .mrqi mais rápido que reabrir as
 *  amostras originais. */
export function sampleInputToAudioBuffer(ctx: BaseAudioContext, sample: MrqiSampleInput): AudioBuffer {
  const frameCount = sample.channels > 0 ? Math.floor(sample.data.length / sample.channels) : 0;
  const buffer = ctx.createBuffer(Math.max(1, sample.channels), Math.max(1, frameCount), sample.sampleRate || 44100);
  for (let c = 0; c < sample.channels; c++) {
    const channelData = buffer.getChannelData(c);
    for (let i = 0; i < frameCount; i++) channelData[i] = sample.data[i * sample.channels + c];
  }
  return buffer;
}
