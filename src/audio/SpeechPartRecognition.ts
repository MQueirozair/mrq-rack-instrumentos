import type { PartType, SongPart } from '../../shared/types';
import { PART_COLORS } from '../../shared/types';
import { newId } from '../lib/id';
import { mergeDuplicateNames } from './PartRecognition';
import { OfflineAudioContextCompat } from './audioContextCompat';

/**
 * Reconhecimento de partes por VOZ (opcional, desligado por padrão — ver
 * `settings.speech` em shared/types.ts e `SettingsModal.tsx`): em vez de só
 * adivinhar a estrutura pela forma da onda (`PartRecognition.ts`), usa um
 * reconhecimento de voz local (whisper.cpp via `whisper-rs`, ver
 * `src-tauri/src/speech.rs`) pra OUVIR DE VERDADE a locução que a faixa guia
 * costuma trazer anunciando cada parte antes dela começar — convenção comum
 * em multitracks/VS gospel brasileiras (a voz guia diz "Estrofe", conta um
 * compasso, e só então a estrofe começa) documentada por casas como "Mais
 * Que Adoradores" e usada pelo próprio app de referência "Trilha"
 * ("O Trilha ouve a voz guia da multitrack e marca intro, verso e refrão
 * para você conferir").
 *
 * Esse método é mais PRECISO que a heurística por áudio quando a faixa tem
 * locução (o nome da parte vem direto da fala, não de uma suposição por
 * energia/repetição), mas só funciona quando ela existe — por isso
 * `setPartsFromRecognition` em useStore.ts tenta este caminho primeiro e cai
 * de volta pro método heurístico (`recognizeParts`) quando não dá certo
 * (menos de 2 anúncios reconhecidos, sem faixa guia com locução, ou modelo
 * de voz ainda não baixado).
 *
 * Pipeline:
 *   1. resample da faixa guia (já decodificada pelo motor de áudio) pra
 *      16kHz mono — formato que o whisper.cpp espera;
 *   2. encoda um WAV PCM16 mínimo (sem nenhuma lib — cabeçalho fixo de 44
 *      bytes), enviado direto pro comando Rust (sem passar por disco);
 *   3. o Rust transcreve com timestamps por segmento e devolve pro JS;
 *   4. cada segmento transcrito é comparado contra um dicionário de termos
 *      (normalizado: minúsculo, sem acento) pra achar o TIPO da parte que
 *      está sendo anunciada;
 *   5. o fim da locução (+ compasso de contagem, ver `ANNOUNCEMENT_LEAD_BARS`)
 *      vira o início da parte; partes muito próximas demais (transcrição
 *      duplicada da mesma locução) são mescladas.
 */

/** Taxa de amostragem que o whisper.cpp espera na entrada. */
const WHISPER_SAMPLE_RATE = 16000;

/**
 * Nº de compassos de contagem entre o fim da locução e o início de fato da
 * parte. A convenção mais comum (ver pesquisa citada acima) é a voz guia
 * contar UM compasso depois de anunciar o nome ("Estrofe" + 1 compasso de
 * contagem + a estrofe começa) — mas isso varia de faixa pra faixa, então
 * fica isolado numa constante fácil de ajustar/expor nas configurações no
 * futuro, em vez de espalhado pelo código.
 */
export const ANNOUNCEMENT_LEAD_BARS = 1;

/** Distância mínima (em compassos) entre duas partes vindas da transcrição —
 *  evita que a MESMA locução, transcrita em dois segmentos bem próximos
 *  (ex.: "Re-" / "frão" cortado ao meio), vire duas partes separadas. */
const MIN_GAP_BARS = 2;

/** Confiança mínima: precisa de pelo menos esse nº de anúncios reconhecidos
 *  pra valer a pena montar partes pela voz em vez de cair no método
 *  heurístico — 1 anúncio isolado é fraco demais pra confiar (pode ser uma
 *  palavra qualquer transcrita errado por acaso). */
const MIN_CONFIDENT_MATCHES = 2;

export interface TranscriptSegmentLike {
  startMs: number;
  endMs: number;
  text: string;
}

/** Resample de um AudioBuffer (faixa guia já decodificada pelo Web Audio)
 *  pra 16kHz mono via OfflineAudioContext — não precisa de nenhuma lib de
 *  áudio adicional, o próprio navegador/webview já sabe reamostrar. */
export async function resampleTo16kMono(buffer: AudioBuffer): Promise<Float32Array> {
  if (buffer.sampleRate === WHISPER_SAMPLE_RATE && buffer.numberOfChannels === 1) {
    return buffer.getChannelData(0).slice();
  }
  const targetLength = Math.max(1, Math.ceil(buffer.duration * WHISPER_SAMPLE_RATE));
  const offlineCtx = new OfflineAudioContextCompat(1, targetLength, WHISPER_SAMPLE_RATE);
  const source = offlineCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(offlineCtx.destination);
  source.start();
  const rendered = await offlineCtx.startRendering();
  return rendered.getChannelData(0).slice();
}

/** Encoda um WAV PCM16 mono mínimo (cabeçalho de 44 bytes + dados) a partir
 *  de amostras float (-1..1) — formato simples o bastante pra escrever à mão,
 *  sem precisar de nenhuma dependência extra só pra isso. */
export function encodeWav16(samples: Float32Array, sampleRate = WHISPER_SAMPLE_RATE): Uint8Array {
  const bytesPerSample = 2;
  const byteRate = sampleRate * bytesPerSample;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // tamanho do bloco fmt (PCM)
  view.setUint16(20, 1, true); // formato = PCM linear
  view.setUint16(22, 1, true); // 1 canal (mono)
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 16, true); // bits por amostra
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

