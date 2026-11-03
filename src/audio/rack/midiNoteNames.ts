/** Nome de nota MIDI no padrão "C3 = nota 60" (convenção já usada no resto
 *  do projeto — ver comentários de `root_note`/DEFAULT_ROOT_NOTE nos
 *  importadores Rust). Usado só para exibição no MRQ Instrument Analyzer
 *  (Fase 8) — nunca para decidir comportamento de reprodução. */
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function midiNoteName(note: number): string {
  const octave = Math.floor(note / 12) - 2;
  const name = NOTE_NAMES[((note % 12) + 12) % 12];
  return `${name}${octave}`;
}

export function midiNoteLabel(note: number): string {
  return `${midiNoteName(note)} (${note})`;
}

const NOTE_LETTER_SEMITONE: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** Inverso de `midiNoteName` — converte um nome de nota (ex.: "C3", "Db4",
 *  "F#2", "c-1") pra número MIDI, na MESMA convenção já usada acima
 *  (C3 = 60). Usado pelo Kontakt Audio Capture (`kontaktCapture.ts`) pra
 *  reconhecer nota a partir do NOME do arquivo WAV renderizado — devolve
 *  `null` quando a string não é um nome de nota válido nessa notação
 *  (nunca "chuta" um valor). Aceita `#`/`s`/`sharp` pra sustenido e
 *  `b`/`flat` pra bemol (variações comuns em nomes de arquivo de
 *  bibliotecas de amostra). */
export function noteNameToMidi(raw: string): number | null {
  const m = /^([A-Ga-g])(#|s|sharp|b|flat)?(-?\d{1,2})$/.exec(raw.trim());
  if (!m) return null;
  const letter = m[1].toLowerCase();
  const accidentalRaw = (m[2] || '').toLowerCase();
  const octave = Number(m[3]);
  if (!Number.isFinite(octave)) return null;
  let semitone = NOTE_LETTER_SEMITONE[letter];
  if (semitone === undefined) return null;
  if (accidentalRaw === '#' || accidentalRaw === 's' || accidentalRaw === 'sharp') semitone += 1;
  else if (accidentalRaw === 'b' || accidentalRaw === 'flat') semitone -= 1;
  // C3 = 60 nesta convenção (ver midiNoteName): MIDI = (octave + 2) * 12 + semitone.
  const note = (octave + 2) * 12 + semitone;
  if (note < 0 || note > 127) return null;
  return note;
}
