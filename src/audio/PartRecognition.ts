import type { PartType, SongPart } from '../../shared/types';
import { PART_COLORS } from '../../shared/types';
import { newId } from '../lib/id';

/**
 * Reconhecimento de partes (beta): heurística de similaridade/novidade sobre a
 * faixa guia, SEM transcrição real de letra. Agrupa compassos parecidos para
 * sugerir onde ficam intro/verso/refrão/ponte. O usuário deve conferir e
 * ajustar — é um ponto de partida, não uma marcação definitiva.
 *
 * Pipeline (técnica clássica de MIR — Foote 2000 "novelty-based segmentation",
 * a mesma base usada por ferramentas como MSAF), com um reforço específico
 * pra multitrack: como a entrada é sempre a FAIXA GUIA (voz-guia cantada,
 * nunca o mix completo — ver `setPartsFromRecognition` em useStore.ts), dá
 * pra usar o próprio silêncio da voz-guia como sinal de estrutura, que é
 * muito mais confiável do que comparar energia/timbre de um mix cheio:
 *
 *   1. extrai um vetor de features (energia RMS + taxa de cruzamento por zero)
 *      por sub-janela de cada compasso, guardando também a energia RMS BRUTA
 *      (não normalizada) de cada compasso, pra saber o volume de verdade;
 *   2. classifica cada compasso como "cantado" ou "instrumental" comparando
 *      essa energia bruta com um limiar adaptativo (percentil 10/90 da
 *      própria música) — a voz-guia fica em silêncio nos trechos
 *      instrumentais (intro, interlúdio, ponte instrumental, solo), e esse
 *      silêncio é um corte de seção muito mais confiável do que qualquer
 *      heurística de timbre;
 *   3. monta a matriz de autossimilaridade (cosseno) entre todos os compassos
 *      usando o vetor normalizado (foca na forma da dinâmica, não no volume);
 *   4. corre um kernel "tabuleiro de xadrez" com decaimento gaussiano pela
 *      diagonal pra obter a curva de novidade (pico = provável troca de parte);
 *   5. suaviza a curva e escolhe os picos mais fortes com espaçamento mínimo
 *      e limiar adaptativo (média + desvio-padrão, ajustável por
 *      `sensitivity`) — e ACRESCENTA as transições cantado⇄instrumental como
 *      fronteiras extras, mesmo que a curva de novidade não tenha pego;
 *   6. "repara" segmentos curtos demais (ruído/preenchimento de bateria etc.)
 *      fundindo-os no vizinho mais parecido, em vez de virarem uma parte nova;
 *   7. rotula cada segmento: primeiro separa instrumental (Intro/Interlúdio/
 *      Solo, pela energia bruta — um instrumental "grande" é Solo, não só uma
 *      ponte silenciosa) de cantado (Verso/Pré-refrão/Refrão/Ponte, pelo
 *      agrupamento por similaridade + posição + duração).
 *
 * Esse pipeline substitui a versão anterior (limiar fixo `> 0.02`, sem
 * suavização, sem reparo de segmentos curtos, sem usar o silêncio da
 * voz-guia), que gerava partes demais em músicas com variação de dinâmica
 * dentro da mesma seção, e também corrigia uma regressão em que o
 * agrupamento por similaridade colapsava tudo num grupo só e toda parte
 * virava "Refrão".
 */

export type RecognitionSensitivity = 'poucas' | 'normal' | 'muitas';

export interface RecognizeOptions {
  /** Distância mínima (em compassos) entre duas partes sugeridas. */
  minBoundaryBars?: number;
  /**
   * Controla quão exigente é o limiar de novidade pra aceitar uma fronteira:
   * 'poucas' = só trocas bem óbvias (menos partes, menos revisão manual);
   * 'normal' = equilíbrio (padrão);
   * 'muitas' = pega até trocas sutis (mais partes, mais trabalho de revisão).
   */
  sensitivity?: RecognitionSensitivity;
}

