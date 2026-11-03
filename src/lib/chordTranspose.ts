const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const NOTE_INDEX: Record<string, number> = {
  C: 0, 'B#': 0,
  'C#': 1, Db: 1,
  D: 2,
  'D#': 3, Eb: 3,
  E: 4, Fb: 4,
  F: 5, 'E#': 5,
  'F#': 6, Gb: 6,
  G: 7,
  'G#': 8, Ab: 8,
  A: 9,
  'A#': 10, Bb: 10,
  B: 11, Cb: 11,
};

const CHORD_TOKEN_RE =
  /([A-G])(#|b)?((?:maj|min|dim|aug|sus|add|m)?\d{0,2}(?:maj7|m7b5|m7#5|dim7|aug|sus2|sus4|add9|add11|add13|maj9|maj13|m7|m9|m6|m11|m13|M7|M9|6\/9|6|7|9|11|13|M|\+|°|ø)?)(\/([A-G])(#|b)?)?/g;

/** Transpõe um único token de acorde, preservando a qualidade e o baixo (slash chord). */
export function transposeChord(token: string, semitones: number, preferFlats = false): string {
  if (semitones === 0) return token;
  const names = preferFlats ? FLAT_NAMES : SHARP_NAMES;
  return token.replace(CHORD_TOKEN_RE, (_m, root, acc, quality, _slashAll, bassRoot, bassAcc) => {
    const rootKey = root + (acc ?? '');
    const rootIdx = NOTE_INDEX[rootKey];
    if (rootIdx === undefined) return _m;
    const newRoot = names[((rootIdx + semitones) % 12 + 12) % 12];
    let out = newRoot + (quality ?? '');
    if (bassRoot) {
      const bassKey = bassRoot + (bassAcc ?? '');
      const bassIdx = NOTE_INDEX[bassKey];
      if (bassIdx !== undefined) {
        out += '/' + names[((bassIdx + semitones) % 12 + 12) % 12];
      }
    }
    return out;
  });
}

/** Heurística: uma linha "é de acordes" se a maioria dos tokens separados por espaço parecem acordes. */
export function isChordLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^\[.*]$/.test(trimmed)) return false; // marcador de parte, ex: [Refrão]
  const tokens = trimmed.split(/\s+/);
  let chordish = 0;
  for (const t of tokens) {
    if (/^[A-G](#|b)?[a-zA-Z0-9°+/#]*$/.test(t)) chordish++;
  }
  return chordish / tokens.length >= 0.6;
}

export function transposeChordChart(raw: string, semitones: number, preferFlats = false): string {
  if (semitones === 0) return raw;
  return raw
    .split('\n')
    .map((line) => {
      if (!isChordLine(line)) return line;
      return line.replace(CHORD_TOKEN_RE, (m) => transposeChord(m, semitones, preferFlats));
    })
    .join('\n');
}

export interface ChordSection {
  partName: string | null;
  lines: string[];
}

/** Divide a cifra colada em seções, usando marcadores [Nome] como separadores. */
export function splitChordSections(raw: string): ChordSection[] {
  const lines = raw.split('\n');
  const sections: ChordSection[] = [];
  let current: ChordSection = { partName: null, lines: [] };
  for (const line of lines) {
    const match = line.trim().match(/^\[(.+)]$/);
    if (match) {
      if (current.lines.length > 0 || current.partName) sections.push(current);
      current = { partName: match[1], lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.length > 0 || current.partName) sections.push(current);
  return sections;
}
