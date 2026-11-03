"use strict";
// Tipos compartilhados entre o processo principal (Electron/Node) e a interface (renderer).
Object.defineProperty(exports, "__esModule", { value: true });
exports.RACK_PAD_NOTE_COLORS = exports.NOTE_NAMES = exports.PART_COLORS = exports.DEFAULT_SETTINGS = exports.DEFAULT_RACK_STATE = exports.RACK_PAD_LAYER_INDEX = exports.RACK_LAYER_COUNT = exports.RACK_EQ_BAND_LABELS = exports.RACK_EQ_BAND_ROLES = exports.RACK_ARP_DIVISION_BEATS = exports.RACK_DELAY_DIVISION_BEATS = exports.RACK_CC_TRIGGER_ACTIONS = exports.RACK_CC_FADER_ACTIONS = void 0;
exports.defaultRackEqBands = defaultRackEqBands;
exports.emptyRackLayer = emptyRackLayer;
exports.migrateRackLayers = migrateRackLayers;
exports.semitoneDistance = semitoneDistance;
exports.normalizeNote = normalizeNote;
/**
 * Ações do Rack que podem ser mapeadas num CC/botão do teclado MIDI físico
 * (ver RackMidiCcPanel). "fader" = usa o VALOR contínuo (0-127) do CC pra
 * controlar algo direto (volume, reverb, transposição); "trigger" = qualquer
 * mensagem (nota ligada ou CC, não importa o valor) alterna um liga/desliga.
 */
exports.RACK_CC_FADER_ACTIONS = [
    'rack:layer:volume',
    'rack:master:volume',
    'rack:master:reverb',
    'rack:master:transpose',
];
exports.RACK_CC_TRIGGER_ACTIONS = [
    'rack:layer:mute',
    'rack:layer:solo',
    'rack:layer:octaver',
    'rack:master:panic',
];
/** Duração de cada divisão em "tempos" (1 tempo = 1 nota semínima/quarter note), pra converter BPM em milissegundos: ms = (60000/bpm) * tempos. */
exports.RACK_DELAY_DIVISION_BEATS = {
    '1/16': 0.25,
    '1/8t': 1 / 3,
    '1/8': 0.5,
    '1/8d': 0.75,
    '1/4': 1,
    '1/4d': 1.5,
    '1/2': 2,
};
/** Duração de cada divisão em "tempos" (1 tempo = 1 semínima), mesmo princípio de RACK_DELAY_DIVISION_BEATS. */
exports.RACK_ARP_DIVISION_BEATS = {
    '1/4': 1,
    '1/8': 0.5,
    '1/8t': 1 / 3,
    '1/16': 0.25,
    '1/16t': 1 / 6,
    '1/32': 0.125,
};
/**
 * As 6 bandas fixas do equalizador paramétrico por camada (ver
 * RackLayer.eqBands) — sempre nessa ordem e com essa função; o usuário não
 * adiciona/remove bandas, só ajusta frequência/ganho/Q e liga/desliga cada
 * uma, igual ao equalizador de referência (print "SLOT FX").
 */