const SENSITIVITY_FACTOR: Record<RecognitionSensitivity, number> = {
  poucas: 2.0,
  normal: 1.4,
  muitas: 0.7,
};

/** Fração mínima de compassos "cantados" dentro de um segmento pra ele contar
 *  como uma parte vocal (Verso/Pré-refrão/Refrão/Ponte) em vez de instrumental
 *  (Intro/Interlúdio/Solo). */
const VOCAL_RATIO_THRESHOLD = 0.35;

export interface BarFeatures {
  /** vetor normalizado (energia RMS + cruzamento por zero por sub-janela) — usado pra similaridade/forma. */
  shape: number[];
  /** energia RMS bruta do compasso inteiro (0..1, não normalizada) — usado pra volume/silêncio de verdade. */
  rawEnergy: number;
}

/** Extrai as features por compasso a partir do AudioBuffer (impuro — só essa função toca em Web Audio). */
function extractBarFeatures(buffer: AudioBuffer, bpm: number, timeSigNum: number): { bars: BarFeatures[]; totalBars: number } {
  const secPerBar = (60 / bpm) * timeSigNum;
  const totalBars = Math.max(1, Math.floor(buffer.duration / secPerBar));
  const data = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const subdivisions = 8;
  const bars: BarFeatures[] = [];

  for (let bar = 0; bar < totalBars; bar++) {
    const barStart = Math.floor(bar * secPerBar * sr);
    const barEnd = Math.floor((bar + 1) * secPerBar * sr);
    const subLen = Math.floor((barEnd - barStart) / subdivisions);
    const vec: number[] = [];
    let barSumSq = 0;
    let barSamples = 0;
    for (let s = 0; s < subdivisions; s++) {
      const start = barStart + s * subLen;
      const end = Math.min(data.length, start + subLen);
      let sumSq = 0;
      let zc = 0;
      let prev = 0;
      for (let i = start; i < end; i++) {
        const v = data[i];
        sumSq += v * v;
        if (i > start && (v >= 0) !== (prev >= 0)) zc++;
        prev = v;
      }
      const n = Math.max(1, end - start);
      vec.push(Math.sqrt(sumSq / n), zc / n);
      barSumSq += sumSq;
      barSamples += n;
    }
    bars.push({ shape: normalize(vec), rawEnergy: Math.sqrt(barSumSq / Math.max(1, barSamples)) });
  }

  return { bars, totalBars };
}

export function recognizeParts(
  buffer: AudioBuffer,
  bpm: number,
  timeSigNum: number,
  options: RecognizeOptions = {}
): SongPart[] {
  const minBoundaryBars = Math.max(2, Math.round(options.minBoundaryBars ?? 8));
  const sensitivity = options.sensitivity ?? 'normal';
  const { bars, totalBars } = extractBarFeatures(buffer, bpm, timeSigNum);
  if (totalBars < minBoundaryBars * 2) return [];
  return recognizePartsFromBars(bars, totalBars, minBoundaryBars, sensitivity);
}

/**
 * Núcleo puro do algoritmo (sem AudioBuffer) — recebe as features já
 * extraídas por compasso. Separado de `recognizeParts` pra poder ser testado
 * com dados sintéticos, sem precisar decodificar áudio de verdade.
 */
