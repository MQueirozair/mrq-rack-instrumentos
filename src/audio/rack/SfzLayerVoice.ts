import type { RackPresetOption } from '../../../shared/types';

const ATTACK_SEC = 0.003;
const RELEASE_SEC = 0.12;

interface SfzZone {
  samplePath: string;
  rootNote: number;
  loNote: number;
  hiNote: number;
  loVel: number;
  hiVel: number;
  tuneCents: number;
  /** ganho linear (já convertido do "volume" em dB do SFZ, que é logarítmico) */
  gain: number;
  /** -1 (totalmente esquerda) a 1 (totalmente direita); 0 = centro */
  pan: number;
}

/** Nomes de nota aceitos pelo SFZ pra lokey/hikey/pitch_keycenter/key, ex.: "c4", "f#3", "Bb2".
 *  Convenção adotada (a mais comum entre implementações SFZ): c4 = nota MIDI 60. */
const NOTE_NAME_RE = /^([a-gA-G])([#b]?)(-?\d+)$/;
const NOTE_BASE: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

function noteNameToMidi(raw: string): number | null {
  const m = NOTE_NAME_RE.exec(raw.trim());
  if (!m) return null;
  const base = NOTE_BASE[m[1].toLowerCase()];
  const accidental = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  const octave = Number(m[3]);
  return base + accidental + (octave + 1) * 12;
}

function parseNoteOrNumber(raw: string | undefined, fallback: number): number {
  if (raw == null) return fallback;
  const trimmed = raw.trim();
  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber) && /^-?\d+(\.\d+)?$/.test(trimmed)) return Math.round(asNumber);
  const fromName = noteNameToMidi(trimmed);
  return fromName ?? fallback;
}

function parseNumber(raw: string | undefined, fallback: number): number {
  if (raw == null) return fallback;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : fallback;
}

interface SfzToken {
  kind: 'header' | 'opcode';
  name: string;
  index: number;
  valueStart?: number;
}

/** Tokeniza um arquivo .sfz: encontra cabeçalhos "<tag>" e opcodes "chave=valor".
 *  O valor de um opcode vai até o começo do próximo token reconhecido (cabeçalho
 *  ou "outra_chave="), e não até o fim da linha — porque caminhos de amostra no
 *  SFZ podem ter espaços sem aspas (ex.: sample=Piano Grande C3.wav). Essa é a
 *  técnica padrão usada por leitores de SFZ de código aberto pra esse problema. */
function tokenize(text: string): SfzToken[] {
  const tokens: SfzToken[] = [];
  const pattern = /<(\w+)>|([A-Za-z_][\w]*)=/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match[1]) {
      tokens.push({ kind: 'header', name: match[1].toLowerCase(), index: match.index });
    } else if (match[2]) {
      tokens.push({ kind: 'opcode', name: match[2].toLowerCase(), index: match.index, valueStart: pattern.lastIndex });
    }
  }
  return tokens;
}

/** Remove comentários "// ..." até o fim da linha, sem mexer no resto do texto. */
function stripComments(text: string): string {
  return text.replace(/\/\/[^\n\r]*/g, '');
}

interface ParsedSfz {
  zones: SfzZone[];
  defaultPath: string;
}

/**
 * Faz o parsing de verdade do texto de um .sfz — formato público, em texto puro,
 * documentado abertamente (ao contrário do .nki do Kontakt). Segue a hierarquia
 * oficial do formato: opcodes em <global> valem pra tudo, <master>/<group> valem
 * só pro que vem depois dentro deles, e <region> é a "folha" (uma amostra +
 * faixa de tecla/velocidade). Cada nível mais específico sobrescreve o anterior.
 * Não implementamos loops, offsets de amostra, envelopes nem efeitos do SFZ —
 * mesmo recorte que já usamos pro .nki: só timbres/amostras e seu mapeamento de
 * tecla/velocidade, não o motor de síntese completo.
 */