exports.RACK_EQ_BAND_ROLES = ['lowcut', 'lowshelf', 'bell1', 'bell2', 'highshelf', 'highcut'];
exports.RACK_EQ_BAND_LABELS = {
    lowcut: 'Corte grave',
    lowshelf: 'Prateleira grave',
    bell1: 'Sino 1',
    bell2: 'Sino 2',
    highshelf: 'Prateleira aguda',
    highcut: 'Corte agudo',
};
/** Valores padrão das 6 bandas, na ordem de RACK_EQ_BAND_ROLES. */
function defaultRackEqBands() {
    return [
        { enabled: true, freqHz: 70, gainDb: 0, q: 0.71 }, // lowcut
        { enabled: true, freqHz: 150, gainDb: 0, q: 0.71 }, // lowshelf
        { enabled: true, freqHz: 280, gainDb: 0, q: 1.2 }, // bell1
        { enabled: true, freqHz: 2500, gainDb: 0, q: 0.9 }, // bell2
        { enabled: true, freqHz: 6000, gainDb: 0, q: 0.71 }, // highshelf
        { enabled: true, freqHz: 12000, gainDb: 0, q: 0.71 }, // highcut
    ];
}
function emptyRackLayer(id, color) {
    return {
        id,
        color,
        format: null,
        filePath: null,
        fileName: null,
        displayName: null,
        presets: [],
        selectedPreset: null,
        character: 'original',
        volume: 0.7,
        muted: false,
        solo: false,
        rootNote: 60,
        photoDataUrl: null,
        pan: 0,
        noteRangeStart: 0,
        noteRangeEnd: 127,
        octave: 0,
        midiChannel: 0,
        envelopeEnabled: false,
        attackMs: 5,
        decayMs: 0,
        releaseMs: 350,
        playMode: 'poly',
        legato: false,
        glideMs: 80,
        filterEnabled: false,
        cutoffHz: 20000,
        eqEnabled: false,
        eqBassDb: 0,
        eqMidDb: 0,
        eqTrebleDb: 0,
        eqMidFreqHz: 1000,
        eqBands: defaultRackEqBands(),
        driveEnabled: false,
        driveType: 'warm',
        driveDb: 0,
        driveMix: 1,
        // enabled=true/send=1 preserva o comportamento de antes deste recurso existir
        // (toda camada ia 100% pro reverb compartilhado, sem controle individual).
        reverbEnabled: true,
        reverbSend: 1,
        compressorEnabled: false,
        compressorAmount: 0.4,
        compressorAttackMs: 8,
        compressorReleaseMs: 140,
        compressorFast: false,
        compressorThresholdDb: -24,
        compressorRatio: 4,
        compressorMakeupDb: 0,
        delayEnabled: false,
        delayTimeMs: 300,
        delayFeedback: 0.3,
        delayMix: 0.35,
        delaySync: false,
        delayDivision: '1/8',
        delayPingPong: false,
        delayAnalog: false,
        delayFilterType: 'off',
        chorusEnabled: false,
        chorusMix: 0.25,
        tremoloEnabled: false,
        tremoloRateHz: 4,
        tremoloDepth: 0.5,
        tremoloStereo: 0,
        octaverEnabled: false,
        octaverMode: 'down',
        octaverMix: 0.7,
        gateEnabled: false,
        gateThresholdDb: -40,
        gateAttackMs: 5,
        gateReleaseMs: 120,
        phaserEnabled: false,
        phaserRateHz: 0.5,
        phaserDepth: 0.6,
        phaserMix: 0.5,
        flangerEnabled: false,
        flangerRateHz: 0.25,
        flangerDepth: 0.5,
        flangerFeedback: 0.4,
        flangerMix: 0.5,
        bitcrusherEnabled: false,
        bitcrusherBits: 12,
        bitcrusherRateHz: 44100,
        bitcrusherMix: 1,
        shimmerEnabled: false,
        shimmerMix: 0.35,
        shimmerFeedback: 0.55,
        shimmerToneHz: 6000,
        shimmerShiftSemitones: 12,
        shimmerDiffusion: 0.6,
        shimmerSize: 1,
        shimmerLowCutHz: 200,
        shimmerModRateHz: 0.6,
        shimmerModDepth: 0.25,
        shimmerReverbMode: 'mono',
        shimmerPitchMode: 'single',
        shimmerColor: 'bright',
        arpEnabled: false,
        arpPattern: 'up',
        arpSync: true,
        arpRateHz: 6,
        arpDivision: '1/16',
        arpOctaves: 1,
        arpGate: 0.7,
        arpSwing: 0,
        arpLatch: false,
    };
}
/** Quantidade de camadas do Rack de instrumentos — única fonte da verdade, usada tanto pro estado inicial quanto pelo motor de áudio (RackEngine). */
exports.RACK_LAYER_COUNT = 8;
/**
 * Índice (0-based) da última camada do Rack — ela é especial: em vez do
 * cartão compacto normal, a interface mostra a "Camada PAD" (ver
 * InstrumentRack.tsx/RackPadLayer.tsx), uma grade de 12 pads coloridos (uma
 * oitava cromática) pra tocar sem precisar de teclado MIDI físico nem abrir
 * o Teclado Virtual compartilhado — pensada pra quem quer disparar uma única
 * camada isoladamente com o mouse/touch. Aceita qualquer formato de
 * instrumento, igual as outras 7 — só a interface muda.
 */