export function recognizePartsFromBars(
  bars: BarFeatures[],
  totalBars: number,
  minBoundaryBars: number,
  sensitivity: RecognitionSensitivity
): SongPart[] {
  const n = bars.length;
  const features = bars.map((b) => b.shape);
  const rawEnergy = bars.map((b) => b.rawEnergy);

  // matriz de similaridade (cosseno) entre compassos, pela FORMA da dinâmica
  const sim: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const s = cosine(features[i], features[j]);
      sim[i][j] = s;
      sim[j][i] = s;
    }
  }

  const novelty = computeNoveltyCurve(sim, n, minBoundaryBars);
  const smoothed = smoothCurve(novelty, 1);
  const noveltyBoundaries = pickBoundaries(smoothed, n, minBoundaryBars, sensitivity, totalBars);

  // Sinal independente: silêncio x voz ativa na própria faixa guia. Como a
  // entrada é sempre a voz-guia (nunca o mix cheio), um compasso "mudo" quase
  // sempre significa uma seção instrumental (intro/interlúdio/ponte/solo) —
  // um corte de seção muito mais confiável do que comparar timbre/energia.
  const vocalActive = computeVocalActivity(rawEnergy);
  const silenceBoundaries = silenceGapBoundaries(vocalActive, minBoundaryBars);

  const boundaries = mergeBoundaries(noveltyBoundaries, silenceBoundaries, minBoundaryBars, n);

  let segments = boundaries.slice(0, -1).map((start, i) => {
    const end = boundaries[i + 1];
    const avgFeature = averageVectors(features.slice(start, end));
    const segVocal = vocalActive.slice(start, end);
    const vocalRatio = segVocal.length > 0 ? segVocal.filter(Boolean).length / segVocal.length : 0;
    const avgRawEnergy = average(rawEnergy.slice(start, end));
    return { startBar: start + 1, endBar: end + 1, feature: avgFeature, vocalRatio, avgRawEnergy };
  });

  // Repara segmentos curtos demais (ruído, fill, respiro) fundindo no vizinho
  // mais parecido — evita que cada pequena variação vire uma "parte" nova.
  const hardMinBars = Math.max(2, Math.min(minBoundaryBars, 4));
  segments = repairShortSegments(segments, hardMinBars);

  return labelSegments(segments);
}

/**
 * Classifica cada compasso como "voz ativa" (true) ou "instrumental/silêncio"
 * (false), usando um limiar adaptativo baseado nos percentis 10/90 da energia
 * bruta da própria música (técnica usada por ferramentas de segmentação de
 * estrutura musical, ex. detecção de intro/outro por cruzamento do ponto
 * médio entre os percentis 10 e 90 da curva de energia). Um filtro de maioria
 * numa janela pequena evita que uma respiração entre frases vire uma "troca
 * de parte" sozinha.
 */