function parseSfz(text: string): ParsedSfz {
  const clean = stripComments(text);
  const tokens = tokenize(clean);

  let globalOpcodes: Record<string, string> = {};
  let masterOpcodes: Record<string, string> = {};
  let groupOpcodes: Record<string, string> = {};
  let regionOpcodes: Record<string, string> | null = null;
  let controlOpcodes: Record<string, string> = {};
  let target: 'global' | 'master' | 'group' | 'region' | 'control' | 'other' = 'other';

  const regions: Record<string, string>[] = [];
  const flushRegion = () => {
    if (regionOpcodes) {
      regions.push({ ...globalOpcodes, ...masterOpcodes, ...groupOpcodes, ...regionOpcodes });
      regionOpcodes = null;
    }
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.kind === 'header') {
      if (tok.name === 'global') {
        flushRegion();
        globalOpcodes = {};
        masterOpcodes = {};
        groupOpcodes = {};
        target = 'global';
      } else if (tok.name === 'master') {
        flushRegion();
        masterOpcodes = {};
        groupOpcodes = {};
        target = 'master';
      } else if (tok.name === 'group') {
        flushRegion();
        groupOpcodes = {};
        target = 'group';
      } else if (tok.name === 'region') {
        flushRegion();
        regionOpcodes = {};
        target = 'region';
      } else if (tok.name === 'control') {
        flushRegion();
        target = 'control';
      } else {
        flushRegion();
        target = 'other'; // <curve>, <effect> etc. — fora do escopo de amostras/zonas
      }
      continue;
    }
    // opcode: valor vai até o próximo token (cabeçalho ou opcode seguinte)
    const valueEnd = i + 1 < tokens.length ? tokens[i + 1].index : clean.length;
    const value = clean.slice(tok.valueStart ?? tok.index, valueEnd).trim();
    if (target === 'global') globalOpcodes[tok.name] = value;
    else if (target === 'master') masterOpcodes[tok.name] = value;
    else if (target === 'group') groupOpcodes[tok.name] = value;
    else if (target === 'region' && regionOpcodes) regionOpcodes[tok.name] = value;
    else if (target === 'control') controlOpcodes[tok.name] = value;
  }
  flushRegion();

  const zones: SfzZone[] = [];
  for (const opcodes of regions) {
    const sample = opcodes.sample;
    if (!sample) continue; // região sem amostra (raro, mas existe em alguns .sfz de efeito)
    const key = opcodes.key != null ? parseNoteOrNumber(opcodes.key, 60) : null;
    const rootNote = opcodes.pitch_keycenter != null ? parseNoteOrNumber(opcodes.pitch_keycenter, key ?? 60) : key ?? 60;
    const loNote = opcodes.lokey != null ? parseNoteOrNumber(opcodes.lokey, key ?? 0) : key ?? 0;
    const hiNote = opcodes.hikey != null ? parseNoteOrNumber(opcodes.hikey, key ?? 127) : key ?? 127;
    const loVel = parseNumber(opcodes.lovel, 0);
    const hiVel = parseNumber(opcodes.hivel, 127);
    const tuneCents = parseNumber(opcodes.tune, 0) + parseNumber(opcodes.transpose, 0) * 100;
    const volumeDb = parseNumber(opcodes.volume, 0);
    const gain = Math.pow(10, volumeDb / 20);
    const panRaw = parseNumber(opcodes.pan, 0); // SFZ: -100..100
    const pan = Math.max(-1, Math.min(1, panRaw / 100));
    zones.push({ samplePath: sample, rootNote, loNote, hiNote, loVel, hiVel, tuneCents, gain, pan });
  }

  return { zones, defaultPath: controlOpcodes.default_path ?? '' };
}

/**
 * Camada "SFZ": lê de verdade um arquivo .sfz (formato de texto aberto e
 * documentado publicamente, sem nenhuma proteção ou criptografia — ao
 * contrário do .nki do Kontakt 5 em diante). Serve como ponte segura pra usar
 * instrumentos do Kontakt 5/6/7/8: a Native Instruments não permite ler o
 * arquivo binário desses patches, mas o próprio Kontakt (sua cópia
 * licenciada) pode exportar o mapeamento de grupos/zonas como .sfz através
 * da API oficial de script (Creator Tools/KSP) — sem reverter nenhuma
 * criptografia. Esse exportador faz a leitura de verdade do instrumento
 * carregado no Kontakt; aqui só interpretamos o texto resultante.
 */