exports.RACK_PAD_LAYER_INDEX = exports.RACK_LAYER_COUNT - 1;
exports.DEFAULT_RACK_STATE = {
    layers: [
        emptyRackLayer('camada-1', '#d6455d'),
        emptyRackLayer('camada-2', '#2fb8c6'),
        emptyRackLayer('camada-3', '#8a5fd6'),
        emptyRackLayer('camada-4', '#d6b23c'),
        emptyRackLayer('camada-5', '#4fae5e'),
        emptyRackLayer('camada-6', '#d6782e'),
        emptyRackLayer('camada-7', '#4a7fd6'),
        emptyRackLayer('camada-8-pad', '#2dd4bf'),
    ],
    masterVolume: 0.8,
    reverb: 0,
    midiInputId: null,
    velocityCurve: 'linear',
    transpose: 0,
    sustainEnabled: true,
    bufferFrames: 0,
    scenes: [],
    chordDisplayEnabled: true,
    reverbRoom: 'room',
    reverbDecaySec: 1.8,
    reverbDampingHz: 6000,
    reverbBassMult: 1,
    reverbPredelayMs: 20,
    reverbSize: 1,
    reverbAttack: 0.3,
    reverbDiffusionEarly: 0.65,
    reverbDiffusionLate: 0.5,
    reverbModRateHz: 0.3,
    reverbModDepth: 0.4,
    reverbEqLowCutHz: 20,
    reverbEqHighCutHz: 16000,
    reverbColor: 'modern',
    bpm: 120,
};
/**
 * Migra o array de camadas do Rack salvo de uma sessão anterior pra sempre
 * ter: (1) RACK_LAYER_COUNT entradas (ex.: sessões de antes do Rack passar a
 * ter 6 camadas, era 4) — completando o restante com camadas vazias, nunca
 * descartando configuração do usuário; e (2) todos os campos conhecidos de
 * RackLayer presentes em cada camada, mesclando com os padrões de
 * emptyRackLayer() por cima dos dados salvos — necessário pra sessões salvas
 * antes de um novo efeito existir (ex.: reverb/compressor/delay por camada)
 * não ficarem com `undefined` nesses campos, o que quebraria o grafo de
 * áudio (valores inválidos em GainNode.gain etc.).
 */
function migrateRackLayers(layers) {
    const trimmed = layers.slice(0, exports.RACK_LAYER_COUNT);
    const merged = trimmed.map((layer, i) => ({
        ...emptyRackLayer(layer?.id ?? `camada-${i + 1}`, layer?.color ?? '#888888'),
        ...layer,
    }));
    for (let i = merged.length; i < exports.RACK_LAYER_COUNT; i++) {
        merged.push(exports.DEFAULT_RACK_STATE.layers[i] ?? emptyRackLayer(`camada-${i + 1}`, '#888888'));
    }
    return merged;
}
exports.DEFAULT_SETTINGS = {
    outputDeviceId: null,
    outputChannelCount: 2,
    sampleRate: 48000,
    bufferSize: 480,
    click: {
        countInBars: 1,
        sound: 'beep',
        accentFirstBeat: true,
        volumeDb: 0,
        output: 'auto',
        doubleClick: 'off',
    },
    pad: {
        timbre: null,
        volumeDb: 0,
        exitOnPlay: true,
        output: 'stereo-1-2',
        fadeInOutSec: 1.5,
        keyChangeCrossfadeSec: 1.5,
        loopCrossfadeSec: 6,
    },
    remote: {
        enabled: true,
        port: 8787,
        pin: '0000',
    },
    osc: {
        enabled: false,
        listenPort: 9000,
        sendHost: '127.0.0.1',
        sendPort: 9001,
    },
    sync: {
        enabled: false,
        role: 'leader',
        port: 8788,
    },
    midiBindings: [],
    guideVoice: {
        track: null,
        outOfOrderBehavior: 'keep',
    },
    stageMode: false,
    rack: exports.DEFAULT_RACK_STATE,
    speech: {
        enabled: false,
    },
};
exports.PART_COLORS = {
    Intro: '#2f6f6a',
    Verso: '#2d5fa0',
    'Pré-refrão': '#6b4fa0',
    Refrão: '#a0304f',
    Instrumental: '#2f8f5a',
    Ponte: '#7c4fe0',
    Solo: '#c07a1f',
    Tag: '#45708f',
    Interlúdio: '#4f6b7c',
    Final: '#5c5c66',
    Outra: '#555566',
};
exports.NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// Paleta vibrante pra grade de pads da Camada PAD (um tom por semitom da
// oitava, repetindo um conjunto de cores vivas) — usada só na UI da camada
// especial de pads, não tem relação com PART_COLORS (que é pra partes de
// música, tons mais discretos).
exports.RACK_PAD_NOTE_COLORS = [
    '#e0b43c', // C
    '#a97ee0', // C#
    '#e05a6e', // D
    '#e08a3c', // D#
    '#4fb86a', // E
    '#e0b43c', // F
    '#4fc9c2', // F#
    '#e0608a', // G
    '#7e8ee0', // G#
    '#e08a3c', // A
    '#4fb86a', // A#
    '#a97ee0', // B
];
function semitoneDistance(fromKey, toKey) {
    const from = exports.NOTE_NAMES.indexOf(normalizeNote(fromKey));
    const to = exports.NOTE_NAMES.indexOf(normalizeNote(toKey));
    if (from < 0 || to < 0)
        return 0;
    let diff = to - from;
    if (diff > 6)
        diff -= 12;
    if (diff < -6)
        diff += 12;
    return diff;
}
function normalizeNote(note) {
    const map = {
        Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#',
        'C♭': 'B', 'E♯': 'F', 'B♯': 'C', 'F♭': 'E',
    };
    return map[note] ?? note;
}
//# sourceMappingURL=types.js.map