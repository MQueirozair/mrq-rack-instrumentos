/**
 * Detecção de BPM e Tom por análise de áudio — usada como reforço/alternativa
 * quando o nome da pasta não traz essa informação (ver parseSongFolderName
 * em useStore.ts). Não depende de internet nem de bibliotecas pesadas: tudo
 * roda localmente, com um orçamento de processamento limitado (decimação /
 * downsampling antes de analisar) para não travar a interface com faixas
 * longas — a mesma lição aprendida com o cálculo das formas de onda.
 */

// ---------------------------------------------------------------------------
// BPM: envelope de onset + autocorrelação (técnica clássica e leve de beat
// tracking, usada por players DJ simples). Não é tão precisa quanto um
// algoritmo de produção (ex.: o que o Spotify usa), mas costuma acertar
// dentro de ±1 BPM (ou seu dobro/metade) para a maioria das músicas com
// batida definida, o que já é muito melhor que o valor fixo de 120 BPM.
// ---------------------------------------------------------------------------
export function detectBpm(buffer: AudioBuffer, minBpm = 70, maxBpm = 180): number | null {
  const data = buffer.getChannelData(0);
  const sr = buffer.sampleRate;

  // 1) downsample para ~5512 Hz (suficiente para seguir a envoltória rítmica, bem mais rápido de processar)
  const targetSr = 5512;
  const decim = Math.max(1, Math.round(sr / targetSr));
  const dsLen = Math.floor(data.length / decim);
  if (dsLen < targetSr * 4) return null; // música curta demais pra confiar
  const ds = new Float32Array(dsLen);
  for (let i = 0; i < dsLen; i++) ds[i] = Math.abs(data[i * decim]);
  const effSr = sr / decim;

  // 2) envelope de energia por frame (janela ~23ms) e derivada half-wave (realça ataques/onsets)
  const frame = Math.max(1, Math.round(effSr * 0.023));
  const numFrames = Math.floor(dsLen / frame);
  const envelope = new Float32Array(numFrames);
  for (let f = 0; f < numFrames; f++) {
    let sum = 0;
    const start = f * frame;
    const end = Math.min(dsLen, start + frame);
    for (let i = start; i < end; i++) sum += ds[i];
    envelope[f] = sum / Math.max(1, end - start);
  }
  const onset = new Float32Array(numFrames);
  for (let f = 1; f < numFrames; f++) onset[f] = Math.max(0, envelope[f] - envelope[f - 1]);
  const frameSr = effSr / frame;

  // 3) autocorrelação do onset na faixa de lag correspondente a minBpm..maxBpm
  const minLag = Math.floor((60 / maxBpm) * frameSr);
  const maxLag = Math.ceil((60 / minBpm) * frameSr);
  let bestLag = -1;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag && lag < numFrames; lag++) {
    let score = 0;
    for (let i = 0; i + lag < numFrames; i++) score += onset[i] * onset[i + lag];
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (bestLag <= 0) return null;

  let bpm = (60 * frameSr) / bestLag;
  // dobra/metade: prefere um valor dentro de uma faixa "musical" comum
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  return Math.round(bpm * 10) / 10;
}

// ---------------------------------------------------------------------------
// Tom: perfil de classes de altura (chroma) + correlação com os perfis de
// Krumhansl-Schmuckler (técnica clássica de detecção de tonalidade). Também
// roda sobre áudio decimado e em poucos quadros espaçados ao longo da
// música, para manter o custo baixo.
// ---------------------------------------------------------------------------
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Perfis de Krumhansl-Kessler (maior/menor), força relativa de cada grau da escala
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlate(a: number[], b: number[]): number {
  const meanA = a.reduce((s, v) => s + v, 0) / a.length;
  const meanB = b.reduce((s, v) => s + v, 0) / b.length;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den === 0 ? 0 : num / den;
}

/** DFT ingênua (não precisa de FFT: usamos poucos quadros e janela pequena, então o custo fica controlado). */
function magnitudeAt(frame: Float32Array, freq: number, sr: number): number {
  const n = frame.length;
  const w = (2 * Math.PI * freq) / sr;
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    re += frame[i] * Math.cos(w * i);
    im -= frame[i] * Math.sin(w * i);
  }
  return Math.sqrt(re * re + im * im);
}

export function detectKey(buffer: AudioBuffer): string | null {
  const data = buffer.getChannelData(0);
  const sr = buffer.sampleRate;

  // downsample pra ~11025Hz: ainda cobre bem as frequências das notas musicais usadas (até ~1.3kHz = oitava 6)
  const targetSr = 11025;
  const decim = Math.max(1, Math.round(sr / targetSr));
  const ds = new Float32Array(Math.floor(data.length / decim));
  for (let i = 0; i < ds.length; i++) ds[i] = data[i * decim];
  const effSr = sr / decim;
  if (ds.length < effSr * 4) return null;

  const chroma = new Array(12).fill(0);
  const winSize = Math.round(effSr * 0.4); // janelas de ~400ms
  const hop = winSize; // sem sobreposição, pra manter o custo baixo
  const maxFramesToAnalyze = 40; // analisa só até ~16s de material espalhado pela música
  const totalWindows = Math.floor((ds.length - winSize) / hop);
  const step = Math.max(1, Math.floor(totalWindows / maxFramesToAnalyze));

  // frequências das notas musicais em 3 oitavas centrais (cobre a maior parte do conteúdo tonal)
  const noteFreqs: { note: number; freq: number }[] = [];
  for (let octave = 2; octave <= 5; octave++) {
    for (let note = 0; note < 12; note++) {
      const midi = (octave + 1) * 12 + note;
      noteFreqs.push({ note, freq: 440 * Math.pow(2, (midi - 69) / 12) });
    }
  }

  let framesUsed = 0;
  for (let w = 0; w < totalWindows && framesUsed < maxFramesToAnalyze; w += step) {
    const start = w * hop;
    const frame = ds.subarray(start, start + winSize);
    for (const { note, freq } of noteFreqs) {
      chroma[note] += magnitudeAt(frame, freq, effSr);
    }
    framesUsed++;
  }
  if (framesUsed === 0) return null;

  let bestKey: string | null = null;
  let bestScore = -Infinity;
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotatedMajor = MAJOR_PROFILE.map((_, i) => chroma[(i + tonic) % 12]);
    const rotatedMinor = MINOR_PROFILE.map((_, i) => chroma[(i + tonic) % 12]);
    const scoreMajor = correlate(rotatedMajor, MAJOR_PROFILE);
    const scoreMinor = correlate(rotatedMinor, MINOR_PROFILE);
    if (scoreMajor > bestScore) {
      bestScore = scoreMajor;
      bestKey = NOTE_NAMES[tonic];
    }
    if (scoreMinor > bestScore) {
      bestScore = scoreMinor;
      bestKey = `${NOTE_NAMES[tonic]}m`;
    }
  }
  return bestKey;
}