function computeVocalActivity(rawEnergy: number[]): boolean[] {
  if (rawEnergy.length === 0) return [];
  const sorted = [...rawEnergy].sort((a, b) => a - b);
  const p10 = percentile(sorted, 0.1);
  const p90 = percentile(sorted, 0.9);

  // Se a faixa guia quase não varia de volume (gravação muito comprimida,
  // ou simplesmente uma música sem trechos realmente instrumentais), o
  // contraste entre "cantando" e "silêncio" não existe de verdade — tentar
  // separar os dois nesse caso é só ruído de ponto flutuante decidindo, e dá
  // pra acabar classificando a música INTEIRA como instrumental por engano
  // (pior erro possível aqui: silenciar completamente a detecção de Refrão/
  // Verso). Mais seguro assumir "sempre cantando" do que arriscar isso.
  const spread = p90 - p10;
  if (p90 <= 1e-6 || spread < p90 * 0.08) {
    return rawEnergy.map(() => true);
  }

  // mais perto do piso de ruído do que do pico — a voz-guia costuma ficar
  // próxima de zero (não só "mais baixa") nos trechos instrumentais.
  const threshold = p10 + 0.25 * spread;
  const raw = rawEnergy.map((e) => e >= threshold);

  // suaviza por maioria numa janela de 1 compasso pra cada lado
  const window = 1;
  return raw.map((_, i) => {
    let votes = 0;
    let total = 0;
    for (let k = -window; k <= window; k++) {
      const idx = i + k;
      if (idx < 0 || idx >= raw.length) continue;
      votes += raw[idx] ? 1 : 0;
      total++;
    }
    return votes / total >= 0.5;
  });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

/** Acha os pontos onde a voz-guia muda de "cantando" pra "instrumental" (ou
 *  vice-versa) e que duram pelo menos uma seção inteira de cada lado — essas
 *  transições são fronteiras de parte muito prováveis. */
function silenceGapBoundaries(vocalActive: boolean[], minBoundaryBars: number): number[] {
  const n = vocalActive.length;
  if (n === 0) return [];
  const minRun = Math.max(2, Math.floor(minBoundaryBars / 2));
  const boundaries: number[] = [];
  let runStart = 0;
  for (let i = 1; i <= n; i++) {
    if (i === n || vocalActive[i] !== vocalActive[runStart]) {
      const runLen = i - runStart;
      if (runStart > 0 && runLen >= minRun) boundaries.push(runStart);
      runStart = i;
    }
  }
  return boundaries;
}

/** Combina as fronteiras da curva de novidade com as do silêncio da
 *  voz-guia, removendo duplicatas próximas demais (< minBoundaryBars). */
function mergeBoundaries(novelty: number[], silence: number[], minBoundaryBars: number, n: number): number[] {
  const interior = novelty.slice(1, -1);
  const all = [...interior];
  for (const b of silence) {
    if (!all.some((x) => Math.abs(x - b) < minBoundaryBars)) all.push(b);
  }
  all.sort((a, b) => a - b);
  // remove duplicatas residuais mantendo espaçamento mínimo
  const deduped: number[] = [];
  for (const b of all) {
    if (deduped.length === 0 || b - deduped[deduped.length - 1] >= minBoundaryBars) deduped.push(b);
  }
  return [0, ...deduped, n];
}

export interface LabelableSegment {
  startBar: number;
  endBar: number;
  feature: number[];
  vocalRatio: number;
  avgRawEnergy: number;
}

export function labelSegments(segments: LabelableSegment[]): SongPart[] {
  const isVocal = segments.map((s) => s.vocalRatio >= VOCAL_RATIO_THRESHOLD);

  // agrupa segmentos CANTADOS parecidos (repetições) por similaridade média
  // do vetor de forma. Limiar alto de propósito: a feature usada aqui
  // (energia + cruzamento por zero, normalizada por compasso) já perde a
  // diferença de volume absoluto entre verso/refrão, então um limiar frouxo
  // colapsa a música inteira num grupo só — e TODO SEGMENTO acaba rotulado
  // "Refrão" (bug real, visto em áudio de verdade: uma música virou 6
  // partes, todas chamadas "Refrão").
  const groupOf: number[] = new Array(segments.length).fill(-1);
  let nextGroup = 0;
  for (let i = 0; i < segments.length; i++) {
    if (!isVocal[i] || groupOf[i] !== -1) continue;
    groupOf[i] = nextGroup;
    for (let j = i + 1; j < segments.length; j++) {
      if (!isVocal[j] || groupOf[j] !== -1) continue;
      if (cosine(segments[i].feature, segments[j].feature) > 0.93) groupOf[j] = nextGroup;
    }
    nextGroup++;
  }

  const groupCounts = new Map<number, number>();
  groupOf.forEach((g) => {
    if (g !== -1) groupCounts.set(g, (groupCounts.get(g) ?? 0) + 1);
  });
  const repeatedGroups = [...groupCounts.entries()].filter(([, c]) => c >= 2).map(([g]) => g);
  // usa a energia BRUTA (volume de verdade) pra decidir qual grupo repetido é
  // o refrão — o vetor de forma é normalizado por compasso e não serve pra
  // comparar volume absoluto entre grupos diferentes.
  const energyByGroup = new Map<number, number>();
  segments.forEach((s, i) => {
    const g = groupOf[i];
    if (g === -1) return;
    energyByGroup.set(g, Math.max(energyByGroup.get(g) ?? 0, s.avgRawEnergy));
  });
  const chorusGroup = repeatedGroups.length
    ? repeatedGroups.sort((a, b) => (energyByGroup.get(b)! - energyByGroup.get(a)!))[0]
    : undefined;

  // Rede de segurança: só confia no rótulo Verso/Refrão vindo do agrupamento
  // quando ele realmente encontrou diversidade (2+ grupos que se repetem, OU
  // 1 grupo que se repete mas não cobre todos os segmentos cantados). Se um
  // único grupo "engoliu" tudo, isso não é "a música inteira é refrão" — é
  // sinal de que essa heurística simples não conseguiu diferenciar as partes
  // dessa música, e é mais honesto cair num rótulo neutro (alternando
  // Verso/Instrumental por posição) do que repetir o mesmo rótulo errado em
  // todas elas.
  const vocalCount = isVocal.filter(Boolean).length;
  const totalInRepeatedGroups = repeatedGroups.reduce((sum, g) => sum + (groupCounts.get(g) ?? 0), 0);
  const hasMeaningfulGrouping =
    vocalCount > 0 && (repeatedGroups.length >= 2 || (repeatedGroups.length === 1 && totalInRepeatedGroups < vocalCount));

  // duração "típica" de uma parte cantada — usada pra reconhecer pré-refrão
  // (sensivelmente mais curto que o normal) sem precisar de um limiar fixo em
  // compassos, que varia demais entre estilos/andamentos.
  const vocalLengths = segments.filter((_, i) => isVocal[i]).map((s) => s.endBar - s.startBar);
  const medianVocalLen = median(vocalLengths);

  // energia instrumental média — usada pra separar um Solo (trecho
  // instrumental "grande", tocado em destaque) de um Interlúdio comum (passagem
  // mais discreta entre partes cantadas).
  const instrumentalEnergies = segments.filter((_, i) => !isVocal[i]).map((s) => s.avgRawEnergy);
  const avgInstrumentalEnergy = average(instrumentalEnergies);

  const parts: SongPart[] = segments.map((seg, i) => {
    const bars = seg.endBar - seg.startBar;
    let type: PartType;

    if (!isVocal[i]) {
      // --- segmento instrumental (voz-guia em silêncio) ---
      if (i === 0) type = 'Intro';
      else if (i === segments.length - 1) type = 'Final';
      else if (avgInstrumentalEnergy > 0 && seg.avgRawEnergy > avgInstrumentalEnergy * 1.3) type = 'Solo';
      else type = 'Interlúdio';
    } else {
      // --- segmento cantado ---
      const g = groupOf[i];
      const nextIsChorus = i < segments.length - 1 && isVocal[i + 1] && groupOf[i + 1] === chorusGroup;
      if (i === segments.length - 1) type = 'Final';
      else if (!hasMeaningfulGrouping) type = i % 2 === 0 ? 'Verso' : 'Ponte';
      else if (g === chorusGroup) type = 'Refrão';
      else if (medianVocalLen > 0 && bars <= medianVocalLen * 0.6 && nextIsChorus) type = 'Pré-refrão';
      else if (repeatedGroups.includes(g)) type = 'Verso';
      else if (i > segments.length / 2) type = 'Ponte';
      else type = 'Verso';
    }

    return {
      id: newId(),
      name: type,
      type,
      startBar: seg.startBar,
      endBar: seg.endBar,
      color: PART_COLORS[type],
    };
  });

  return mergeDuplicateNames(parts);
}

/**
 * Curva de novidade via kernel "tabuleiro de xadrez" com decaimento gaussiano
 * (Foote, 2000): mede, pra cada compasso, o quanto o lado esquerdo e o lado
 * direito de uma janela ao redor dele são parecidos entre si e diferentes um
 * do outro — picos indicam a "costura" entre duas seções distintas.
 */
function computeNoveltyCurve(sim: number[][], n: number, minBoundaryBars: number): number[] {
  // Uma janela pequena demais confunde troca de parte real com variação de
  // curto prazo (fill de bateria, respiro, ad-lib) — usar uma janela do
  // tamanho da própria distância mínima entre partes faz o kernel "enxergar"
  // através desse ruído de curto prazo e só reagir a mudanças que realmente
  // duram uma seção inteira.
  const L = Math.max(4, Math.min(24, minBoundaryBars));
  const sigma = Math.max(1, L / 2);
  const kernel: number[][] = Array.from({ length: 2 * L + 1 }, () => new Array(2 * L + 1).fill(0));
  let kernelWeight = 0;
  for (let a = -L; a <= L; a++) {
    for (let b = -L; b <= L; b++) {
      const taper = Math.exp(-(a * a + b * b) / (2 * sigma * sigma));
      const sign = Math.sign(a) * Math.sign(b);
      const value = sign * taper;
      kernel[a + L][b + L] = value;
      kernelWeight += Math.abs(value);
    }
  }
  if (kernelWeight === 0) kernelWeight = 1;

  const novelty = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let score = 0;
    for (let a = -L; a <= L; a++) {
      const x = i + a;
      if (x < 0 || x >= n) continue;
      const row = kernel[a + L];
      for (let b = -L; b <= L; b++) {
        const y = i + b;
        if (y < 0 || y >= n) continue;
        score += row[b + L] * sim[x][y];
      }
    }
    novelty[i] = score / kernelWeight;
  }

  // O kernel fica truncado perto das bordas (soma parcial, sem o "outro lado"
  // da janela) e isso cria picos artificiais enormes bem no início/fim — não
  // são trocas de parte reais, são o efeito de borda do próprio filtro. Zera
  // essa faixa antes de normalizar, senão ela domina a escala e esconde as
  // trocas de verdade (é a mesma correção usada por implementações de
  // referência do método de Foote, ex. MSAF).
  for (let i = 0; i < Math.min(L, n); i++) novelty[i] = 0;
  for (let i = Math.max(0, n - L); i < n; i++) novelty[i] = 0;

  // normaliza pra [0, 1] — deixa o limiar adaptativo comparável entre músicas
  const min = Math.min(...novelty);
  const max = Math.max(...novelty);
  const range = max - min || 1;
  return novelty.map((v) => (v - min) / range);
}

