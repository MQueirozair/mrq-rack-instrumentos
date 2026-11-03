/**
 * Reduz um AudioBuffer a uma lista de picos (0..1) para desenho rápido da
 * forma de onda.
 *
 * Importante: em vez de varrer TODA a amostra de áudio (o que, para uma
 * faixa de alguns minutos a 48kHz, significa dezenas de milhões de leituras
 * — e multiplicado por 18-20 faixas simultâneas trava a interface por vários
 * segundos), limitamos quantas amostras são examinadas dentro de cada
 * "balde" (bucket) via um passo (stride). Isso deixa o custo fixo
 * (buckets × maxSamplesPerBucket) independente da duração do arquivo,
 * mantendo o desenho fiel o suficiente para uma visão geral da onda.
 */
export function computePeaks(buffer: AudioBuffer, buckets: number, maxSamplesPerBucket = 48): number[] {
  const channelData = buffer.getChannelData(0);
  const total = channelData.length;
  const samplesPerBucket = Math.max(1, Math.floor(total / buckets));
  const stride = Math.max(1, Math.floor(samplesPerBucket / maxSamplesPerBucket));
  const peaks: number[] = new Array(buckets).fill(0);
  for (let b = 0; b < buckets; b++) {
    const start = b * samplesPerBucket;
    const end = Math.min(total, start + samplesPerBucket);
    let max = 0;
    for (let i = start; i < end; i += stride) {
      const v = Math.abs(channelData[i]);
      if (v > max) max = v;
    }
    peaks[b] = max;
  }
  return peaks;
}

/** Combina os picos de várias faixas num único contorno (o máximo de cada balde entre todas), para uma visão "master"/mixada. */
export function combinePeaks(perTrack: number[][], buckets: number): number[] {
  const out = new Array(buckets).fill(0);
  for (const peaks of perTrack) {
    for (let i = 0; i < buckets && i < peaks.length; i++) {
      if (peaks[i] > out[i]) out[i] = peaks[i];
    }
  }
  return out;
}

export async function decodeForAnalysis(ctx: BaseAudioContext, url: string): Promise<AudioBuffer> {
  const res = await fetch(url);
  const arrayBuffer = await res.arrayBuffer();
  return ctx.decodeAudioData(arrayBuffer);
}

/** Cede o controle de volta ao navegador por um instante (evita travar a UI em laços longos). */
export function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