function normalizeAnnouncementText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Ordem importa: termos mais específicos ("pré-refrão") precisam ser
// checados ANTES dos termos mais genéricos que eles contêm como substring
// ("refrão"), senão "pré-refrão" nunca seria reconhecido como tal.
const ANNOUNCEMENT_DICTIONARY: Array<{ type: PartType; terms: string[] }> = [
  { type: 'Pré-refrão', terms: ['pre refrao', 'prerefrao', 'pre coro', 'precoro'] },
  { type: 'Refrão', terms: ['refrao', 'coro'] },
  { type: 'Verso', terms: ['verso', 'estrofe'] },
  { type: 'Intro', terms: ['introducao', 'intro'] },
  { type: 'Ponte', terms: ['ponte', 'bridge'] },
  { type: 'Interlúdio', terms: ['interludio'] },
  { type: 'Instrumental', terms: ['instrumental'] },
  { type: 'Solo', terms: ['solo'] },
  { type: 'Tag', terms: ['tag'] },
  { type: 'Final', terms: ['final', 'encerramento', 'fim'] },
];

/** Compara um trecho transcrito contra o dicionário de anúncios de parte.
 *  Retorna o TIPO reconhecido, ou null se o trecho não parece um anúncio
 *  de parte (ex.: um trecho de letra cantada que escapou pro WAV). */
export function matchAnnouncementToType(rawText: string): PartType | null {
  const text = normalizeAnnouncementText(rawText);
  if (!text) return null;
  for (const entry of ANNOUNCEMENT_DICTIONARY) {
    for (const term of entry.terms) {
      const pattern = new RegExp(`\\b${term.replace(/\s+/g, '\\s+')}\\b`);
      if (pattern.test(text)) return entry.type;
    }
  }
  return null;
}

/** Monta as partes da música a partir da transcrição da faixa guia, alinhando
 *  o fim de cada anúncio reconhecido à grade de compassos. Retorna `null`
 *  quando a transcrição não trouxe anúncios suficientes pra confiar (faixa
 *  sem locução, ou locução que o whisper não conseguiu entender) — o
 *  chamador deve cair pro método heurístico (`recognizeParts`) nesse caso. */
export function buildPartsFromTranscript(
  segments: TranscriptSegmentLike[],
  totalBars: number,
  bpm: number,
  timeSigNum: number
): SongPart[] | null {
  const secPerBar = (60 / bpm) * timeSigNum;
  if (!Number.isFinite(secPerBar) || secPerBar <= 0 || totalBars < 2) return null;

  type Candidate = { bar: number; type: PartType };
  const candidates: Candidate[] = [];
  for (const seg of segments) {
    const type = matchAnnouncementToType(seg.text);
    if (!type) continue;
    const barAtAnnouncementEnd = seg.endMs / 1000 / secPerBar; // posição em compassos (0-based)
    const bar = Math.min(totalBars, Math.max(1, Math.round(barAtAnnouncementEnd) + 1 + ANNOUNCEMENT_LEAD_BARS));
    candidates.push({ bar, type });
  }
  if (candidates.length < MIN_CONFIDENT_MATCHES) return null;

  candidates.sort((a, b) => a.bar - b.bar);
  const deduped: Candidate[] = [];
  for (const c of candidates) {
    const prev = deduped[deduped.length - 1];
    // mesma locução transcrita em pedaços próximos demais — ignora a repetição
    if (prev && c.bar - prev.bar < MIN_GAP_BARS) continue;
    deduped.push(c);
  }
  if (deduped.length < MIN_CONFIDENT_MATCHES) return null;

  const parts: SongPart[] = [];
  // se o primeiro anúncio reconhecido não fica logo no início da música,
  // sobra um trecho inicial sem locução — quase sempre uma introdução
  // instrumental, então entra como "Intro" em vez de ser descartado.
  if (deduped[0].bar > 1) {
    parts.push({
      id: newId(),
      name: 'Intro',
      type: 'Intro',
      startBar: 1,
      endBar: deduped[0].bar,
      color: PART_COLORS.Intro,
    });
  }
  deduped.forEach((c, i) => {
    const endBar = i < deduped.length - 1 ? deduped[i + 1].bar : totalBars + 1;
    if (endBar <= c.bar) return;
    parts.push({ id: newId(), name: c.type, type: c.type, startBar: c.bar, endBar, color: PART_COLORS[c.type] });
  });

  if (parts.length < MIN_CONFIDENT_MATCHES) return null;
  return mergeDuplicateNames(parts);
}

/**
 * Orquestra o pipeline inteiro: reamostra a faixa guia, encoda o WAV, manda
 * transcrever (via `window.api.speech.transcribeWav`, implementado só no
 * lado Tauri) e monta as partes a partir do texto reconhecido. `transcribe`
 * é injetado (em vez de chamar `window.api` direto aqui) pra esse módulo
 * continuar testável com dados sintéticos, sem precisar de um WebView de
 * verdade — ver scripts/test-part-recognition.mjs.
 */
export async function recognizePartsFromSpeech(
  buffer: AudioBuffer,
  bpm: number,
  timeSigNum: number,
  transcribe: (wavBytes: Uint8Array, language?: string) => Promise<TranscriptSegmentLike[]>
): Promise<SongPart[] | null> {
  const secPerBar = (60 / bpm) * timeSigNum;
  const totalBars = Math.max(1, Math.floor(buffer.duration / secPerBar));
  const samples = await resampleTo16kMono(buffer);
  const wav = encodeWav16(samples);
  const segments = await transcribe(wav, 'pt');
  return buildPartsFromTranscript(segments, totalBars, bpm, timeSigNum);
}