/** Média móvel simples — achata picos de 1 compasso só (ruído/fill isolado). */
function smoothCurve(curve: number[], window: number): number[] {
  const n = curve.length;
  return curve.map((_, i) => {
    let sum = 0;
    let count = 0;
    for (let k = -window; k <= window; k++) {
      const idx = i + k;
      if (idx < 0 || idx >= n) continue;
      sum += curve[idx];
      count++;
    }
    return sum / count;
  });
}

/**
 * Escolhe as fronteiras finais: limiar adaptativo (média + desvio-padrão da
 * própria curva, ajustado por `sensitivity`), seleção gulosa pelos picos mais
 * fortes primeiro respeitando distância mínima, e um teto de partes
 * proporcional ao tamanho da música pra evitar fragmentação exagerada.
 */
function pickBoundaries(
  curve: number[],
  n: number,
  minBoundaryBars: number,
  sensitivity: RecognitionSensitivity,
  totalBars: number
): number[] {
  const mean = curve.reduce((a, b) => a + b, 0) / curve.length;
  const variance = curve.reduce((a, b) => a + (b - mean) ** 2, 0) / curve.length;
  const std = Math.sqrt(variance);
  const threshold = mean + SENSITIVITY_FACTOR[sensitivity] * std;

  const candidates: { index: number; value: number }[] = [];
  for (let i = 1; i < n - 1; i++) {
    const isPeak = curve[i] >= curve[i - 1] && curve[i] >= curve[i + 1] && (curve[i] > curve[i - 1] || curve[i] > curve[i + 1]);
    if (isPeak && curve[i] >= threshold) candidates.push({ index: i, value: curve[i] });
  }
  candidates.sort((a, b) => b.value - a.value);

  const maxInternalBoundaries = Math.max(2, Math.min(23, Math.round(totalBars / (minBoundaryBars * 2.5))));
  const accepted: number[] = [];
  for (const c of candidates) {
    if (accepted.length >= maxInternalBoundaries) break;
    if (accepted.some((b) => Math.abs(b - c.index) < minBoundaryBars)) continue;
    accepted.push(c.index);
  }
  accepted.sort((a, b) => a - b);

  return [0, ...accepted, n];
}

