import type { MidiBinding } from '../../shared/types';

type MidiMsg = { type: 'note' | 'cc'; channel: number; number: number; /** 0-127 — valor bruto do CC (ou velocity da nota) */ value: number };
type LearnCallback = (msg: MidiMsg) => void;

let learnCallback: LearnCallback | null = null;
// `value` aqui é o valor BRUTO 0-127 que veio nessa mensagem — ações do tipo
// "fader" (ver RACK_CC_FADER_ACTIONS em shared/types.ts) usam esse valor
// contínuo direto; ações do tipo "trigger" (toggles/botões) o ignoram.
let dispatcher: ((binding: MidiBinding, value: number) => void) | null = null;
let bindingsRef: MidiBinding[] = [];
let access: MIDIAccess | null = null;
let initialized = false;

function handleMessage(ev: MIDIMessageEvent) {
  const data = ev.data;
  if (!data || data.length < 2) return;
  const status = data[0];
  const channel = (status & 0x0f) + 1;
  const command = status & 0xf0;
  const number = data[1];
  const velocity = data[2] ?? 0;

  let msg: MidiMsg | null = null;
  if (command === 0x90 && velocity > 0) msg = { type: 'note', channel, number, value: velocity };
  else if (command === 0xb0) msg = { type: 'cc', channel, number, value: velocity };
  if (!msg) return;

  if (learnCallback) {
    const cb = learnCallback;
    learnCallback = null;
    cb(msg);
    return;
  }

  // Pode haver mais de um vínculo pra mesma tecla/CC (ex.: uma ação global e
  // uma ação do Rack no mesmo botão) — dispara todos, não só o primeiro.
  const matches = bindingsRef.filter((b) => b.type === msg!.type && b.channel === msg!.channel && b.number === msg!.number);
  if (matches.length && dispatcher) {
    for (const match of matches) dispatcher(match, msg.value);
  }
}

export async function initMidi(): Promise<boolean> {
  if (initialized) return !!access;
  initialized = true;
  if (!navigator.requestMIDIAccess) return false;
  try {
    access = (await navigator.requestMIDIAccess({ sysex: false })) ?? null;
    if (!access) return false;
    attachAll();
    access.onstatechange = () => attachAll();
    return true;
  } catch (err) {
    console.warn('[midi] acesso negado ou indisponível', err);
    return false;
  }
}

function attachAll() {
  if (!access) return;
  access.inputs.forEach((input) => {
    input.onmidimessage = handleMessage;
  });
}

export function setBindings(bindings: MidiBinding[]) {
  bindingsRef = bindings;
}

export function setDispatcher(fn: (binding: MidiBinding, value: number) => void) {
  dispatcher = fn;
}

export function armLearn(cb: LearnCallback) {
  learnCallback = cb;
}

export function cancelLearn() {
  learnCallback = null;
}

export function listInputNames(): string[] {
  if (!access) return [];
  return Array.from(access.inputs.values()).map((i) => i.name ?? 'Dispositivo MIDI');
}

export function isSupported(): boolean {
  return 'requestMIDIAccess' in navigator;
}

/**
 * Manda um Program Change MIDI pra TODAS as saídas MIDI conectadas — usado
 * pelas "Cues de palco" (ver SongPart.cueMidiProgram em shared/types.ts):
 * dispara automaticamente quando uma parte com cue configurada fica ativa,
 * pra trocar a cena de um console/software externo que só aceita MIDI (em
 * vez de OSC). `channel` é 0-15 (MIDI canal 1-16), `program` é 0-127.
 * Silencioso se não houver nenhuma saída MIDI disponível/autorizada.
 */
export function sendMidiProgramChange(channel: number, program: number): void {
  if (!access) return;
  const status = 0xc0 | (channel & 0x0f);
  const data = [status, program & 0x7f];
  access.outputs.forEach((output) => {
    try {
      output.send(data);
    } catch {
      /* saída pode ter sido desconectada entre a checagem e o envio — ignora */
    }
  });
}
