import { rackEngine } from '../audio/rack/RackEngine';
import type { RackVelocityCurve } from '../../shared/types';

// Roteador de MIDI dedicado ao Rack de instrumentos (camadas ao vivo). É
// separado do midiController.ts (que só trata vínculos de ação/CC) de
// propósito: usamos addEventListener('midimessage', ...) em vez de sobrescrever
// `input.onmidimessage`, assim os dois sistemas convivem sem um atropelar o
// outro quando ambos estão ativos ao mesmo tempo.
let access: MIDIAccess | null = null;
let selectedInputId: string | null = null;
const attached = new Set<MIDIInput>();
const changeListeners = new Set<() => void>();
const programChangeListeners = new Set<(program: number) => void>();
const rawNoteOnListeners = new Set<(note: number) => void>();

/** Avisa quando chega uma mensagem MIDI Program Change (0xC0) — usado pro recall de cenas do rack. */
export function onRackProgramChange(cb: (program: number) => void): () => void {
  programChangeListeners.add(cb);
  return () => programChangeListeners.delete(cb);
}

/**
 * Avisa sobre cada tecla física pressionada, com a nota já transposta
 * globalmente mas ANTES de qualquer filtro de camada — usado só pelo
 * "Aprender faixa" (MIDI learn) no painel Editar, pra descobrir a faixa de
 * notas tocada sem interferir no roteamento normal pro RackEngine.
 */
export function onRackRawNoteOn(cb: (note: number) => void): () => void {
  rawNoteOnListeners.add(cb);
  return () => rawNoteOnListeners.delete(cb);
}

// --- configuração "completa" do teclado MIDI físico (ver TitleBar > painel MIDI) ---
let velocityCurve: RackVelocityCurve = 'linear';
let transpose = 0;
let sustainEnabled = true;
let sustainDown = false;
/** notas (já transpostas) soltas fisicamente enquanto o pedal estava pressionado */
const heldBySustain = new Set<number>();

export function setRackVelocityCurve(curve: RackVelocityCurve) {
  velocityCurve = curve;
}

export function setRackTranspose(semitones: number) {
  transpose = semitones;
}

export function setRackSustainEnabled(enabled: boolean) {
  sustainEnabled = enabled;
  if (!enabled && sustainDown) releaseSustainedNotes();
}

/**
 * Aplica uma curva de velocidade (linear/suave/dura) a um valor de toque
 * 1-127. Extraída como função pura e exportada pra poder ser reaproveitada
 * fora do roteador MIDI físico — ex.: pelo teclado virtual clicável do Rack,
 * que calcula a própria velocity a partir da posição do clique na tecla mas
 * precisa aplicar a MESMA curva configurada (fonte única de verdade).
 */
export function computeVelocityCurve(curve: RackVelocityCurve, v: number): number {
  const n = Math.max(1, Math.min(127, v)) / 127;
  switch (curve) {
    case 'soft': // comprime velocidades baixas (resposta mais "macia")
      return Math.max(1, Math.round(127 * Math.pow(n, 1.6)));
    case 'hard': // realça velocidades baixas (resposta mais "sensível"/dura)
      return Math.max(1, Math.round(127 * Math.pow(n, 0.6)));
    case 'linear':
    default:
      return v;
  }
}

function applyVelocityCurve(v: number): number {
  return computeVelocityCurve(velocityCurve, v);
}

function releaseSustainedNotes() {
  for (const note of heldBySustain) rackEngine.noteOff(note);
  heldBySustain.clear();
}

export function onRackMidiDevicesChanged(cb: () => void): () => void {
  changeListeners.add(cb);
  return () => changeListeners.delete(cb);
}

function handleMessage(ev: MIDIMessageEvent) {
  const data = ev.data;
  if (!data || data.length < 2) return;
  const command = data[0] & 0xf0;
  const channel = (data[0] & 0x0f) + 1; // canal MIDI "humano", 1-16

  if (command === 0xb0) {
    // Control Change — só nos interessa o pedal de sustain (CC 64) aqui.
    const controller = data[1];
    const value = data[2] ?? 0;
    if (controller === 64 && sustainEnabled) {
      const down = value >= 64;
      if (down && !sustainDown) {
        sustainDown = true;
      } else if (!down && sustainDown) {
        sustainDown = false;
        releaseSustainedNotes();
      }
    }
    return;
  }

  if (command === 0xe0) {
    // Pitch bend: 14 bits (LSB + MSB*128), centro = 8192.
    const raw = (data[1] ?? 0) | ((data[2] ?? 0) << 7);
    const normalized = (raw - 8192) / 8192;
    rackEngine.setPitchBend(normalized, channel);
    return;
  }

  if (command === 0xc0) {
    // Program Change — usado pra recall de cenas salvas do rack (ver RackMidiPanel/InstrumentRack).
    programChangeListeners.forEach((cb) => cb(data[1] ?? 0));
    return;
  }

  if (command !== 0x90 && command !== 0x80) return;
  const rawNote = data[1];
  const rawVelocity = data[2] ?? 0;
  const note = rawNote + transpose;
  if (note < 0 || note > 127) return;

  const isNoteOn = command === 0x90 && rawVelocity > 0;
  if (isNoteOn) {
    heldBySustain.delete(note);
    rackEngine.noteOn(note, applyVelocityCurve(rawVelocity), channel);
    rawNoteOnListeners.forEach((cb) => cb(note));
  } else {
    if (sustainDown && sustainEnabled) {
      heldBySustain.add(note);
    } else {
      rackEngine.noteOff(note, channel);
    }
  }
}

function attachAll() {
  if (!access) return;
  attached.forEach((input) => input.removeEventListener('midimessage', handleMessage as EventListener));
  attached.clear();
  access.inputs.forEach((input) => {
    if (selectedInputId && input.id !== selectedInputId) return;
    input.addEventListener('midimessage', handleMessage as EventListener);
    attached.add(input);
  });
  changeListeners.forEach((cb) => cb());
}

export async function initRackMidi(): Promise<boolean> {
  if (!navigator.requestMIDIAccess) return false;
  try {
    access = (await navigator.requestMIDIAccess({ sysex: false })) ?? null;
    if (!access) return false;
    attachAll();
    access.onstatechange = () => attachAll();
    return true;
  } catch (err) {
    console.warn('[rack-midi] acesso negado ou indisponível', err);
    return false;
  }
}

/** null = ouvir todos os dispositivos MIDI conectados */
export function setRackMidiInput(id: string | null) {
  selectedInputId = id;
  attachAll();
}

export function listRackMidiInputs(): { id: string; name: string }[] {
  if (!access) return [];
  return Array.from(access.inputs.values()).map((i) => ({ id: i.id, name: i.name ?? 'Dispositivo MIDI' }));
}

export function isRackMidiSupported(): boolean {
  return 'requestMIDIAccess' in navigator;
}

// Expõe o parser de mensagens em window pra diagnóstico manual e pro harness
// de testes via CDP (ver scripts/cdp-*.cjs) — permite simular bytes MIDI
// brutos (ex.: Program Change, Pitch Bend) sem um teclado físico conectado
// ao sandbox de desenvolvimento. Não é usado por nenhum caminho do app em si.
if (typeof window !== 'undefined') {
  (window as unknown as { __rackMidiTestDispatch?: (bytes: number[]) => void }).__rackMidiTestDispatch = (
    bytes: number[]
  ) => handleMessage({ data: Uint8Array.from(bytes) } as MIDIMessageEvent);
}