/**
 * Funde no vizinho mais parecido qualquer segmento mais curto que
 * `hardMinBars` — ruído/variação pontual não vira parte nova sozinha.
 */
function repairShortSegments<T extends { startBar: number; endBar: number; feature: number[] }>(
  segments: T[],
  hardMinBars: number
): T[] {
  let list = [...segments];
  let changed = true;
  while (changed && list.length > 1) {
    changed = false;
    for (let i = 0; i < list.length; i++) {
      const bars = list[i].endBar - list[i].startBar;
      if (bars >= hardMinBars) continue;
      const prev = i > 0 ? list[i - 1] : null;
      const next = i < list.length - 1 ? list[i + 1] : null;
      const simPrev = prev ? cosine(list[i].feature, prev.feature) : -Infinity;
      const simNext = next ? cosine(list[i].feature, next.feature) : -Infinity;
      const mergeWithPrev = simPrev >= simNext;
      const target = mergeWithPrev ? prev : next;
      if (!target) continue;
      const mergedStart = mergeWithPrev ? target.startBar : list[i].startBar;
      const mergedEnd = mergeWithPrev ? list[i].endBar : target.endBar;
      const mergedBars = mergedEnd - mergedStart;
      const wA = (target.endBar - target.startBar) / mergedBars;
      const wB = (list[i].endBar - list[i].startBar) / mergedBars;
      const mergedFeature = target.feature.map((v, idx) => v * wA + list[i].feature[idx] * wB);
      const merged: T = {
        ...target,
        startBar: mergedStart,
        endBar: mergedEnd,
        feature: mergedFeature,
      } as T;
      // média ponderada dos demais campos numéricos conhecidos (vocalRatio, avgRawEnergy)
      for (const key of ['vocalRatio', 'avgRawEnergy'] as const) {
        const a = (target as unknown as Record<string, number>)[key];
        const b = (list[i] as unknown as Record<string, number>)[key];
        if (typeof a === 'number' && typeof b === 'number') {
          (merged as unknown as Record<string, number>)[key] = a * wA + b * wB;
        }
      }
      const targetIndex = mergeWithPrev ? i - 1 : i + 1;
      const next_list = [...list];
      next_list.splice(Math.min(i, targetIndex), 2, merged);
      list = next_list;
      changed = true;
      break;
    }
  }
  return list;
}

