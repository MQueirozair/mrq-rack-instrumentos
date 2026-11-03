// Tipos mínimos da Web MIDI API (caso a lib DOM do TS instalada não os inclua).
export {};

declare global {
  interface MIDIMessageEvent extends Event {
    data: Uint8Array;
  }

  interface MIDIPort extends EventTarget {
    id: string;
    name?: string;
    manufacturer?: string;
    state: string;
  }

  interface MIDIInput extends MIDIPort {
    onmidimessage: ((this: MIDIInput, ev: MIDIMessageEvent) => void) | null;
  }

  interface MIDIAccess extends EventTarget {
    inputs: Map<string, MIDIInput>;
    onstatechange: ((this: MIDIAccess, ev: Event) => void) | null;
  }

  interface Navigator {
    requestMIDIAccess?: (options?: { sysex?: boolean }) => Promise<MIDIAccess>;
  }
}
