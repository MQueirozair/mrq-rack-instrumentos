// Detecção de acorde em tempo real a partir de um conjunto de notas MIDI
// atualmente soando (ver ChordIndicator.tsx, que chama isto a cada frame com
// o retorno de rackEngine.getActiveNotesSnapshot()).
//
// Nomenclatura: segue o padrão de CIFRA usado no Brasil (ex.: sétima maior =
// "7M", não "maj7"; meio-diminuto = "m7(b5)"; tensões sempre entre
// parênteses, ex.: "C7(9)"), já que o MRQ é feito pra banda/culto brasileiro.
//
// Algoritmo: casamento de "pitch-class set" contra uma tabela de fórmulas de
// acorde conhecidas (intervalos em semitons a partir da fundamental), testando
// cada nota tocada como possível fundamental. Preferimos, em ordem:
//   1) um casamento EXATO (usa todas as notas tocadas, nenhuma sobra) com a
//      fundamental igual ao baixo (nota mais grave) tocado — é o jeito mais
//      "natural" de ler um acorde em posição fundamental;
//   2) um casamento exato com qualquer outra fundamental (acorde invertido —
//      aí mostramos "Acorde/Baixo", ex.: "C/E");
//   3) se nada bate exatamente, a fórmula conhecida mais próxima que seja um
//      SUBCONJUNTO das notas tocadas, mostrando a(s) nota(s) extra como tensão
//      entre parênteses (ex.: "C7(9)");
//   4) se nem isso, mostra as notas tocadas cruas (ex.: "Dó • Mi • Láb").

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function pcName(pc: number): string {
  return NOTE_NAMES[((pc % 12) + 12) % 12];
}

export function midiNoteName(note: number): string {
  return `${pcName(note)}${Math.floor(note / 12) - 1}`;
}

/** Fórmula de acorde: intervalos em semitons a partir da fundamental (sempre contém 0). */
interface ChordTemplate {
  /** sufixo mostrado depois do nome da fundamental, ex.: "", "m", "7", "7M" */
  suffix: string;
  intervals: number[];
}

// Ordenado por "especificidade" (cardinalidade maior primeiro, dentro de cada
// grupo) e depois por frequência de uso em música popular/worship — usado
// como critério de desempate quando mais de uma fórmula bate igualmente bem.
const TEMPLATES: ChordTemplate[] = [
  // --- pentades (5-6 notas): 11ª, 13ª e extensões com alteração ---
  { suffix: '13', intervals: [0, 2, 4, 7, 9, 10] },
  { suffix: 'm11', intervals: [0, 2, 3, 5, 7, 10] },
  { suffix: '9(#11)', intervals: [0, 2, 4, 6, 7, 10] },
  { suffix: '9M', intervals: [0, 2, 4, 7, 11] },
  { suffix: 'm9', intervals: [0, 2, 3, 7, 10] },
  { suffix: '9', intervals: [0, 2, 4, 7, 10] },
  { suffix: '6/9', intervals: [0, 2, 4, 7, 9] },
  { suffix: '9sus4', intervals: [0, 2, 5, 7, 10] },
  { suffix: '7M(#11)', intervals: [0, 4, 6, 7, 11] },
  { suffix: '7(#11)', intervals: [0, 4, 6, 7, 10] },
  { suffix: '7(b9)', intervals: [0, 1, 4, 7, 10] },
  { suffix: '7(#9)', intervals: [0, 3, 4, 7, 10] },
  // --- tétrades ---
  { suffix: '7', intervals: [0, 4, 7, 10] },
  { suffix: '7M', intervals: [0, 4, 7, 11] },
  { suffix: 'm7', intervals: [0, 3, 7, 10] },
  { suffix: 'm(7M)', intervals: [0, 3, 7, 11] },
  { suffix: 'm7(b5)', intervals: [0, 3, 6, 10] },
  { suffix: 'dim7', intervals: [0, 3, 6, 9] },
  { suffix: '7(#5)', intervals: [0, 4, 8, 10] },
  { suffix: '7(b5)', intervals: [0, 4, 6, 10] },
  { suffix: '6', intervals: [0, 4, 7, 9] },
  { suffix: 'm6', intervals: [0, 3, 7, 9] },
  { suffix: '7sus4', intervals: [0, 5, 7, 10] },
  { suffix: 'add9', intervals: [0, 2, 4, 7] },
  { suffix: 'madd9', intervals: [0, 2, 3, 7] },
  // --- tríades ---
  { suffix: '', intervals: [0, 4, 7] }, // maior
  { suffix: 'm', intervals: [0, 3, 7] }, // menor
  { suffix: 'dim', intervals: [0, 3, 6] },
  { suffix: 'aum', intervals: [0, 4, 8] },
  { suffix: 'sus2', intervals: [0, 2, 7] },
  { suffix: 'sus4', intervals: [0, 5, 7] },
];