/** Numera repetições do mesmo tipo a partir da 2ª ocorrência (a 1ª fica com o
 *  nome limpo, ex. "Refrão", "Refrão 2", "Refrão 3"...), pra cada botão/pílula
 *  ser identificável sem ambiguidade. */
/** Numera ocorrências repetidas do mesmo tipo ("Verso 1", "Verso 2", ...) —
 *  exportada pra ser reaproveitada por `SpeechPartRecognition.ts`, que monta
 *  partes a partir da transcrição de voz em vez da heurística por áudio. */
export function mergeDuplicateNames(parts: SongPart[]): SongPart[] {
  const totalByType = new Map<string, number>();
  parts.forEach((p) => totalByType.set(p.type, (totalByType.get(p.type) ?? 0) + 1));
  const seenSoFar = new Map<string, number>();
  return parts.map((p) => {
    const occurrence = (seenSoFar.get(p.type) ?? 0) + 1;
    seenSoFar.set(p.type, occurrence);
    const total = totalByType.get(p.type) ?? 1;
    const name = total > 1 ? (occurrence === 1 ? p.type : `${p.type} ${occurrence}`) : p.type;
    return { ...p, name };
  });
}

function normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1;
  return vec.map((v) => v / norm);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

function averageVectors(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const out = new Array(vectors[0].length).fill(0);
  for (const v of vectors) for (let i = 0; i < v.length; i++) out[i] += v[i];
  return out.map((v) => v / vectors.length);
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