export class SfzLayerVoice {
  private ctx: AudioContext;
  private zones: SfzZone[] = [];
  private buffers = new Map<SfzZone, AudioBuffer>();
  private active = new Map<number, { src: AudioBufferSourceNode; gain: GainNode; baseRate: number }[]>();
  private bendSemitones = 0;
  private instrumentName = '';
  readonly output: GainNode;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.output = ctx.createGain();
  }

  get name(): string {
    return this.instrumentName;
  }

  async load(buffer: ArrayBuffer, sourcePath?: string): Promise<RackPresetOption[]> {
    this.dispose();
    const text = new TextDecoder('utf-8').decode(buffer);
    const { zones, defaultPath } = parseSfz(text);
    this.instrumentName = sourcePath ? (sourcePath.split(/[\\/]/).pop() ?? '').replace(/\.sfz$/i, '') : '';

    if (zones.length === 0) {
      throw new Error(
        'O .sfz foi aberto, mas nenhuma região com amostra foi encontrada dentro dele (verifique se o arquivo não está vazio ou corrompido).'
      );
    }

    const baseDir = sourcePath ? sourcePath.replace(/[\\/][^\\/]*$/, '') : '';
    let resolved = 0;
    const failures: string[] = [];
    for (const zone of zones) {
      const audioBuffer = await this.resolveSample(zone.samplePath, baseDir, defaultPath);
      if (audioBuffer) {
        this.buffers.set(zone, audioBuffer);
        resolved++;
      } else {
        failures.push(zone.samplePath.split(/[\\/]/).pop() ?? zone.samplePath);
      }
    }
    this.zones = zones.filter((z) => this.buffers.has(z));

    if (resolved === 0) {
      throw new Error(
        'Nenhuma das amostras referenciadas por este .sfz foi encontrada ao lado do arquivo no disco ' +
          '(mantenha a pasta de amostras original na mesma pasta do .sfz, ou ajuste o caminho dentro do arquivo).'
      );
    }
    if (failures.length > 0) {
      console.warn(`[sfz] ${failures.length} amostra(s) não encontrada(s) e ficarão mudas: ${failures.join(', ')}`);
    }

    return [{ value: 'default', label: this.instrumentName || 'Instrumento SFZ' }];
  }

  /** Resolve um caminho de amostra do .sfz em relação à pasta do arquivo — tentando
   *  também o "default_path" (declarado em <control>) e a pasta "Samples" ao lado,
   *  do mesmo jeito tolerante que já usamos pro .nki. */
  private async resolveSample(samplePath: string, baseDir: string, defaultPath: string): Promise<AudioBuffer | null> {
    if (!baseDir) return null;
    const relative = samplePath.replace(/\\/g, '/').replace(/^\.?\//, '');
    const fileName = relative.split('/').pop() ?? relative;
    const defaultRel = defaultPath ? defaultPath.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/$/, '') : '';
    const candidates = [
      defaultRel ? `${baseDir}/${defaultRel}/${relative}` : null,
      `${baseDir}/${relative}`,
      `${baseDir}/${fileName}`,
      `${baseDir}/Samples/${fileName}`,
      `${baseDir}/samples/${fileName}`,
    ].filter((c): c is string => Boolean(c));
    for (const candidate of candidates) {
      try {
        const url = await window.api.fs.toFileUrl(candidate);
        const res = await fetch(url);
        if (!res.ok) continue;
        const arrayBuffer = await res.arrayBuffer();
        return await this.ctx.decodeAudioData(arrayBuffer.slice(0));
      } catch {
        // tenta o próximo candidato
      }
    }
    return null;
  }

  private zonesFor(note: number, velocity: number): SfzZone[] {
    const matches = this.zones.filter(
      (z) => note >= z.loNote && note <= z.hiNote && velocity >= z.loVel && velocity <= z.hiVel
    );
    return matches.length > 0 ? matches : this.zones.filter((z) => note >= z.loNote && note <= z.hiNote);
  }

  noteOn(note: number, velocity: number) {
    this.stopNote(note, 0.01);
    const zones = this.zonesFor(note, velocity);
    if (zones.length === 0) return;
    const voices: { src: AudioBufferSourceNode; gain: GainNode; baseRate: number }[] = [];
    const now = this.ctx.currentTime;
    for (const zone of zones) {
      const audioBuffer = this.buffers.get(zone);
      if (!audioBuffer) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = audioBuffer;
      const baseRate = Math.pow(2, (note - zone.rootNote + zone.tuneCents / 100) / 12);
      src.playbackRate.value = baseRate * Math.pow(2, this.bendSemitones / 12);
      const gain = this.ctx.createGain();
      const target = Math.max(0, Math.min(1, (velocity / 127) * zone.gain));
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(target, now + ATTACK_SEC);
      let node: AudioNode = gain;
      if (zone.pan) {
        const panner = this.ctx.createStereoPanner();
        panner.pan.value = zone.pan;
        gain.connect(panner);
        node = panner;
      }
      node.connect(this.output);
      src.connect(gain);
      src.start();
      src.onended = () => {
        try {
          gain.disconnect();
        } catch {
          /* já desconectado */
        }
      };
      voices.push({ src, gain, baseRate });
    }
    if (voices.length > 0) this.active.set(note, voices);
  }

  noteOff(note: number) {
    this.stopNote(note, RELEASE_SEC);
  }

  setPitchBend(semitones: number) {
    this.bendSemitones = semitones;
    const now = this.ctx.currentTime;
    const bendFactor = Math.pow(2, semitones / 12);
    for (const voices of this.active.values()) {
      for (const voice of voices) voice.src.playbackRate.setTargetAtTime(voice.baseRate * bendFactor, now, 0.01);
    }
  }

  private stopNote(note: number, fadeSec: number) {
    const voices = this.active.get(note);
    if (!voices) return;
    this.active.delete(note);
    const now = this.ctx.currentTime;
    for (const voice of voices) {
      try {
        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
        voice.gain.gain.linearRampToValueAtTime(0, now + fadeSec);
        voice.src.stop(now + fadeSec + 0.02);
      } catch {
        /* fonte já parada */
      }
    }
  }

  allNotesOff() {
    for (const note of Array.from(this.active.keys())) this.stopNote(note, 0.05);
  }

  dispose() {
    this.allNotesOff();
    this.zones = [];
    this.buffers.clear();
  }
}