// Tensões mostradas entre parênteses quando não há casamento exato (ex.:
// "C7(9)" = C7 com uma 9ª a mais tocada por cima). Números de cifra
// brasileira padrão (9/11/13 e suas alterações).
const TENSION_NAMES: Record<number, string> = {
  1: 'b9', 2: '9', 3: '#9', 5: '11', 6: '#11', 8: 'b13', 9: '13',
};

function intervalSetKey(intervals: number[]): string {
  return [...intervals].sort((a, b) => a - b).join(',');
}

// Map por chave de intervalos (pitch-class-set relativo à fundamental) — cada
// fórmula de TEMPLATES deve ser única; ver teste manual em chordDetect caso
// uma nova fórmula seja adicionada no futuro e colida com outra existente.
const TEMPLATE_BY_KEY = new Map<string, ChordTemplate>();
for (const t of TEMPLATES) TEMPLATE_BY_KEY.set(intervalSetKey(t.intervals), t);

export interface DetectedChord {
  /** Texto pronto pra exibir, ex.: "Cm7", "G/B", "D7(9)", "Mi • Sol". */
  label: string;
  /** Nome curto da fundamental detectada (sem baixo/tensão), ou null se não deu pra identificar. */
  root: string | null;
}

/**
 * `notes` são números MIDI (0-127) de todas as notas soando agora, de
 * qualquer oitava/canal/camada — duplicatas e ordem não importam.
 */
export function detectChord(notes: number[]): DetectedChord | null {
  if (notes.length === 0) return null;

  const uniqueNotes = Array.from(new Set(notes)).sort((a, b) => a - b);
  const bassNote = uniqueNotes[0];
  const bassPc = ((bassNote % 12) + 12) % 12;
  const pcSet = Array.from(new Set(uniqueNotes.map((n) => ((n % 12) + 12) % 12))).sort((a, b) => a - b);

  if (pcSet.length === 1) {
    return { label: pcName(pcSet[0]), root: pcName(pcSet[0]) };
  }

  if (pcSet.length === 2) {
    const [a, b] = pcSet;
    const up = (b - a + 12) % 12;
    const down = (a - b + 12) % 12;
    if (up === 7) return { label: `${pcName(a)}5`, root: pcName(a) };
    if (down === 7) return { label: `${pcName(b)}5`, root: pcName(b) };
    return { label: `${pcName(a)} • ${pcName(b)}`, root: null };
  }

  // --- 3+ notas distintas: tenta casamento exato em cada fundamental candidata ---
  type Candidate = { root: number; template: ChordTemplate; isBass: boolean };
  const exactMatches: Candidate[] = [];
  for (const root of pcSet) {
    const relative = intervalSetKey(pcSet.map((pc) => (pc - root + 12) % 12));
    const template = TEMPLATE_BY_KEY.get(relative);
    if (template) exactMatches.push({ root, template, isBass: root === bassPc });
  }

  if (exactMatches.length > 0) {
    const chosen =
      exactMatches.find((c) => c.isBass) ??
      // prioriza a fórmula mais "específica" (mais notas) e, em empate, a ordem da tabela
      exactMatches.sort(
        (x, y) => y.template.intervals.length - x.template.intervals.length || TEMPLATES.indexOf(x.template) - TEMPLATES.indexOf(y.template)
      )[0];
    const rootName = pcName(chosen.root);
    const base = `${rootName}${chosen.template.suffix}`;
    const label = chosen.isBass ? base : `${base}/${pcName(bassPc)}`;
    return { label, root: rootName };
  }

  // --- sem casamento exato: procura a maior fórmula que seja subconjunto das notas tocadas ---
  type PartialCandidate = { root: number; template: ChordTemplate; extras: number[] };
  const partials: PartialCandidate[] = [];
  for (const root of pcSet) {
    const relativeSet = new Set(pcSet.map((pc) => (pc - root + 12) % 12));
    for (const template of TEMPLATES) {
      if (template.intervals.every((iv) => relativeSet.has(iv))) {
        const extras = [...relativeSet].filter((iv) => !template.intervals.includes(iv));
        partials.push({ root, template, extras });
      }
    }
  }

  if (partials.length > 0) {
    partials.sort(
      (x, y) =>
        y.template.intervals.length - x.template.intervals.length ||
        x.extras.length - y.extras.length ||
        (y.root === bassPc ? 1 : 0) - (x.root === bassPc ? 1 : 0) ||
        TEMPLATES.indexOf(x.template) - TEMPLATES.indexOf(y.template)
    );
    const best = partials[0];
    const rootName = pcName(best.root);
    const base = `${rootName}${best.template.suffix}`;
    const tensions = best.extras
      .sort((a, b) => a - b)
      .map((iv) => TENSION_NAMES[iv])
      .filter(Boolean);
    const withTension = tensions.length ? `${base}(${tensions.join(',')})` : base;
    const label = best.root === bassPc ? withTension : `${withTension}/${pcName(bassPc)}`;
    return { label, root: rootName };
  }

  // --- nada reconhecível: mostra as notas cruas ---
  return { label: pcSet.map(pcName).join(' • '), root: null };
}
