declare module 'soundtouchjs' {
  export class PitchShifter {
    constructor(context: AudioContext, buffer: AudioBuffer, bufferSize?: number, onEnd?: () => void);
    tempo: number;
    pitch: number;
    pitchSemitones: number;
    rate: number;
    percentagePlayed: number;
    readonly node: ScriptProcessorNode;
    readonly duration: number;
    readonly formattedDuration: string;
    readonly timePlayed: number;
    connect(node: AudioNode): void;
    disconnect(): void;
    on(eventName: 'play', cb: (detail: { timePlayed: number; formattedTimePlayed: string; percentagePlayed: number }) => void): void;
    off(eventName?: string): void;
  }
}
