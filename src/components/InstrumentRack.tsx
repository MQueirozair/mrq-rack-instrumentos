import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  AudioLines,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  FolderSearch,
  Image as ImageIcon,
  Piano,
  Plus,
  RotateCcw,
  X as XIcon,
} from 'lucide-react';
import { useStore } from '../state/useStore';
import type {
  RackArpDivision,
  RackArpPattern,
  RackCharacter,
  RackDelayDivision,
  RackDelayFilterType,
  RackDriveType,
  RackLayer,
  RackLayerFormat,
  RackOctaverMode,
  RackReverbRoom,
  RackReverbColor,
  RackScene,
  RackVelocityCurve,
} from '../../shared/types';
import { defaultRackEqBands, migrateRackLayers, RACK_PAD_LAYER_INDEX, RACK_PAD_NOTE_COLORS } from '../../shared/types';
import { rackEngine, detectRackFormat, PITCH_BEND_RANGE_SEMITONES, reverbModePreset } from '../audio/rack/RackEngine';
import { applyLayerParamsToEngine, reloadAllRackLayers, reloadLayerFromDisk as reloadLayerFromDiskShared } from '../audio/rack/rackReload';
import { onRackProgramChange, onRackRawNoteOn, computeVelocityCurve } from '../midi/rackMidiRouter';
import TransportBar from './TransportBar';
import PartsGrid from './PartsGrid';
import RackEqGraph from './RackEqGraph';
import RackKnob from './RackKnob';
import RackFxModule from './RackFxModule';

/**
 * Manda o erro completo (nome/mensagem/stack) pro log de diagnóstico em
 * disco (mesmo mecanismo do ErrorBoundary — ver mrq-debug.log), além do
 * toast resumido que o usuário já vê na tela. Sem isso, um erro ao carregar
 * um instrumento (ex.: WebKit antigo sem algum recurso de áudio) só aparece
 * resumido no toast — útil pro usuário, mas insuficiente pra diagnosticar à
 * distância sem pedir pro usuário abrir o Inspetor Web (que nem sempre dá
 * certo). Com isso, o próximo "mrq-debug.log" que o usuário mandar já traz o
 * erro técnico completo de qualquer tentativa de carregar um instrumento.
 */
function logInstrumentError(context: string, err: unknown) {
  const e = err instanceof Error ? err : new Error(String(err));
  console.error(`[InstrumentRack] ${context}:`, e);
  try {
    void window.api?.log?.append?.(`[InstrumentRack] ${context}: ${e.name}: ${e.message}\n${e.stack ?? ''}`);
  } catch {
    /* noop — não deixar o próprio log quebrar o fluxo de erro */
  }
}

const DEFAULT_LAYER_FX: Partial<RackLayer> = {
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
  eqBands: defaultRackEqBands(),
  driveEnabled: false,
  driveType: 'warm',
  driveDb: 0,
  driveMix: 1,
  reverbEnabled: true,
  reverbSend: 1,
  compressorEnabled: false,
  compressorAmount: 0.4,
  compressorAttackMs: 8,
  compressorReleaseMs: 140,
  delayEnabled: false,
  delayTimeMs: 300,
  delayFeedback: 0.3,
  delayMix: 0.35,
  delaySync: false,
  delayDivision: '1/8',
  delayPingPong: false,
  chorusEnabled: false,
  chorusMix: 0.25,
  tremoloEnabled: false,
  tremoloRateHz: 4,
  tremoloDepth: 0.5,
  tremoloStereo: 0,
  octaverEnabled: false,
  octaverMode: 'down',
  octaverMix: 0.7,
  pan: 0,
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

const ARP_DIVISION_OPTIONS: { value: RackArpDivision; label: string }[] = [
  { value: '1/4', label: '1/4' },
  { value: '1/8', label: '1/8' },
  { value: '1/8t', label: '1/8 triplet' },
  { value: '1/16', label: '1/16' },
  { value: '1/16t', label: '1/16 triplet' },
  { value: '1/32', label: '1/32' },
];

const ARP_PATTERN_OPTIONS: { value: RackArpPattern; label: string }[] = [
  { value: 'up', label: 'Subindo' },
  { value: 'down', label: 'Descendo' },
  { value: 'updown', label: 'Sobe-desce' },
  { value: 'downup', label: 'Desce-sobe' },
  { value: 'order', label: 'Ordem tocada' },
  { value: 'random', label: 'Aleatório' },
  { value: 'chord', label: 'Acorde' },
];

const DELAY_DIVISION_OPTIONS: { value: RackDelayDivision; label: string }[] = [
  { value: '1/16', label: '1/16' },
  { value: '1/8t', label: '1/8 triplet' },
  { value: '1/8', label: '1/8' },
  { value: '1/8d', label: '1/8 pontuada' },
  { value: '1/4', label: '1/4' },
  { value: '1/4d', label: '1/4 pontuada' },
  { value: '1/2', label: '1/2' },
];

const REVERB_ROOM_OPTIONS: { value: RackReverbRoom; label: string; hint: string }[] = [
  { value: 'room', label: 'Room', hint: 'Sala pequena/média — ambiência natural, de uso geral.' },
  { value: 'stage', label: 'Stage', hint: 'Palco de médio/grande porte — mais aberto, bom pra banda ao vivo.' },
  { value: 'hall', label: 'Hall', hint: 'Salão grande — cauda longa e cheia, mais \"igreja/teatro\".' },
  { value: 'booth', label: 'Booth', hint: 'Cabine isolada — bem curto e seco, quase sem cauda.' },
  { value: 'plate', label: 'Plate', hint: 'Placa metálica — brilhante e denso, clássico de estúdio.' },
  { value: 'spring', label: 'Spring', hint: 'Mola (amp de guitarra) — com uma leve trepidação característica.' },
];

const OCTAVER_MODE_OPTIONS: { value: RackOctaverMode; label: string }[] = [
  { value: 'down', label: '-1 oitava' },
  { value: 'up', label: '+1 oitava' },
  { value: 'both', label: 'Ambas' },
];

const CHARACTER_OPTIONS: { value: RackCharacter; label: string }[] = [
  { value: 'original', label: 'Original' },
  { value: 'soft', label: 'Soft' },
  { value: 'bright', label: 'Bright' },
  { value: 'warm', label: 'Warm' },
];

const DRIVE_TYPE_OPTIONS: { value: RackDriveType; label: string }[] = [
  { value: 'warm', label: 'Warm / suave' },
  { value: 'hard', label: 'Hard / agressivo' },
  { value: 'tube', label: 'Tube / válvula' },
];

const FORMAT_BADGE: Record<RackLayerFormat, string> = {
  sf2: 'SOUNDFONT / SF2',
  dx7: 'FM YAMAHA / DX7',
  sampler: 'PIANO / AMOSTRA',
  npno: 'PIANO NORD / NPNO',
  nsmp: 'AMOSTRA NORD / NSMP',
  nki: 'KONTAKT 1-4 / NKI',
  exs: 'LOGIC EXS24 / EXS',
  sfz: 'SFZ (K5-8 exportado)',
  mrqi: 'LEVE / MRQI',
  mrq: 'CONVERSOR / MRQ',
};

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function noteLabel(n: number): string {
  return `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
}

/**
 * Rack de instrumentos ao vivo: 4 camadas tocáveis simultaneamente por um
 * teclado MIDI físico conectado, cada uma carregando um arquivo de instrumento
 * real do usuário (SoundFont .sf2/.sf3, banco DX7 .syx, amostra de áudio, ou
 * biblioteca de piano Nord .npno). A configuração do teclado MIDI físico
 * (dispositivo, curva de velocidade, transposição, sustain) fica em
 * RackMidiPanel, na barra de título. O .npno é decodificado de verdade pelo
 * crate nord-format compilado pra WebAssembly — ver NpnoLayerVoice.ts.
 */
export default function InstrumentRack() {
  const rack = useStore((s) => s.settings.rack);
  const updateRack = useStore((s) => s.updateRack);
  const updateRackLayer = useStore((s) => s.updateRackLayer);
  const pushToast = useStore((s) => s.pushToast);

  const [loadingLayer, setLoadingLayer] = useState<number | null>(null);
  // Electron não implementa window.prompt() nativo no renderer (lança
  // "prompt() is and will not be supported."), então o nome da cena é pedido
  // por um modal próprio em vez do prompt() do navegador.
  const [sceneNameDraft, setSceneNameDraft] = useState<string | null>(null);
  const restoredRef = useRef(false);
  const rackRef = useRef(rack);
  rackRef.current = rack;

  useEffect(() => {
    // Aplica o tamanho de buffer salvo da sessão anterior antes do primeiro
    // "resume" (que é quem de fato cria o AudioContext) — assim a preferência
    // de latência do usuário já vale desde a primeira nota tocada.
    rackEngine.setBufferFrames(rackRef.current.bufferFrames ?? 0);
    rackEngine.resume().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Atalho de pânico: Esc para todas as notas de todas as camadas enquanto a
  // aba Rack estiver aberta — útil pra cortar rápido um som preso/travado
  // sem precisar tirar a mão do teclado físico pra clicar no botão.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') rackEngine.panic();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Program Change do teclado físico recarrega a cena salva de mesmo índice
  // (0 = primeira cena salva, 1 = segunda, ...) — pensado pra troca de
  // repertório via footswitch MIDI sem tirar a mão do teclado.
  useEffect(() => {
    const unsub = onRackProgramChange((program) => {
      const scene = rackRef.current.scenes?.[program];
      if (scene) handleLoadScene(scene);
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    rackEngine.setMasterVolume(rack.masterVolume);
  }, [rack.masterVolume]);

  useEffect(() => {
    rackEngine.setReverb(rack.reverb);
  }, [rack.reverb]);

  useEffect(() => {
    rackEngine.setReverbRoom(rack.reverbRoom);
  }, [rack.reverbRoom]);

  useEffect(() => {
    rackEngine.setReverbDecay(rack.reverbDecaySec);
  }, [rack.reverbDecaySec]);

  useEffect(() => {
    rackEngine.setReverbDamping(rack.reverbDampingHz);
  }, [rack.reverbDampingHz]);

  useEffect(() => {
    rackEngine.setReverbBassMult(rack.reverbBassMult);
  }, [rack.reverbBassMult]);

  useEffect(() => {
    rackEngine.setReverbPredelay(rack.reverbPredelayMs);
  }, [rack.reverbPredelayMs]);

  useEffect(() => {
    rackEngine.setReverbSize(rack.reverbSize);
  }, [rack.reverbSize]);

  useEffect(() => {
    rackEngine.setReverbAttack(rack.reverbAttack);
  }, [rack.reverbAttack]);

  useEffect(() => {
    rackEngine.setReverbDiffusion(rack.reverbDiffusionEarly, rack.reverbDiffusionLate);
  }, [rack.reverbDiffusionEarly, rack.reverbDiffusionLate]);

  useEffect(() => {
    rackEngine.setReverbMod(rack.reverbModRateHz, rack.reverbModDepth);
  }, [rack.reverbModRateHz, rack.reverbModDepth]);

  useEffect(() => {
    rackEngine.setReverbEq(rack.reverbEqLowCutHz, rack.reverbEqHighCutHz);
  }, [rack.reverbEqLowCutHz, rack.reverbEqHighCutHz]);

  useEffect(() => {
    rackEngine.setReverbColor(rack.reverbColor);
  }, [rack.reverbColor]);

  useEffect(() => {
    rackEngine.setBpm(rack.bpm);
  }, [rack.bpm]);

  // Restaura, uma única vez ao abrir a aba, os instrumentos que já estavam carregados da última sessão.
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    rackRef.current.layers.forEach((layer, index) => {
      applyLayerParamsToEngine(index, layer);
      if (!layer.filePath || !layer.format) return;
      reloadLayerFromDisk(index, layer.filePath, layer.format, layer).catch((err: Error) => {
        pushToast(`Não foi possível recarregar o instrumento da camada ${index + 1}: ${err.message ?? err}`, 'error');
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // applyLayerParamsToEngine e a lógica de releitura do disco agora vivem em
  // rackReload.ts (compartilhadas com o handler de troca de buffer no
  // RackMidiPanel) — aqui só embrulhamos pra manter o indicador de
  // carregamento por camada (setLoadingLayer) que já existia.
  async function reloadLayerFromDisk(index: number, filePath: string, format: RackLayerFormat, layer: RackLayer) {
    setLoadingLayer(index);
    try {
      return await reloadLayerFromDiskShared(index, filePath, format, layer);
    } finally {
      setLoadingLayer((v) => (v === index ? null : v));
    }
  }

  async function handleLoad(index: number) {
    const filePath = await window.api.fs.chooseInstrumentFile();
    if (!filePath) return;
    const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
    const detected = detectRackFormat(fileName);
    if (!detected) {
      pushToast(`Formato de arquivo não reconhecido: ${fileName}`, 'error');
      return;
    }
    const baseName = fileName.replace(/\.[^.]+$/, '');
    const draftLayer: RackLayer = {
      ...rack.layers[index],
      format: detected,
      filePath,
      fileName,
      selectedPreset: null,
      displayName: baseName,
    };
    try {
      const { presets, presetToUse } = await reloadLayerFromDisk(index, filePath, detected, draftLayer);
      updateRackLayer(index, {
        format: detected,
        filePath,
        fileName,
        displayName: baseName,
        presets,
        selectedPreset: presetToUse,
      });
    } catch (err: any) {
      logInstrumentError(`falha ao carregar "${fileName}" (formato=${detected}) na camada ${index + 1}`, err);
      pushToast(`Não foi possível carregar "${fileName}": ${err?.message ?? err}`, 'error');
    }
  }

  function handleClear(index: number) {
    rackEngine.clearLayer(index);
    updateRackLayer(index, {
      format: null,
      filePath: null,
      fileName: null,
      displayName: null,
      presets: [],
      selectedPreset: null,
    });
  }

  function handlePresetChange(index: number, value: string) {
    rackEngine.selectPreset(index, value);
    updateRackLayer(index, { selectedPreset: value });
  }

  function handleCharacterChange(index: number, character: RackCharacter) {
    rackEngine.setCharacter(index, character);
    updateRackLayer(index, { character });
  }

  function handleVolumeChange(index: number, volume: number) {
    rackEngine.setLayerVolume(index, volume);
    updateRackLayer(index, { volume });
  }

  function handleRootNoteChange(index: number, note: number) {
    rackEngine.setRootNote(index, note);
    updateRackLayer(index, { rootNote: note });
  }

  function handleToggleMute(index: number) {
    const next = !rack.layers[index].muted;
    rackEngine.setLayerMuted(index, next);
    updateRackLayer(index, { muted: next });
  }

  function handleToggleSolo(index: number) {
    const next = !rack.layers[index].solo;
    rackEngine.setLayerSolo(index, next);
    updateRackLayer(index, { solo: next });
  }

  function handleEditPatch(index: number, patch: Partial<RackLayer>) {
    const layer = { ...rack.layers[index], ...patch };
    updateRackLayer(index, patch);
    if ('noteRangeStart' in patch || 'noteRangeEnd' in patch) {
      rackEngine.setNoteRange(index, layer.noteRangeStart, layer.noteRangeEnd);
    }
    if ('octave' in patch) rackEngine.setOctave(index, layer.octave);
    if ('midiChannel' in patch) rackEngine.setMidiChannel(index, layer.midiChannel);
    if ('pan' in patch) rackEngine.setPan(index, layer.pan);
    if ('envelopeEnabled' in patch || 'attackMs' in patch || 'decayMs' in patch || 'releaseMs' in patch) {
      rackEngine.setEnvelope(index, { enabled: layer.envelopeEnabled, attackMs: layer.attackMs, decayMs: layer.decayMs, releaseMs: layer.releaseMs });
    }
    if ('playMode' in patch || 'legato' in patch || 'glideMs' in patch) {
      rackEngine.setVoiceMode(index, { playMode: layer.playMode, legato: layer.legato, glideMs: layer.glideMs });
    }
    if ('filterEnabled' in patch || 'cutoffHz' in patch) {
      rackEngine.setFilter(index, { enabled: layer.filterEnabled, cutoffHz: layer.cutoffHz });
    }
    if ('eqEnabled' in patch || 'eqBands' in patch) {
      rackEngine.setEqBands(index, layer.eqEnabled, layer.eqBands);
    }
    if ('driveEnabled' in patch || 'driveType' in patch || 'driveDb' in patch || 'driveMix' in patch) {
      rackEngine.setDrive(index, { enabled: layer.driveEnabled, type: layer.driveType, driveDb: layer.driveDb, mix: layer.driveMix });
    }
    if ('reverbEnabled' in patch || 'reverbSend' in patch) {
      rackEngine.setLayerReverb(index, { enabled: layer.reverbEnabled, send: layer.reverbSend });
    }
    if (
      'compressorEnabled' in patch ||
      'compressorAmount' in patch ||
      'compressorAttackMs' in patch ||
      'compressorReleaseMs' in patch ||
      'compressorFast' in patch
    ) {
      rackEngine.setCompressor(index, {
        enabled: layer.compressorEnabled,
        amount: layer.compressorAmount,
        attackMs: layer.compressorAttackMs,
        releaseMs: layer.compressorReleaseMs,
        fast: layer.compressorFast,
      });
    }
    if ('tremoloEnabled' in patch || 'tremoloRateHz' in patch || 'tremoloDepth' in patch || 'tremoloStereo' in patch) {
      rackEngine.setTremolo(index, {
        enabled: layer.tremoloEnabled,
        rateHz: layer.tremoloRateHz,
        depth: layer.tremoloDepth,
        stereo: layer.tremoloStereo,
      });
    }
    if ('chorusEnabled' in patch || 'chorusMix' in patch) {
      rackEngine.setChorus(index, { enabled: layer.chorusEnabled, mix: layer.chorusMix });
    }
    if (
      'delayEnabled' in patch ||
      'delayTimeMs' in patch ||
      'delayFeedback' in patch ||
      'delayMix' in patch ||
      'delaySync' in patch ||
      'delayDivision' in patch ||
      'delayPingPong' in patch ||
      'delayAnalog' in patch ||
      'delayFilterType' in patch
    ) {
      rackEngine.setDelay(index, {
        enabled: layer.delayEnabled,
        timeMs: layer.delayTimeMs,
        feedback: layer.delayFeedback,
        mix: layer.delayMix,
        sync: layer.delaySync,
        division: layer.delayDivision,
        pingPong: layer.delayPingPong,
        analog: layer.delayAnalog,
        filterType: layer.delayFilterType,
      });
    }
    if ('octaverEnabled' in patch || 'octaverMode' in patch || 'octaverMix' in patch) {
      rackEngine.setLayerOctaver(index, { enabled: layer.octaverEnabled, mode: layer.octaverMode, mix: layer.octaverMix });
    }
    if (
      'arpEnabled' in patch ||
      'arpPattern' in patch ||
      'arpSync' in patch ||
      'arpRateHz' in patch ||
      'arpDivision' in patch ||
      'arpOctaves' in patch ||
      'arpGate' in patch ||
      'arpSwing' in patch ||
      'arpLatch' in patch
    ) {
      rackEngine.setArp(index, {
        enabled: layer.arpEnabled,
        pattern: layer.arpPattern,
        sync: layer.arpSync,
        rateHz: layer.arpRateHz,
        division: layer.arpDivision,
        octaves: layer.arpOctaves,
        gate: layer.arpGate,
        swing: layer.arpSwing,
        latch: layer.arpLatch,
      });
    }
    if ('gateEnabled' in patch || 'gateThresholdDb' in patch || 'gateAttackMs' in patch || 'gateReleaseMs' in patch) {
      rackEngine.setGate(index, {
        enabled: layer.gateEnabled,
        thresholdDb: layer.gateThresholdDb,
        attackMs: layer.gateAttackMs,
        releaseMs: layer.gateReleaseMs,
      });
    }
    if ('phaserEnabled' in patch || 'phaserRateHz' in patch || 'phaserDepth' in patch || 'phaserMix' in patch) {
      rackEngine.setPhaser(index, {
        enabled: layer.phaserEnabled,
        rateHz: layer.phaserRateHz,
        depth: layer.phaserDepth,
        mix: layer.phaserMix,
      });
    }
    if ('flangerEnabled' in patch || 'flangerRateHz' in patch || 'flangerDepth' in patch || 'flangerFeedback' in patch || 'flangerMix' in patch) {
      rackEngine.setFlanger(index, {
        enabled: layer.flangerEnabled,
        rateHz: layer.flangerRateHz,
        depth: layer.flangerDepth,
        feedback: layer.flangerFeedback,
        mix: layer.flangerMix,
      });
    }
    if ('bitcrusherEnabled' in patch || 'bitcrusherBits' in patch || 'bitcrusherRateHz' in patch || 'bitcrusherMix' in patch) {
      rackEngine.setBitcrusher(index, {
        enabled: layer.bitcrusherEnabled,
        bits: layer.bitcrusherBits,
        rateHz: layer.bitcrusherRateHz,
        mix: layer.bitcrusherMix,
      });
    }
    if (
      'shimmerEnabled' in patch ||
      'shimmerMix' in patch ||
      'shimmerFeedback' in patch ||
      'shimmerToneHz' in patch ||
      'shimmerShiftSemitones' in patch ||
      'shimmerDiffusion' in patch ||
      'shimmerSize' in patch ||
      'shimmerLowCutHz' in patch ||
      'shimmerModRateHz' in patch ||
      'shimmerModDepth' in patch ||
      'shimmerReverbMode' in patch ||
      'shimmerPitchMode' in patch
    ) {
      rackEngine.setShimmer(index, {
        enabled: layer.shimmerEnabled,
        mix: layer.shimmerMix,
        feedback: layer.shimmerFeedback,
        toneHz: layer.shimmerToneHz,
        shiftSemitones: layer.shimmerShiftSemitones,
        diffusion: layer.shimmerDiffusion,
        size: layer.shimmerSize,
        lowCutHz: layer.shimmerLowCutHz,
        modRateHz: layer.shimmerModRateHz,
        modDepth: layer.shimmerModDepth,
        reverbMode: layer.shimmerReverbMode,
        pitchMode: layer.shimmerPitchMode,
        color: layer.shimmerColor,
      });
    }
  }

  // Clona a configuração inteira de uma camada (instrumento + todos os
  // ajustes do painel Editar) para outra — útil pra empilhar o mesmo
  // instrumento duas vezes com um "Caráter"/EQ diferente em cada camada, sem
  // ter que carregar o arquivo de novo na mão.
  async function handleDuplicateLayer(sourceIndex: number, targetIndex: number) {
    const source = rack.layers[sourceIndex];
    const target = rack.layers[targetIndex];
    const cloned: RackLayer = { ...source, id: target.id, color: target.color };
    updateRackLayer(targetIndex, cloned);
    if (source.filePath && source.format) {
      try {
        await reloadLayerFromDisk(targetIndex, source.filePath, source.format, cloned);
      } catch (err: any) {
        logInstrumentError(`falha ao duplicar instrumento da camada ${sourceIndex + 1} pra ${targetIndex + 1} (formato=${source.format})`, err);
        pushToast(`Não foi possível duplicar o instrumento: ${err?.message ?? err}`, 'error');
        return;
      }
    } else {
      rackEngine.clearLayer(targetIndex);
      applyLayerParamsToEngine(targetIndex, cloned);
    }
    pushToast(`Camada ${sourceIndex + 1} duplicada para a camada ${targetIndex + 1}.`);
  }

  // --- cenas: fotografia completa das 4 camadas + master/reverb, salva com
  // nome pra recall rápido ao vivo (manual ou por Program Change MIDI) ---

  function handleSaveScene() {
    setSceneNameDraft(`Cena ${(rack.scenes?.length ?? 0) + 1}`);
  }

  function confirmSaveScene(name: string) {
    const trimmed = name.trim();
    setSceneNameDraft(null);
    if (!trimmed) return;
    const scene: RackScene = {
      id: `scene-${Date.now()}`,
      name: trimmed,
      layers: rack.layers.map((l) => ({ ...l })),
      masterVolume: rack.masterVolume,
      reverb: rack.reverb,
    };
    updateRack({ scenes: [...(rack.scenes ?? []), scene] });
    pushToast(`Cena "${trimmed}" salva (PC ${rack.scenes?.length ?? 0} no teclado físico).`);
  }

  async function handleLoadScene(scene: RackScene) {
    // migrateRackLayers preenche o oitavador (e qualquer outro campo novo)
    // com padrão seguro em cenas salvas antes desses recursos existirem.
    const layers = migrateRackLayers(scene.layers.map((l) => ({ ...l })));
    updateRack({ layers, masterVolume: scene.masterVolume, reverb: scene.reverb });
    rackEngine.setMasterVolume(scene.masterVolume);
    rackEngine.setReverb(scene.reverb);
    await reloadAllRackLayers(layers, (index, err) => {
      const message = err instanceof Error ? err.message : String(err);
      logInstrumentError(`falha ao recarregar instrumento da camada ${index + 1} ao carregar a cena "${scene.name}"`, err);
      pushToast(`Não foi possível recarregar o instrumento da camada ${index + 1} da cena: ${message}`, 'error');
    });
    pushToast(`Cena "${scene.name}" carregada.`);
  }

  function handleDeleteScene(id: string) {
    updateRack({ scenes: (rack.scenes ?? []).filter((s) => s.id !== id) });
  }

  return (
    <div className="rack-page-outer">
    <div className="rack-page">
      {rack.layers.map((layer, index) =>
        index === RACK_PAD_LAYER_INDEX ? (
          <RackPadLayerCard
            key={layer.id}
            layer={layer}
            index={index}
            bpm={rack.bpm}
            loading={loadingLayer === index}
            onLoad={() => handleLoad(index)}
            onClear={() => handleClear(index)}
            onPresetChange={(v) => handlePresetChange(index, v)}
            onCharacterChange={(c) => handleCharacterChange(index, c)}
            onVolumeChange={(v) => handleVolumeChange(index, v)}
            onRootNoteChange={(n) => handleRootNoteChange(index, n)}
            onToggleMute={() => handleToggleMute(index)}
            onToggleSolo={() => handleToggleSolo(index)}
            onEditPatch={(patch) => handleEditPatch(index, patch)}
            otherLayers={rack.layers.map((l, i) => ({ index: i, label: `Camada ${i + 1}` })).filter((l) => l.index !== index)}
            onDuplicateTo={(targetIndex) => handleDuplicateLayer(index, targetIndex)}
          />
        ) : (
          <LayerCard
            key={layer.id}
            layer={layer}
            index={index}
            bpm={rack.bpm}
            loading={loadingLayer === index}
            onLoad={() => handleLoad(index)}
            onClear={() => handleClear(index)}
            onPresetChange={(v) => handlePresetChange(index, v)}
            onCharacterChange={(c) => handleCharacterChange(index, c)}
            onVolumeChange={(v) => handleVolumeChange(index, v)}
            onRootNoteChange={(n) => handleRootNoteChange(index, n)}
            onToggleMute={() => handleToggleMute(index)}
            onToggleSolo={() => handleToggleSolo(index)}
            onEditPatch={(patch) => handleEditPatch(index, patch)}
            otherLayers={rack.layers.map((l, i) => ({ index: i, label: `Camada ${i + 1}` })).filter((l) => l.index !== index)}
            onDuplicateTo={(targetIndex) => handleDuplicateLayer(index, targetIndex)}
          />
        )
      )}

      <MasterColumn
        masterVolume={rack.masterVolume}
        reverb={rack.reverb}
        reverbRoom={rack.reverbRoom}
        reverbDecaySec={rack.reverbDecaySec}
        reverbDampingHz={rack.reverbDampingHz}
        reverbBassMult={rack.reverbBassMult}
        reverbPredelayMs={rack.reverbPredelayMs}
        reverbSize={rack.reverbSize}
        reverbAttack={rack.reverbAttack}
        reverbDiffusionEarly={rack.reverbDiffusionEarly}
        reverbDiffusionLate={rack.reverbDiffusionLate}
        reverbModRateHz={rack.reverbModRateHz}
        reverbModDepth={rack.reverbModDepth}
        reverbEqLowCutHz={rack.reverbEqLowCutHz}
        reverbEqHighCutHz={rack.reverbEqHighCutHz}
        reverbColor={rack.reverbColor}
        bpm={rack.bpm}
        transpose={rack.transpose}
        onMasterVolumeChange={(v) => updateRack({ masterVolume: v })}
        onReverbChange={(v) => updateRack({ reverb: v })}
        onReverbRoomChange={(v) => {
          // Mode/SELECT — aplica o preset inteiro (Size/Diffusion/Damping/Mod)
          // no RackState de uma vez, pra UI e motor de áudio nunca ficarem
          // dessincronizados (ver RackEngine.setReverbRoom).
          const preset = reverbModePreset(v);
          updateRack({
            reverbRoom: v,
            reverbSize: preset.size,
            reverbDiffusionEarly: preset.diffusionEarly,
            reverbDiffusionLate: preset.diffusionLate,
            reverbDampingHz: preset.dampingHz,
            reverbModRateHz: preset.modRateHz,
            reverbModDepth: preset.modDepth,
          });
        }}
        onReverbDecayChange={(v) => updateRack({ reverbDecaySec: v })}
        onReverbDampingChange={(v) => updateRack({ reverbDampingHz: v })}
        onReverbBassMultChange={(v) => updateRack({ reverbBassMult: v })}
        onReverbPredelayChange={(v) => updateRack({ reverbPredelayMs: v })}
        onReverbSizeChange={(v) => updateRack({ reverbSize: v })}
        onReverbAttackChange={(v) => updateRack({ reverbAttack: v })}
        onReverbDiffusionEarlyChange={(v) => updateRack({ reverbDiffusionEarly: v })}
        onReverbDiffusionLateChange={(v) => updateRack({ reverbDiffusionLate: v })}
        onReverbModRateChange={(v) => updateRack({ reverbModRateHz: v })}
        onReverbModDepthChange={(v) => updateRack({ reverbModDepth: v })}
        onReverbEqLowCutChange={(v) => updateRack({ reverbEqLowCutHz: v })}
        onReverbEqHighCutChange={(v) => updateRack({ reverbEqHighCutHz: v })}
        onReverbColorChange={(v) => updateRack({ reverbColor: v })}
        onBpmChange={(v) => updateRack({ bpm: v })}
        onTransposeChange={(v) => updateRack({ transpose: v })}
        onPanic={() => rackEngine.panic()}
        scenes={rack.scenes ?? []}
        onSaveScene={handleSaveScene}
        onLoadScene={handleLoadScene}
        onDeleteScene={handleDeleteScene}
      />
    </div>
    <RackMusicPanel />
    <RackKeyboardStrip layers={rack.layers} />
    {sceneNameDraft !== null && (
      <SceneNameModal initialName={sceneNameDraft} onConfirm={confirmSaveScene} onCancel={() => setSceneNameDraft(null)} />
    )}
    </div>
  );
}

function SceneNameModal({
  initialName,
  onConfirm,
  onCancel,
}: {
  initialName: string;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div className="rack-modal-overlay" onClick={onCancel}>
      <div className="rack-modal" onClick={(e) => e.stopPropagation()}>
        <div className="rack-modal-title">Salvar cena</div>
        <input
          ref={inputRef}
          type="text"
          className="rack-modal-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onConfirm(name);
            if (e.key === 'Escape') onCancel();
          }}
          placeholder='Nome da cena (ex.: "Música X — Intro")'
        />
        <div className="rack-modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancelar
          </button>
          <button type="button" className="btn primary" onClick={() => onConfirm(name)}>
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}

function LayerCard({
  layer,
  index,
  bpm,
  loading,
  onLoad,
  onClear,
  onPresetChange,
  onCharacterChange,
  onVolumeChange,
  onRootNoteChange,
  onToggleMute,
  onToggleSolo,
  onEditPatch,
  otherLayers,
  onDuplicateTo,
}: {
  layer: RackLayer;
  index: number;
  bpm: number;
  loading: boolean;
  onLoad: () => void;
  onClear: () => void;
  onPresetChange: (value: string) => void;
  onCharacterChange: (c: RackCharacter) => void;
  onVolumeChange: (v: number) => void;
  onRootNoteChange: (n: number) => void;
  onToggleMute: () => void;
  onToggleSolo: () => void;
  onEditPatch: (patch: Partial<RackLayer>) => void;
  otherLayers: { index: number; label: string }[];
  onDuplicateTo: (targetIndex: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const hasInstrument = !!layer.format;

  return (
    <div className="rack-layer-card" style={{ ['--layer-color' as any]: layer.color }}>
      <div className="rack-layer-header">
        <span className="rack-layer-title">CAMADA {String(index + 1).padStart(2, '0')}</span>
        <div className="rack-ms-buttons">
          <button className={`mute ${layer.muted ? 'on' : ''}`} onClick={onToggleMute} title="Mudo">
            M
          </button>
          <button className={`solo ${layer.solo ? 'on' : ''}`} onClick={onToggleSolo} title="Solo">
            S
          </button>
        </div>
      </div>

      <div className="rack-layer-art" style={layer.photoDataUrl ? { backgroundImage: `url(${layer.photoDataUrl})` } : undefined}>
        {!layer.photoDataUrl &&
          (loading ? (
            <span style={{ fontSize: 11, color: 'var(--text-2)' }}>Carregando…</span>
          ) : hasInstrument ? (
            layer.format === 'dx7' ? <AudioLines size={30} /> : <Piano size={30} />
          ) : (
            <Plus size={26} />
          ))}
      </div>

      <div className="rack-format-badge">{layer.format ? FORMAT_BADGE[layer.format] : 'PRONTA PARA O SEU SOM'}</div>
      <div className="rack-instrument-name">{layer.displayName ?? 'Adicione um timbre'}</div>

      <div className="rack-field">
        <label>Instrumento</label>
        <select
          value={layer.selectedPreset ?? ''}
          disabled={!layer.presets.length}
          onChange={(e) => onPresetChange(e.target.value)}
        >
          {layer.presets.length === 0 ? (
            <option value="">{layer.format === 'sampler' ? 'Amostra única' : 'Nenhum banco carregado'}</option>
          ) : (
            layer.presets.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))
          )}
        </select>
      </div>

      <div className="rack-field">
        <label>Caráter</label>
        <select value={layer.character} onChange={(e) => onCharacterChange(e.target.value as RackCharacter)}>
          {CHARACTER_OPTIONS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </div>

      <div className="rack-fader-row">
        <div className="rack-fader-ticks">
          <span>100</span>
          <span>75</span>
          <span>50</span>
          <span>25</span>
          <span>0</span>
        </div>
        <input
          className="rack-fader"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={layer.volume}
          onChange={(e) => onVolumeChange(Number(e.target.value))}
        />
        <button className="btn rack-edit-btn" onClick={() => setEditing(true)}>
          Editar
        </button>
      </div>
      <div className="rack-volume-value">{layer.volume.toFixed(2)}</div>
      <div className="rack-volume-label">Volume</div>
      <LayerMeter index={index} active={hasInstrument} />

      <div className="rack-bottom-row">
        <button className="btn rack-load-btn" onClick={onLoad}>
          Carregar
        </button>
        <button className="btn rack-x-btn" onClick={onClear} title="Remover instrumento desta camada">
          <XIcon size={14} strokeWidth={2.5} />
        </button>
      </div>

      {editing && (
        <LayerEditPanel
          layer={layer}
          index={index}
          bpm={bpm}
          onClose={() => setEditing(false)}
          onPatch={onEditPatch}
          onRootNoteChange={onRootNoteChange}
          otherLayers={otherLayers}
          onDuplicateTo={onDuplicateTo}
        />
      )}
    </div>
  );
}

// Ordem cromática das 12 pads da Camada PAD (uma oitava: C até B).
const PAD_SEMITONES = Array.from({ length: 12 }, (_, i) => i);

/**
 * Camada especial nº 8 do Rack: em vez do formulário tradicional
 * (instrumento/caráter/fader só), mostra uma grade colorida de 12 pads —
 * uma oitava cromática completa — pra tocar com o mouse/touch sem precisar
 * de teclado MIDI físico nem da tira de teclas virtual compartilhada.
 * Aceita carregar qualquer formato suportado pelas outras 7 camadas (usa o
 * mesmo RackEngine por baixo) e cada pad dispara só nesta camada, ignorando
 * o filtro de faixa de notas configurado nela (rackEngine.noteOnLayer /
 * noteOffLayer), já que o clique deve soar sempre, independente do split.
 */
function RackPadLayerCard({
  layer,
  index,
  bpm,
  loading,
  onLoad,
  onClear,
  onPresetChange,
  onCharacterChange,
  onVolumeChange,
  onRootNoteChange,
  onToggleMute,
  onToggleSolo,
  onEditPatch,
  otherLayers,
  onDuplicateTo,
}: {
  layer: RackLayer;
  index: number;
  bpm: number;
  loading: boolean;
  onLoad: () => void;
  onClear: () => void;
  onPresetChange: (value: string) => void;
  onCharacterChange: (c: RackCharacter) => void;
  onVolumeChange: (v: number) => void;
  onRootNoteChange: (n: number) => void;
  onToggleMute: () => void;
  onToggleSolo: () => void;
  onEditPatch: (patch: Partial<RackLayer>) => void;
  otherLayers: { index: number; label: string }[];
  onDuplicateTo: (targetIndex: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [octave, setOctave] = useState(0);
  const [activePads, setActivePads] = useState<Set<number>>(new Set());
  const hasInstrument = !!layer.format;
  const draggingRef = useRef<{ pointerId: number; semitone: number; note: number; downAt: number } | null>(null);
  // Guarda um timer de liberação "adiada" quando o toque foi curto demais pra
  // cruzar PAD_MIN_FLASH_MS (ver releaseDraggingPad) — cancelado se o MESMO
  // pad for pressionado de novo antes dele disparar (toque repetido rápido).
  const pendingReleaseRef = useRef<{ semitone: number; note: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const baseNote = 60 + octave * 12; // C4 = 60, desloca por oitava

  function markPad(semitone: number, on: boolean) {
    setActivePads((prev) => {
      const next = new Set(prev);
      if (on) next.add(semitone);
      else next.delete(semitone);
      return next;
    });
  }

  function pressPad(semitone: number, e: React.PointerEvent<HTMLButtonElement>) {
    e.preventDefault();
    const note = Math.max(0, Math.min(127, baseNote + semitone));
    // Havia uma liberação adiada pendente (ver releaseDraggingPad/
    // PAD_MIN_FLASH_MS) de um toque anterior ainda não concluído — o
    // usuário tocou de novo antes dela rodar (ex.: "tocando bateria" nos
    // pads rapidamente). BUG CORRIGIDO: antes esse timer só era cancelado
    // (clearTimeout) sem nunca mandar o noteOffLayer() da nota ANTIGA —
    // isso deixava a nota anterior tocando pra sempre por baixo da nova
    // (nunca recebia note-off nenhum), empilhando vozes e dando a sensação
    // de "o som trava"/engasga ao tocar os pads rápido, algo que não
    // existia antes do PAD_MIN_FLASH_MS (cada toque soltava a nota na
    // hora). Agora, ao cancelar o timer, a liberação pendente é executada
    // IMEDIATAMENTE (soltando a nota antiga de verdade) antes de disparar
    // a nova — nunca deixa um note-on duplicado sem seu note-off.
    if (pendingReleaseRef.current) {
      clearTimeout(pendingReleaseRef.current.timer);
      const pending = pendingReleaseRef.current;
      pendingReleaseRef.current = null;
      markPad(pending.semitone, false);
      rackEngine.noteOffLayer(index, pending.note);
    }
    draggingRef.current = { pointerId: e.pointerId, semitone, note, downAt: performance.now() };
    markPad(semitone, true);
    rackEngine.noteOnLayer(index, note, 100);
    // Captura o pointer NESTE botão: sem isso, a animação de "afundar" do
    // pad ativo (.rack-pad-btn.active desloca/encolhe com translateY+scale)
    // move o botão por baixo de um cursor/dedo parado, e o menor tremor do
    // mouse dispara um pointerleave quase instantâneo — que soltava a nota
    // e tirava a classe "active" tão rápido que o pad parecia nunca acender
    // (o bug reportado: "quando clico nos pads eles não ficam ativos").
    // Com o pointer capturado aqui, pointerup/pointercancel continuam
    // chegando neste elemento (e no listener global logo abaixo) não
    // importa pra onde o cursor se mova visualmente — soltar só acontece
    // quando o usuário de fato solta o botão/dedo.
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  // Tempo mínimo (ms) que um toque no pad fica "aceso"/soando, mesmo que o
  // clique real (pointerdown -> pointerup) dure bem menos que isso — um
  // clique de mouse comum costuma durar uns 50-100ms, tempo curto demais pra
  // (a) o olho perceber o pad "acender" (reportado: "o pad não fica aceso
  // como um play") e (b) muitos instrumentos (ex.: amostras de violão/cordas
  // com ataque+corpo) soarem por inteiro antes do note-off cortar o
  // envelope quase no nascedouro (reportado junto: "o pad não aciona direto
  // quando clica" — o som saía cortado/fraco demais pra perceber). Dispara
  // o note-on imediatamente como sempre; só ADIA o note-off (e o apagar
  // visual) até esse mínimo passar, nunca o encurta.
  const PAD_MIN_FLASH_MS = 150;

  function releaseDraggingPad() {
    const d = draggingRef.current;
    if (!d) return;
    draggingRef.current = null;
    const elapsed = performance.now() - d.downAt;
    const remaining = PAD_MIN_FLASH_MS - elapsed;
    if (remaining > 0) {
      const timer = setTimeout(() => {
        markPad(d.semitone, false);
        rackEngine.noteOffLayer(index, d.note);
        pendingReleaseRef.current = null;
      }, remaining);
      pendingReleaseRef.current = { semitone: d.semitone, note: d.note, timer };
    } else {
      markPad(d.semitone, false);
      rackEngine.noteOffLayer(index, d.note);
    }
  }

  useEffect(() => {
    function onUp(e: PointerEvent) {
      if (draggingRef.current?.pointerId !== e.pointerId) return;
      releaseDraggingPad();
    }
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, octave]);

  // Solta/zera tudo se a camada mudar de instrumento ou o componente sumir,
  // pra nunca deixar nota entalada tocando pra sempre.
  useEffect(() => () => {
    rackEngine.panicLayer(index);
    // Evita um setTimeout de release adiada (ver PAD_MIN_FLASH_MS) disparar
    // depois que o componente já sumiu/trocou de camada.
    if (pendingReleaseRef.current) {
      clearTimeout(pendingReleaseRef.current.timer);
      pendingReleaseRef.current = null;
    }
  }, [index]);

  function bumpOctave(delta: number) {
    setOctave((o) => Math.max(-3, Math.min(3, o + delta)));
  }

  return (
    <div className="rack-layer-card rack-pad-layer-card" style={{ ['--layer-color' as any]: layer.color }}>
      <div className="rack-layer-header">
        <span className="rack-layer-title">CAMADA {String(index + 1).padStart(2, '0')} · PAD</span>
        <div className="rack-ms-buttons">
          <button className={`mute ${layer.muted ? 'on' : ''}`} onClick={onToggleMute} title="Mudo">
            M
          </button>
          <button className={`solo ${layer.solo ? 'on' : ''}`} onClick={onToggleSolo} title="Solo">
            S
          </button>
        </div>
      </div>

      <div className="rack-pad-instrument-row">
        <div className="rack-pad-instrument-info">
          <div className="rack-format-badge">{layer.format ? FORMAT_BADGE[layer.format] : 'PRONTA PARA O SEU SOM'}</div>
          <div className="rack-instrument-name">{layer.displayName ?? 'Adicione um timbre'}</div>
        </div>
        {layer.presets.length > 1 && (
          <select
            className="rack-pad-preset-select"
            value={layer.selectedPreset ?? ''}
            onChange={(e) => onPresetChange(e.target.value)}
            title="Instrumento/preset carregado"
          >
            {layer.presets.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        )}
        <div className="rack-pad-instrument-btns">
          <button className="btn rack-load-btn" onClick={onLoad} disabled={loading}>
            {loading ? 'Carregando…' : 'Carregar'}
          </button>
          <button className="btn rack-x-btn" onClick={onClear} title="Remover instrumento desta camada">
            <XIcon size={14} strokeWidth={2.5} />
          </button>
        </div>
      </div>

      <div className="rack-pad-main">
        <div className="rack-pad-grid-wrap">
          <div className="rack-pad-octave-row">
            <button className="rack-pad-octave-btn" onClick={() => bumpOctave(-1)} disabled={octave <= -3} title="Oitava abaixo">
              −
            </button>
            <span>Oitava {octave >= 0 ? `+${octave}` : octave} ({noteLabel(baseNote)})</span>
            <button className="rack-pad-octave-btn" onClick={() => bumpOctave(1)} disabled={octave >= 3} title="Oitava acima">
              +
            </button>
          </div>
          <div className="rack-pad-grid">
            {PAD_SEMITONES.map((semitone) => {
              const note = Math.max(0, Math.min(127, baseNote + semitone));
              return (
                <button
                  key={semitone}
                  className={`rack-pad-btn ${activePads.has(semitone) ? 'active' : ''}`}
                  style={{ ['--pad-color' as any]: RACK_PAD_NOTE_COLORS[semitone] }}
                  onPointerDown={(e) => pressPad(semitone, e)}
                  onPointerUp={releaseDraggingPad}
                  // SEM onPointerLeave soltando a nota de propósito: com o
                  // pointer capturado em pressPad acima, soltar aqui ao
                  // simples "sair" do botão reativava o bug (ver comentário
                  // em pressPad) — o pointerup/pointercancel global (useEffect
                  // logo acima) já garante que a nota para quando o usuário
                  // solta de verdade, não importa onde o cursor esteja.
                  onLostPointerCapture={() => {
                    // Rede de segurança: se o sistema tirar a captura do
                    // pointer por algum motivo (troca de janela/app no meio
                    // do toque, por exemplo), solta a nota em vez de deixar
                    // tocando pra sempre.
                    if (draggingRef.current?.semitone === semitone) releaseDraggingPad();
                  }}
                  title={`Tocar ${noteLabel(note)}`}
                >
                  {NOTE_NAMES[semitone]}
                </button>
              );
            })}
          </div>
        </div>

        <div className="rack-pad-side">
          <div className="rack-fader-row">
            <input
              className="rack-fader"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={layer.volume}
              onChange={(e) => onVolumeChange(Number(e.target.value))}
            />
          </div>
          <div className="rack-volume-value">{layer.volume.toFixed(2)}</div>
          <div className="rack-volume-label">Volume</div>
          <button className="btn rack-edit-btn" onClick={() => setEditing(true)}>
            Editar
          </button>
        </div>
      </div>

      <LayerMeter index={index} active={hasInstrument} />

      <button className="rack-pad-stop-btn" onClick={() => rackEngine.panicLayer(index)} title="Parar todas as notas desta camada">
        PARAR
      </button>

      {editing && (
        <LayerEditPanel
          layer={layer}
          index={index}
          bpm={bpm}
          onClose={() => setEditing(false)}
          onPatch={onEditPatch}
          onRootNoteChange={onRootNoteChange}
          otherLayers={otherLayers}
          onDuplicateTo={onDuplicateTo}
        />
      )}
    </div>
  );
}

/**
 * Painel de música dentro da aba Rack: deixa tocar/pausar/parar a música do
 * Setlist e pular entre as partes sem precisar sair pra aba de reprodução —
 * essencial pra quem está tocando ao vivo usando os instrumentos do Rack mas
 * ainda precisa comandar a faixa/backing track. Reaproveita TransportBar e
 * PartsGrid (mesmos componentes da aba de reprodução) e tem botão próprio
 * pra minimizar e economizar espaço de tela.
 */
function RackMusicPanel() {
  const currentSong = useStore((s) => s.currentSong);
  const engineState = useStore((s) => s.engineState);
  const jumpToPart = useStore((s) => s.jumpToPart);
  const toggleLoopActivePart = useStore((s) => s.toggleLoopActivePart);
  // Começa minimizado: quem abre o Rack geralmente quer ver as camadas de
  // instrumento primeiro — o painel de música ocupa bastante espaço vertical
  // e fica vazio até carregar algo no Setlist, então é mais útil começar
  // fechado e deixar quem precisa dele abrir com 1 clique (ver o botão
  // collapsed/ChevronUp/ChevronDown logo abaixo).
  const [collapsed, setCollapsed] = useState(true);

  return (
    <div className={`rack-music-panel ${collapsed ? 'collapsed' : ''}`}>
      <div className="rack-strip-header">
        <span className="rack-strip-title">
          <Piano size={14} /> Música {currentSong ? `— ${currentSong.title}` : ''}
        </span>
        <button
          className="rack-strip-toggle"
          title={collapsed ? 'Mostrar controles de música' : 'Minimizar controles de música'}
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
      </div>
      {!collapsed &&
        (currentSong ? (
          <div className="rack-music-panel-body">
            <TransportBar />
            <PartsGrid
              song={currentSong}
              activePartId={engineState.activePartId}
              pendingPartId={engineState.pendingPartId}
              loopActive={engineState.loopActivePart}
              onJump={(id) => jumpToPart(id)}
              onToggleLoop={() => toggleLoopActivePart()}
            />
          </div>
        ) : (
          <div className="rack-music-panel-empty">Nenhuma música carregada no Setlist.</div>
        ))}
    </div>
  );
}

const KEYBOARD_LOW = 21; // A0
const KEYBOARD_HIGH = 108; // C8 (piano de 88 teclas)
const KEYBOARD_TOTAL = KEYBOARD_HIGH - KEYBOARD_LOW + 1;
function isBlackKey(note: number) {
  return [1, 3, 6, 8, 10].includes(note % 12);
}

// Posicionamento proporcional de piano de verdade: as teclas brancas dividem
// a largura total em partes iguais; as pretas são mais estreitas e ficam
// centradas sobre a divisa entre as duas brancas vizinhas (nunca do mesmo
// tamanho/alinhamento das brancas — era isso que deixava o teclado antigo
// com cara de "blocos" desalinhados).
const ALL_KEYBOARD_NOTES = Array.from({ length: KEYBOARD_TOTAL }, (_, i) => KEYBOARD_LOW + i);
const WHITE_KEY_NOTES = ALL_KEYBOARD_NOTES.filter((n) => !isBlackKey(n));
const WHITE_KEY_COUNT = WHITE_KEY_NOTES.length;
const WHITE_KEY_INDEX = new Map(WHITE_KEY_NOTES.map((n, i) => [n, i]));
const WHITE_KEY_WIDTH_PCT = 100 / WHITE_KEY_COUNT;
const BLACK_KEY_WIDTH_PCT = WHITE_KEY_WIDTH_PCT * 0.62;

function keyPositionPct(note: number): { leftPct: number; widthPct: number } {
  if (!isBlackKey(note)) {
    const idx = WHITE_KEY_INDEX.get(note) ?? 0;
    return { leftPct: idx * WHITE_KEY_WIDTH_PCT, widthPct: WHITE_KEY_WIDTH_PCT };
  }
  // A tecla preta fica sempre logo após uma branca (note - 1), centrada na divisa.
  const prevWhiteIdx = WHITE_KEY_INDEX.get(note - 1) ?? 0;
  const boundaryPct = (prevWhiteIdx + 1) * WHITE_KEY_WIDTH_PCT;
  return { leftPct: boundaryPct - BLACK_KEY_WIDTH_PCT / 2, widthPct: BLACK_KEY_WIDTH_PCT };
}

// Mapa "digitação musical" (estilo GarageBand): cada tecla do teclado físico
// do computador toca uma nota relativa a Dó central (MIDI 60), pra quem não
// tem um controlador MIDI por perto. Z/X descem/sobem uma oitava (atalho
// clássico, igual ao GarageBand/vários softwares de piano virtual).
const QWERTY_NOTE_OFFSETS: Record<string, number> = {
  a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11,
  k: 12, o: 13, l: 14, p: 15, ';': 16,
};
const QWERTY_BASE_NOTE = 60; // C4

// Amostra a curva de velocidade configurada em alguns pontos pra desenhar a
// mini curva do painel (eixo X = força do toque 0→127, eixo Y = velocity
// resultante, invertido porque SVG cresce pra baixo).
function velocityCurvePolyline(curve: RackVelocityCurve, w: number, h: number): string {
  const steps = 12;
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const raw = Math.max(1, Math.round((i / steps) * 127));
    const out = computeVelocityCurve(curve, raw) / 127;
    pts.push(`${((i / steps) * w).toFixed(1)},${(h - out * h).toFixed(1)}`);
  }
  return pts.join(' ');
}

/**
 * Tira de teclado virtual: mostra as faixas de nota configuradas em cada
 * camada (barra colorida embaixo das teclas), acende em tempo real as notas
 * que estão soando (teclado físico conectado OU tocadas aqui) e é
 * genuinamente tocável — clique/arraste o mouse pelas teclas (a posição
 * vertical do clique define a força/velocity, igual um teclado sensível ao
 * toque) ou use o teclado do computador (digitação musical estilo
 * GarageBand). Também expõe TOM (pitch bend) e MOD (vibrato), oitava e
 * pânico, reaproveitando o motor de áudio real (rackEngine). As teclas são
 * posicionadas em porcentagem (brancas = divisões iguais, pretas = mais
 * estreitas e centradas na divisa entre duas brancas), igual um piano real.
 */
function RackKeyboardStrip({ layers }: { layers: RackLayer[] }) {
  const rack = useStore((s) => s.settings.rack);
  const updateRack = useStore((s) => s.updateRack);
  const rackRef = useRef(rack);
  rackRef.current = rack;

  const keyRefs = useRef<(HTMLDivElement | null)[]>([]);
  // Começa minimizado pelo mesmo motivo do RackMusicPanel acima: o teclado
  // virtual ocupa bastante espaço vertical e nem todo mundo usa ele — melhor
  // começar fechado e deixar 1 clique pra abrir quando precisar.
  const [collapsed, setCollapsed] = useState(true);
  const [tomValue, setTomValue] = useState(0);
  const [modValue, setModValue] = useState(0);
  const tomRef = useRef(0);
  const modRef = useRef(0);
  const vibratoRunningRef = useRef(false);
  const draggingNoteRef = useRef<number | null>(null);
  const draggingPointerIdRef = useRef<number | null>(null);
  const qwertyNotesRef = useRef<Map<string, number>>(new Map());
  const [engineStatus, setEngineStatus] = useState({ sampleRate: null as number | null, running: false });

  // Pisca o status do motor de áudio (taxa de amostragem / rodando ou não)
  // uma vez por segundo — não precisa de mais que isso, é só informativo.
  useEffect(() => {
    const id = setInterval(() => {
      setEngineStatus({ sampleRate: rackEngine.getSampleRate(), running: rackEngine.isRunning() });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let raf = 0;
    let lastFrame = 0;
    let lastActive = new Set<number>();
    function tick(now: number) {
      if (now - lastFrame > 60) {
        lastFrame = now;
        const active = new Set(rackEngine.getActiveNotesSnapshot());
        if (active.size !== lastActive.size || [...active].some((n) => !lastActive.has(n))) {
          for (let note = KEYBOARD_LOW; note <= KEYBOARD_HIGH; note++) {
            const el = keyRefs.current[note - KEYBOARD_LOW];
            if (el) el.classList.toggle('rack-key-active', active.has(note));
          }
          lastActive = active;
        }
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  function bumpTranspose(deltaOctaves: number) {
    const next = Math.max(-24, Math.min(24, rackRef.current.transpose + deltaOctaves * 12));
    updateRack({ transpose: next });
  }

  function setKeyPressedVisual(note: number, pressed: boolean) {
    const el = keyRefs.current[note - KEYBOARD_LOW];
    if (el) el.classList.toggle('rack-key-pressed', pressed);
  }

  function velocityFromClientY(keyEl: HTMLElement, clientY: number): number {
    const rect = keyEl.getBoundingClientRect();
    const t = rect.height > 0 ? Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)) : 0.75;
    const raw = Math.max(1, Math.min(127, Math.round(1 + t * 126)));
    return computeVelocityCurve(rackRef.current.velocityCurve, raw);
  }

  function findKeyElement(target: Element | null): { note: number; el: HTMLElement } | null {
    const el = target?.closest<HTMLElement>('[data-note]') ?? null;
    if (!el) return null;
    const note = Number(el.dataset.note);
    if (!Number.isFinite(note)) return null;
    return { note, el };
  }

  function playKey(note: number, el: HTMLElement, clientY: number) {
    const velocity = velocityFromClientY(el, clientY);
    const played = Math.max(0, Math.min(127, note + rackRef.current.transpose));
    rackEngine.noteOn(played, velocity);
    draggingNoteRef.current = played;
    setKeyPressedVisual(note, true);
  }

  function releaseDraggingKey() {
    if (draggingNoteRef.current !== null) {
      rackEngine.noteOff(draggingNoteRef.current);
      draggingNoteRef.current = null;
    }
    for (let note = KEYBOARD_LOW; note <= KEYBOARD_HIGH; note++) setKeyPressedVisual(note, false);
  }

  function handleKeysPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const hit = findKeyElement(e.target as Element);
    if (!hit) return;
    e.preventDefault();
    draggingPointerIdRef.current = e.pointerId;
    playKey(hit.note, hit.el, e.clientY);
  }

  // Arrastar o mouse/dedo pelas teclas com o botão pressionado faz glissando
  // (desliza de uma nota pra outra sem precisar soltar e clicar de novo),
  // igual um teclado de verdade. Ouvido em nível de window pra funcionar
  // mesmo que o ponteiro saia da área do componente durante o arraste.
  useEffect(() => {
    function onMove(e: PointerEvent) {
      if (draggingPointerIdRef.current === null || e.pointerId !== draggingPointerIdRef.current) return;
      const hit = findKeyElement(document.elementFromPoint(e.clientX, e.clientY));
      if (!hit) return;
      const played = Math.max(0, Math.min(127, hit.note + rackRef.current.transpose));
      if (played === draggingNoteRef.current) return;
      if (draggingNoteRef.current !== null) rackEngine.noteOff(draggingNoteRef.current);
      for (let note = KEYBOARD_LOW; note <= KEYBOARD_HIGH; note++) setKeyPressedVisual(note, false);
      playKey(hit.note, hit.el, e.clientY);
    }
    function onUp(e: PointerEvent) {
      if (draggingPointerIdRef.current === null || e.pointerId !== draggingPointerIdRef.current) return;
      draggingPointerIdRef.current = null;
      releaseDraggingKey();
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, []);

  function releaseAllQwerty() {
    for (const note of qwertyNotesRef.current.values()) rackEngine.noteOff(note);
    qwertyNotesRef.current.clear();
  }

  // Digitação musical: só funciona com o foco dentro do teclado (precisa
  // clicar nele primeiro), pra não brigar com os atalhos globais do app
  // (espaço = tocar/pausar, L = loop, setas = navegar partes etc.) — uma vez
  // com foco, para (stopPropagation) as teclas que a digitação musical usa.
  function handleKeysKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const key = e.key.toLowerCase();
    if (key === 'z') { e.stopPropagation(); e.preventDefault(); bumpTranspose(-1); return; }
    if (key === 'x') { e.stopPropagation(); e.preventDefault(); bumpTranspose(1); return; }
    if (!(key in QWERTY_NOTE_OFFSETS)) return;
    e.stopPropagation();
    e.preventDefault();
    if (e.repeat || qwertyNotesRef.current.has(key)) return;
    const note = Math.max(0, Math.min(127, QWERTY_BASE_NOTE + QWERTY_NOTE_OFFSETS[key] + rackRef.current.transpose));
    const velocity = computeVelocityCurve(rackRef.current.velocityCurve, 100);
    rackEngine.noteOn(note, velocity);
    qwertyNotesRef.current.set(key, note);
    setKeyPressedVisual(note - rackRef.current.transpose, true);
  }

  function handleKeysKeyUp(e: React.KeyboardEvent<HTMLDivElement>) {
    const key = e.key.toLowerCase();
    const note = qwertyNotesRef.current.get(key);
    if (note !== undefined) {
      e.stopPropagation();
      rackEngine.noteOff(note);
      qwertyNotesRef.current.delete(key);
      setKeyPressedVisual(note - rackRef.current.transpose, false);
    }
  }

  // Se o foco sair do teclado (ou o componente desmontar) com alguma tecla
  // ainda "presa", solta tudo — evita nota entalada tocando pra sempre.
  function handleKeysBlur() {
    releaseAllQwerty();
    releaseDraggingKey();
  }
  useEffect(() => () => { releaseAllQwerty(); releaseDraggingKey(); }, []);

  function ensureVibratoLoop() {
    if (vibratoRunningRef.current) return;
    vibratoRunningRef.current = true;
    const start = performance.now();
    function tick(now: number) {
      const t = (now - start) / 1000;
      const vibrato = modRef.current > 0 ? Math.sin(t * 2 * Math.PI * 5.5) * modRef.current * 0.12 : 0;
      const combined = Math.max(-1, Math.min(1, tomRef.current + vibrato));
      rackEngine.setPitchBend(combined);
      if (tomRef.current === 0 && modRef.current === 0) {
        vibratoRunningRef.current = false;
        rackEngine.setPitchBend(0);
        return;
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function handleTomChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = Number(e.target.value);
    tomRef.current = v;
    setTomValue(v);
    ensureVibratoLoop();
  }
  function resetTom() {
    if (tomRef.current === 0) return;
    tomRef.current = 0;
    setTomValue(0);
    ensureVibratoLoop();
  }
  function handleModChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = Number(e.target.value);
    modRef.current = v;
    setModValue(v);
    ensureVibratoLoop();
  }

  function handlePanic() {
    rackEngine.panic();
    releaseAllQwerty();
    releaseDraggingKey();
    resetTom();
  }

  const loadedLayers = layers.filter((l) => l.format);
  const whiteKeys = ALL_KEYBOARD_NOTES.filter((n) => !isBlackKey(n));
  const blackKeys = ALL_KEYBOARD_NOTES.filter((n) => isBlackKey(n));
  const cNotes = ALL_KEYBOARD_NOTES.filter((n) => n % 12 === 0);
  const octaveLabel = noteLabel(Math.max(0, Math.min(127, KEYBOARD_LOW + rack.transpose)));
  const bufferLabel = rack.bufferFrames > 0 ? `${rack.bufferFrames} amostras` : 'automático';
  const curveLabel: Record<RackVelocityCurve, string> = {
    linear: 'Linear', soft: 'Suave', hard: 'Dura',
  };

  return (
    <div className={`rack-keyboard-strip ${collapsed ? 'collapsed' : ''}`}>
      <div className="rack-strip-header">
        <span className="rack-strip-title">
          <Piano size={14} /> Teclado virtual
        </span>
        <button
          className="rack-strip-toggle"
          title={collapsed ? 'Mostrar teclado virtual' : 'Minimizar teclado virtual'}
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
      </div>
      {!collapsed && (
        <div className="rack-keyboard-body">
          <div className="rack-keyboard-main-row">
            <div className="rack-keyboard-velocity-panel">
              <label className="rack-keyboard-mini-label">Curva de velocidade</label>
              <select
                className="rack-keyboard-select"
                value={rack.velocityCurve}
                onChange={(e) => updateRack({ velocityCurve: e.target.value as RackVelocityCurve })}
              >
                {(['linear', 'soft', 'hard'] as RackVelocityCurve[]).map((c) => (
                  <option key={c} value={c}>{curveLabel[c]}</option>
                ))}
              </select>
              <svg className="rack-velocity-graph" viewBox="0 0 56 28" preserveAspectRatio="none">
                <polyline points={velocityCurvePolyline(rack.velocityCurve, 56, 28)} />
              </svg>
            </div>
            <div className="rack-keyboard-wheels">
              <div className="rack-wheel-col">
                <input
                  type="range"
                  className="rack-wheel rack-wheel-tom"
                  min={-1}
                  max={1}
                  step={0.01}
                  value={tomValue}
                  onChange={handleTomChange}
                  onPointerUp={resetTom}
                  onMouseUp={resetTom}
                  onTouchEnd={resetTom}
                  onBlur={resetTom}
                  title="TOM (pitch bend) — volta ao centro ao soltar"
                />
                <span className="rack-keyboard-mini-label">TOM</span>
              </div>
              <div className="rack-wheel-col">
                <input
                  type="range"
                  className="rack-wheel rack-wheel-mod"
                  min={0}
                  max={1}
                  step={0.01}
                  value={modValue}
                  onChange={handleModChange}
                  title="MOD (vibrato) — mantém a posição ao soltar"
                />
                <span className="rack-keyboard-mini-label">MOD</span>
              </div>
            </div>
            <div className="rack-keyboard-keys-wrap">
              <div
                className="rack-keyboard-keys"
                tabIndex={0}
                onPointerDown={handleKeysPointerDown}
                onKeyDown={handleKeysKeyDown}
                onKeyUp={handleKeysKeyUp}
                onBlur={handleKeysBlur}
                title="Clique/arraste pra tocar, ou toque pelo teclado do computador"
              >
                {whiteKeys.map((note) => {
                  const { leftPct, widthPct } = keyPositionPct(note);
                  return (
                    <div
                      key={note}
                      ref={(el) => (keyRefs.current[note - KEYBOARD_LOW] = el)}
                      data-note={note}
                      className="rack-key rack-key-white"
                      style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                      title={noteLabel(note)}
                    />
                  );
                })}
                {blackKeys.map((note) => {
                  const { leftPct, widthPct } = keyPositionPct(note);
                  return (
                    <div
                      key={note}
                      ref={(el) => (keyRefs.current[note - KEYBOARD_LOW] = el)}
                      data-note={note}
                      className="rack-key rack-key-black"
                      style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                      title={noteLabel(note)}
                    />
                  );
                })}
              </div>
              <div className="rack-keyboard-note-labels">
                {cNotes.map((note) => {
                  const { leftPct, widthPct } = keyPositionPct(note);
                  return (
                    <span key={note} className="rack-keyboard-note-tick" style={{ left: `${leftPct + widthPct / 2}%` }}>
                      {noteLabel(note)}
                    </span>
                  );
                })}
              </div>
              <div className="rack-keyboard-ranges">
                {loadedLayers.map((layer) => {
                  const start = Math.max(KEYBOARD_LOW, layer.noteRangeStart);
                  const end = Math.min(KEYBOARD_HIGH, layer.noteRangeEnd);
                  if (end < start) return null;
                  const startPos = keyPositionPct(start);
                  const endPos = keyPositionPct(end);
                  const leftPct = startPos.leftPct;
                  const widthPct = endPos.leftPct + endPos.widthPct - startPos.leftPct;
                  return (
                    <div
                      key={layer.id}
                      className="rack-key-range"
                      style={{ left: `${leftPct}%`, width: `${widthPct}%`, background: layer.color }}
                      title={`Faixa da ${layer.id}`}
                    />
                  );
                })}
              </div>
            </div>
            <div className="rack-keyboard-side-controls">
              <button className="rack-keyboard-octave-btn" onClick={() => bumpTranspose(1)} title="Oitava acima">
                OITAVA +
              </button>
              <div className="rack-keyboard-note-badge">{octaveLabel}</div>
              <button className="rack-keyboard-octave-btn" onClick={() => bumpTranspose(-1)} title="Oitava abaixo">
                OITAVA -
              </button>
              <button className="rack-keyboard-panic-btn" onClick={handlePanic} title="Para todas as notas e zera o TOM">
                PÂNICO
              </button>
            </div>
          </div>
          <div className="rack-keyboard-hint">
            Clique ou arraste nas teclas pra tocar (a altura do clique define a força) — ou clique no teclado e
            toque pelo computador: A S D F G H J K L (brancas), W E T Y U O P (pretas), Z/X = oitava.
          </div>
          <div className="rack-keyboard-status">
            Motor: Web Audio · {engineStatus.sampleRate ? `${engineStatus.sampleRate.toLocaleString('pt-BR')} Hz` : '—'} ·
            buffer {bufferLabel} · {engineStatus.running ? 'ativo' : 'em espera'} · pitch bend ±{PITCH_BEND_RANGE_SEMITONES} st
          </div>
        </div>
      )}
    </div>
  );
}

/** Medidor de nível (VU) ao vivo de uma camada — lê o pico real do áudio que está saindo dela, ~20x/s. */
function LayerMeter({ index, active }: { index: number; active: boolean }) {
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let lastFrame = 0;
    function tick(now: number) {
      // ~20fps é mais que suficiente pra um medidor visual, evita trabalho à toa
      if (now - lastFrame > 45) {
        lastFrame = now;
        const level = rackEngine.getLayerLevel(index);
        const pct = Math.min(100, Math.round(Math.sqrt(level) * 100));
        if (barRef.current) barRef.current.style.width = `${pct}%`;
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [index, active]);

  return (
    <div className="rack-vu-track" title="Nível de saída desta camada">
      <div ref={barRef} className="rack-vu-fill" style={{ width: '0%' }} />
    </div>
  );
}

/** Medidor de "GR" (redução de ganho) do compressor desta camada — mostra visualmente o quanto ele está atuando agora. */
function CompressorMeter({ index, active }: { index: number; active: boolean }) {
  const [reductionDb, setReductionDb] = useState(0);

  useEffect(() => {
    if (!active) {
      setReductionDb(0);
      return;
    }
    let raf = 0;
    let lastFrame = 0;
    function tick(now: number) {
      if (now - lastFrame > 60) {
        lastFrame = now;
        setReductionDb(rackEngine.getCompressorReductionDb(index));
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [index, active]);

  const pct = Math.min(100, Math.round((Math.abs(reductionDb) / 24) * 100));
  return (
    <div className="rack-field">
      <label>GR {reductionDb.toFixed(1)} dB</label>
      <div className="rack-vu-track rack-gr-track">
        <div className="rack-vu-fill rack-gr-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Mostra visualmente se a porta do Gate desta camada está aberta (deixando passar) ou fechada (silenciando) agora. */
function GateMeter({ index, active }: { index: number; active: boolean }) {
  const [openAmount, setOpenAmount] = useState(1);

  useEffect(() => {
    if (!active) {
      setOpenAmount(1);
      return;
    }
    let raf = 0;
    let lastFrame = 0;
    function tick(now: number) {
      if (now - lastFrame > 60) {
        lastFrame = now;
        setOpenAmount(rackEngine.getGateOpenAmount(index));
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [index, active]);

  return (
    <div className="rack-field">
      <label>{openAmount > 0.5 ? 'Aberto' : 'Fechado'}</label>
      <div className="rack-vu-track rack-gr-track">
        <div className="rack-vu-fill" style={{ width: `${Math.round(openAmount * 100)}%`, background: openAmount > 0.5 ? '#4fae5e' : '#555' }} />
      </div>
    </div>
  );
}

function LayerEditPanel({
  layer,
  index,
  bpm,
  onClose,
  onPatch,
  onRootNoteChange,
  otherLayers,
  onDuplicateTo,
}: {
  layer: RackLayer;
  index: number;
  bpm: number;
  onClose: () => void;
  onPatch: (patch: Partial<RackLayer>) => void;
  onRootNoteChange: (n: number) => void;
  otherLayers: { index: number; label: string }[];
  onDuplicateTo: (targetIndex: number) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [learningRange, setLearningRange] = useState(false);
  const learnBoundsRef = useRef<{ min: number; max: number } | null>(null);

  // "TAP" do Delay (igual ao botão da foto de referência): cada clique guarda
  // o instante; com 2+ cliques recentes (menos de 2s entre eles), a média dos
  // intervalos vira o novo Tempo do eco — e desliga o Sync, já que tap manual
  // só faz sentido no modo "tempo livre" (ms fixos, não ligado ao BPM).
  const delayTapTimesRef = useRef<number[]>([]);
  function handleDelayTap() {
    const now = performance.now();
    const times = delayTapTimesRef.current;
    if (times.length > 0 && now - times[times.length - 1] > 2000) times.length = 0;
    times.push(now);
    if (times.length > 5) times.shift();
    if (times.length >= 2) {
      const intervals = times.slice(1).map((t, i) => t - times[i]);
      const avgMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      onPatch({ delayTimeMs: Math.round(Math.min(1500, Math.max(10, avgMs)) / 10) * 10, delaySync: false });
    }
  }

  function choosePhoto() {
    fileInputRef.current?.click();
  }

  // "Aprender faixa": arma um modo de escuta por alguns segundos — a menor e
  // maior tecla física tocada nesse intervalo vira a faixa de notas da
  // camada, bem mais rápido que arrastar os dois controles deslizantes.
  useEffect(() => {
    if (!learningRange) return;
    learnBoundsRef.current = null;
    const unsub = onRackRawNoteOn((note) => {
      const cur = learnBoundsRef.current;
      learnBoundsRef.current = cur ? { min: Math.min(cur.min, note), max: Math.max(cur.max, note) } : { min: note, max: note };
    });
    const timeout = setTimeout(() => {
      setLearningRange(false);
      const bounds = learnBoundsRef.current;
      if (bounds) onPatch({ noteRangeStart: bounds.min, noteRangeEnd: bounds.max });
    }, 6000);
    return () => {
      unsub();
      clearTimeout(timeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [learningRange]);

  function onPhotoSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onPatch({ photoDataUrl: String(reader.result) });
    reader.readAsDataURL(file);
  }

  const [exportingMrqi, setExportingMrqi] = useState(false);
  const [resolvingSamples, setResolvingSamples] = useState(false);
  // `unresolvedSamples` mora na instância mutável de NkiLayerVoice (via
  // rackEngine.getLayerUnresolvedSamples), não no estado React/Zustand da
  // camada — este contador só existe pra forçar um novo render deste painel
  // depois de `resolveMissingSamples` mexer nos buffers em memória, já que
  // nada que o React observa (props/estado) muda sozinho nesse momento.
  const [unresolvedRefreshTick, setUnresolvedRefreshTick] = useState(0);
  const unresolvedSamples = layer.format === 'nki' || layer.format === 'exs' ? rackEngine.getLayerUnresolvedSamples(index) : null;
  const missingCount = unresolvedSamples?.filter((u) => u.reason === 'not-found').length ?? 0;

  /** Pede ao usuário a pasta-raiz de uma biblioteca de amostras e tenta
   *  resolver com ela as amostras deste .nki/.exs que não foram encontradas
   *  ao lado do arquivo original (ver NkiLayerVoice.resolveFromLibraryRoot/
   *  ExsLayerVoice.resolveFromLibraryRoot) — mesmo comportamento de
   *  recuperação que o Mixer Pro oferece pra biblioteca Kontakt "fora do
   *  lugar", reimplementado aqui sem usar nenhum código dele. */
  async function resolveMissingSamples() {
    setResolvingSamples(true);
    try {
      const folder = await window.api.fs.chooseFolder('Escolher a pasta raiz da biblioteca de amostras');
      if (!folder) return;
      const result = await rackEngine.resolveLayerSamplesFromFolder(index, folder);
      setUnresolvedRefreshTick((n) => n + 1);
      if (!result) {
        window.alert('Não há nenhum instrumento Kontakt (.nki) ou EXS24 (.exs) carregado nesta camada.');
      } else if (result.resolved === 0) {
        window.alert(
          `Nenhuma das ${result.stillUnresolved} amostra(s) faltante(s) foi encontrada nessa pasta. Confira se é a pasta raiz certa da biblioteca (ela é varrida recursivamente).`
        );
      } else if (result.stillUnresolved === 0) {
        window.alert(`Todas as ${result.resolved} amostra(s) faltante(s) foram encontradas e carregadas.`);
      } else {
        window.alert(`${result.resolved} amostra(s) encontrada(s) nessa pasta; ${result.stillUnresolved} ainda faltam.`);
      }
    } catch (err) {
      window.alert(`Falha ao procurar as amostras: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setResolvingSamples(false);
    }
  }

  /** Converte o instrumento Kontakt (.nki) desta camada pra `.mrqi` — o
   *  formato leve e nativo do Rack (ver mrqiFormat.ts/HelpPanel). Reaproveita
   *  o mapeamento de zonas/amostras já decodificado em memória por
   *  NkiLayerVoice; não reabre nada do .nki no disco. */
  async function exportToMrqi() {
    setExportingMrqi(true);
    try {
      const bytes = rackEngine.exportLayerToMrqi(index);
      if (!bytes) {
        window.alert('Não há nenhum instrumento Kontakt (.nki) carregado nesta camada pra exportar.');
        return;
      }
      const defaultName = `${(layer.displayName || layer.fileName || 'instrumento').replace(/\.[^.]+$/, '')}.mrqi`;
      const saved = await window.api.fs.saveBinaryFile({ defaultName, data: bytes });
      if (saved) window.alert(`Instrumento exportado: ${saved}\n\nCarregue este arquivo .mrqi em qualquer camada pra abrir bem mais rápido da próxima vez.`);
    } catch (err) {
      window.alert(`Falha ao exportar: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExportingMrqi(false);
    }
  }

  return (
    <div className="rack-edit-overlay" onClick={onClose}>
      <div className="rack-edit-panel card" onClick={(e) => e.stopPropagation()}>
        <div className="rack-edit-panel-header">
          <span>CAMADA {String(index + 1).padStart(2, '0')} / AJUSTES</span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {(layer.format === 'nki' || layer.format === 'exs') && missingCount > 0 && (
              <button
                className="rack-edit-close"
                onClick={resolveMissingSamples}
                disabled={resolvingSamples}
                title={`${missingCount} amostra(s) deste instrumento não foram encontradas — escolher a pasta raiz da biblioteca pra tentar resolver`}
              >
                <FolderSearch size={14} />
              </button>
            )}
            {layer.format === 'nki' && (
              <button
                className="rack-edit-close"
                onClick={exportToMrqi}
                disabled={exportingMrqi}
                title="Converter este instrumento Kontakt (.nki) para .mrqi — formato leve do Rack, abre bem mais rápido nas próximas vezes"
              >
                <Download size={14} />
              </button>
            )}
            <button
              className="rack-edit-close"
              onClick={() => onPatch(DEFAULT_LAYER_FX)}
              title="Resetar envelope, filtro, EQ, drive e pan pros valores padrão"
            >
              <RotateCcw size={14} />
            </button>
            <button className="rack-edit-close" onClick={onClose} title="Fechar">
              <XIcon size={16} />
            </button>
          </div>
        </div>

        <div className="rack-edit-grid">
          {/* topo-esquerda: faixa de notas, oitava, canal MIDI */}
          <div className="rack-edit-cell">
            <div className="rack-field">
              <label>Nota inicial {layer.noteRangeStart} ({noteLabel(layer.noteRangeStart)})</label>
              <input
                type="range"
                min={0}
                max={127}
                value={layer.noteRangeStart}
                onChange={(e) => onPatch({ noteRangeStart: Math.min(Number(e.target.value), layer.noteRangeEnd) })}
              />
            </div>
            <div className="rack-field">
              <label>Nota final {layer.noteRangeEnd} ({noteLabel(layer.noteRangeEnd)})</label>
              <input
                type="range"
                min={0}
                max={127}
                value={layer.noteRangeEnd}
                onChange={(e) => onPatch({ noteRangeEnd: Math.max(Number(e.target.value), layer.noteRangeStart) })}
              />
            </div>
            <button
              type="button"
              className="btn rack-learn-range-btn"
              disabled={learningRange}
              onClick={() => setLearningRange(true)}
              title="Toque a tecla mais grave e a mais aguda que essa camada deve responder, no teclado físico"
            >
              {learningRange ? 'Toque as teclas no teclado físico…' : 'Aprender faixa (toque 2 teclas)'}
            </button>
            <div className="rack-field">
              <label>Oitava {layer.octave >= 0 ? '+' : ''}{layer.octave}</label>
              <input type="range" min={-3} max={3} value={layer.octave} onChange={(e) => onPatch({ octave: Number(e.target.value) })} />
            </div>
            <div className="rack-field">
              <label>Canal MIDI (0 = todos) {layer.midiChannel}</label>
              <input
                type="range"
                min={0}
                max={16}
                value={layer.midiChannel}
                onChange={(e) => onPatch({ midiChannel: Number(e.target.value) })}
              />
            </div>
            <div className="rack-field">
              <label>Pan {layer.pan === 0 ? 'centro' : layer.pan < 0 ? `${Math.round(-layer.pan * 100)}% esq.` : `${Math.round(layer.pan * 100)}% dir.`}</label>
              <input
                type="range"
                min={-1}
                max={1}
                step={0.05}
                value={layer.pan ?? 0}
                onChange={(e) => onPatch({ pan: Number(e.target.value) })}
              />
            </div>
            {layer.format === 'sampler' && (
              <div className="rack-field">
                <label>Nota raiz da amostra ({noteLabel(layer.rootNote)})</label>
                <input type="range" min={0} max={127} value={layer.rootNote} onChange={(e) => onRootNoteChange(Number(e.target.value))} />
              </div>
            )}
          </div>

          {/* topo-direita: envelope (attack/decay/release) + filtro (cutoff) */}
          {/* Envelope (ADR) */}
          <RackFxModule title="Envelope" enabled={layer.envelopeEnabled} onToggle={(v) => onPatch({ envelopeEnabled: v })} accent="#d6b23c">
            <RackKnob label="Attack" value={layer.attackMs} min={0} max={2000} step={1} defaultValue={5} unit="ms" format={(v) => `${Math.round(v)}ms`} onChange={(v) => onPatch({ attackMs: v })} />
            <RackKnob label="Decay" value={layer.decayMs} min={0} max={3000} step={1} defaultValue={0} format={(v) => `${Math.round(v)}ms`} onChange={(v) => onPatch({ decayMs: v })} />
            <RackKnob label="Release" value={layer.releaseMs} min={0} max={5000} step={1} defaultValue={350} format={(v) => `${Math.round(v)}ms`} onChange={(v) => onPatch({ releaseMs: v })} />
          </RackFxModule>

          {/* Filtro (cutoff estático) */}
          <RackFxModule title="Filtro" enabled={layer.filterEnabled} onToggle={(v) => onPatch({ filterEnabled: v })} accent="#8a5fd6" hint="Passa-baixa: reduza os Hz pra suavizar o timbre.">
            <RackKnob label="Cutoff" value={layer.cutoffHz} min={80} max={20000} step={10} defaultValue={20000} format={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}Hz`)} onChange={(v) => onPatch({ cutoffHz: v })} />
          </RackFxModule>

          {/* modo de voz: poly/mono + legato + glide */}
          <RackFxModule
            title="Modo de voz"
            accent="#2fb8c6"
            extra={
              <div className="rack-field-label-row">
                <select value={layer.playMode} onChange={(e) => onPatch({ playMode: e.target.value as RackLayer['playMode'] })}>
                  <option value="poly">Poly</option>
                  <option value="mono">Mono</option>
                </select>
                <button
                  type="button"
                  className={`rack-fx-led-btn ${layer.legato ? 'on' : ''}`}
                  onClick={() => onPatch({ legato: !layer.legato })}
                  title={`Legato: ${layer.legato ? 'ligado' : 'desligado'} (só em modo mono)`}
                >
                  <span className="rack-fx-led" style={layer.legato ? { background: '#2fb8c6', boxShadow: '0 0 6px #2fb8c6' } : undefined} />
                  Legato
                </button>
              </div>
            }
            hint="Mono: só uma nota soa por vez (bom pra baixo/solo). Com Legato ligado, tocar uma nota nova sem soltar a anterior desliza a afinação (Glide) em vez de reatacar. Em Poly, cada nota toca numa voz independente (acordes)."
          >
            <RackKnob label="Glide" value={layer.glideMs} min={0} max={1000} step={1} defaultValue={80} format={(v) => `${Math.round(v)}ms`} onChange={(v) => onPatch({ glideMs: v })} />
          </RackFxModule>

          {/* EQ paramétrico de 6 bandas — gráfico interativo (RackEqGraph.tsx) */}
          <div className="rack-edit-cell rack-edit-cell-wide rack-fx-module rack-fx-module-wide is-on">
            <div className="rack-fx-screw rack-fx-screw-tl" />
            <div className="rack-fx-screw rack-fx-screw-tr" />
            <div className="rack-fx-module-header">
              <span className="rack-fx-module-title">Equalizador de 6 bandas</span>
              <button type="button" className={`rack-fx-led-btn ${layer.eqEnabled ? 'on' : ''}`} onClick={() => onPatch({ eqEnabled: !layer.eqEnabled })}>
                <span className="rack-fx-led" style={layer.eqEnabled ? { background: '#4fc3dc', boxShadow: '0 0 6px #4fc3dc' } : undefined} />
                {layer.eqEnabled ? 'ON' : 'OFF'}
              </button>
            </div>
            <RackEqGraph
              layerIndex={index}
              eqEnabled={layer.eqEnabled}
              bands={layer.eqBands}
              onChangeBand={(bandIndex, patch) => {
                const bands = layer.eqBands.map((b, i) => (i === bandIndex ? { ...b, ...patch } : b));
                onPatch({ eqBands: bands });
              }}
              onToggleBand={(bandIndex) => {
                const bands = layer.eqBands.map((b, i) => (i === bandIndex ? { ...b, enabled: !b.enabled } : b));
                onPatch({ eqBands: bands });
              }}
            />
          </div>

          {/* Drive / saturação */}
          <RackFxModule
            title="Drive"
            enabled={layer.driveEnabled}
            onToggle={(v) => onPatch({ driveEnabled: v })}
            accent="#d6455d"
            extra={
              <select value={layer.driveType} onChange={(e) => onPatch({ driveType: e.target.value as RackDriveType })}>
                {DRIVE_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            }
          >
            <RackKnob label="Drive" value={layer.driveDb} min={0} max={24} step={0.5} defaultValue={0} unit="dB" format={(v) => `${v.toFixed(1)}dB`} onChange={(v) => onPatch({ driveDb: v })} accent="#d6455d" />
            <RackKnob label="Mix" value={layer.driveMix} min={0} max={1} step={0.01} defaultValue={1} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onPatch({ driveMix: v })} accent="#d6455d" />
          </RackFxModule>

          {/* foto da camada + duplicar (não é um efeito, fica numa célula simples) */}
          <div className="rack-edit-cell">
            <label style={{ fontWeight: 700 }}>Camada</label>
            <div className="rack-edit-photo-row">
              <button className="btn rack-photo-btn" onClick={choosePhoto}>
                Escolher foto
              </button>
              <button className="btn rack-photo-btn" onClick={() => onPatch({ photoDataUrl: null })}>
                Foto padrão
              </button>
              <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onPhotoSelected} />
              {layer.photoDataUrl && <ImageIcon size={14} style={{ opacity: 0.6 }} />}
            </div>
            {layer.format && (
              <div className="rack-duplicate-row">
                <span>Duplicar esta camada para:</span>
                <div className="rack-duplicate-btns">
                  {otherLayers.map((l) => (
                    <button key={l.index} type="button" className="btn rack-duplicate-btn" onClick={() => onDuplicateTo(l.index)}>
                      <Copy size={11} /> {l.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* reverb (envio por camada) */}
          <RackFxModule
            title="Reverb"
            enabled={layer.reverbEnabled}
            onToggle={(v) => onPatch({ reverbEnabled: v })}
            accent="#4fae5e"
            hint='A "sala" (Room/Hall/Plate/Spring) e a duração da cauda (Decay) ficam no MASTER, já que é um retorno compartilhado por todas as camadas — aqui é só o quanto desta camada entra nele.'
          >
            <RackKnob label="Amount" value={layer.reverbSend} min={0} max={1} step={0.01} defaultValue={1} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onPatch({ reverbSend: v })} accent="#4fae5e" />
          </RackFxModule>

          {/* compressor */}
          <RackFxModule
            title="Compressor"
            enabled={layer.compressorEnabled}
            onToggle={(v) => onPatch({ compressorEnabled: v })}
            accent="#4fc3dc"
            hint='"FAST" (igual à foto de referência): liga um ataque/soltura bem rápidos fixos (modo limitador) e desativa os knobs Attack/Release enquanto estiver ligado.'
            meter={
              <>
                <button
                  type="button"
                  className={`rack-fx-led-btn rack-fx-fast-btn ${layer.compressorFast ? 'on' : ''}`}
                  onClick={() => onPatch({ compressorFast: !layer.compressorFast })}
                  title={`Fast: ${layer.compressorFast ? 'ligado' : 'desligado'}`}
                >
                  <span className="rack-fx-led" style={layer.compressorFast ? { background: '#4fc3dc', boxShadow: '0 0 6px #4fc3dc' } : undefined} />
                  Fast
                </button>
                <CompressorMeter index={index} active={layer.compressorEnabled} />
              </>
            }
          >
            <RackKnob label="Amount" value={layer.compressorAmount} min={0} max={1} step={0.01} defaultValue={0.4} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onPatch({ compressorAmount: v })} />
            <RackKnob label="Attack" value={layer.compressorAttackMs} min={0} max={200} step={1} defaultValue={8} format={(v) => `${Math.round(v)}ms`} onChange={(v) => onPatch({ compressorAttackMs: v })} disabled={layer.compressorFast} />
            <RackKnob label="Release" value={layer.compressorReleaseMs} min={10} max={1000} step={1} defaultValue={140} format={(v) => `${Math.round(v)}ms`} onChange={(v) => onPatch({ compressorReleaseMs: v })} disabled={layer.compressorFast} />
          </RackFxModule>

          {/* gate (porta de ruído) */}
          <RackFxModule
            title="Gate"
            enabled={layer.gateEnabled}
            onToggle={(v) => onPatch({ gateEnabled: v })}
            accent="#9aa0a6"
            meter={<GateMeter index={index} active={layer.gateEnabled} />}
            hint="Silencia o sinal abaixo do Threshold — útil em captações/amostras com ruído de fundo."
          >
            <RackKnob label="Threshold" value={layer.gateThresholdDb} min={-80} max={0} step={1} defaultValue={-40} format={(v) => `${Math.round(v)}dB`} onChange={(v) => onPatch({ gateThresholdDb: v })} accent="#9aa0a6" />
            <RackKnob label="Attack" value={layer.gateAttackMs} min={0} max={100} step={1} defaultValue={5} format={(v) => `${Math.round(v)}ms`} onChange={(v) => onPatch({ gateAttackMs: v })} accent="#9aa0a6" />
            <RackKnob label="Release" value={layer.gateReleaseMs} min={10} max={1000} step={1} defaultValue={120} format={(v) => `${Math.round(v)}ms`} onChange={(v) => onPatch({ gateReleaseMs: v })} accent="#9aa0a6" />
          </RackFxModule>

          {/* tremolo (modulação de amplitude) */}
          <RackFxModule title="Tremolo" enabled={layer.tremoloEnabled} onToggle={(v) => onPatch({ tremoloEnabled: v })} accent="#d6782e">
            <RackKnob label="Rate" value={layer.tremoloRateHz} min={0.1} max={20} step={0.1} defaultValue={4} format={(v) => `${v.toFixed(1)}Hz`} onChange={(v) => onPatch({ tremoloRateHz: v })} accent="#d6782e" />
            <RackKnob label="Depth" value={layer.tremoloDepth} min={0} max={1} step={0.01} defaultValue={0.5} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onPatch({ tremoloDepth: v })} accent="#d6782e" />
            <RackKnob label="Stereo" value={layer.tremoloStereo} min={0} max={1} step={0.01} defaultValue={0} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onPatch({ tremoloStereo: v })} accent="#d6782e" />
          </RackFxModule>

          {/* phaser */}
          <RackFxModule title="Phaser" enabled={layer.phaserEnabled} onToggle={(v) => onPatch({ phaserEnabled: v })} accent="#b36bd6" hint="Filtros passa-tudo em cascata modulados por LFO — dá um giro/efeito 'swoosh' característico.">
            <RackKnob label="Rate" value={layer.phaserRateHz} min={0.02} max={8} step={0.01} defaultValue={0.5} format={(v) => `${v.toFixed(2)}Hz`} onChange={(v) => onPatch({ phaserRateHz: v })} accent="#b36bd6" />
            <RackKnob label="Depth" value={layer.phaserDepth} min={0} max={1} step={0.01} defaultValue={0.6} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onPatch({ phaserDepth: v })} accent="#b36bd6" />
            <RackKnob label="Mix" value={layer.phaserMix} min={0} max={1} step={0.01} defaultValue={0.5} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onPatch({ phaserMix: v })} accent="#b36bd6" />
          </RackFxModule>

          {/* flanger */}
          <RackFxModule title="Flanger" enabled={layer.flangerEnabled} onToggle={(v) => onPatch({ flangerEnabled: v })} accent="#5f9fd6" hint="Delay bem curto modulado + realimentação — som metálico, tipo 'jato'.">
            <RackKnob label="Rate" value={layer.flangerRateHz} min={0.02} max={5} step={0.01} defaultValue={0.25} format={(v) => `${v.toFixed(2)}Hz`} onChange={(v) => onPatch({ flangerRateHz: v })} accent="#5f9fd6" />
            <RackKnob label="Depth" value={layer.flangerDepth} min={0} max={1} step={0.01} defaultValue={0.5} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onPatch({ flangerDepth: v })} accent="#5f9fd6" />
            <RackKnob label="Feedback" value={layer.flangerFeedback} min={0} max={0.95} step={0.01} defaultValue={0.4} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onPatch({ flangerFeedback: v })} accent="#5f9fd6" />
            <RackKnob label="Mix" value={layer.flangerMix} min={0} max={1} step={0.01} defaultValue={0.5} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onPatch({ flangerMix: v })} accent="#5f9fd6" />
          </RackFxModule>

          {/* chorus */}
          <RackFxModule title="Chorus" enabled={layer.chorusEnabled} onToggle={(v) => onPatch({ chorusEnabled: v })} accent="#2fb8c6" hint="Engrossa/alarga o timbre com uma modulação sutil de afinação — útil em pads, cordas e guitarra limpa.">
            <RackKnob label="Mix" value={layer.chorusMix} min={0} max={1} step={0.01} defaultValue={0.25} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onPatch({ chorusMix: v })} accent="#2fb8c6" />
          </RackFxModule>

          {/* bitcrusher / lo-fi */}
          <RackFxModule title="Lo-Fi" enabled={layer.bitcrusherEnabled} onToggle={(v) => onPatch({ bitcrusherEnabled: v })} accent="#c67c3c" hint="Reduz bits e taxa de amostragem de propósito — timbre retrô/digital sujo.">
            <RackKnob label="Bits" value={layer.bitcrusherBits} min={1} max={16} step={1} defaultValue={12} format={(v) => `${Math.round(v)}bit`} onChange={(v) => onPatch({ bitcrusherBits: v })} accent="#c67c3c" />
            <RackKnob label="Rate" value={layer.bitcrusherRateHz} min={500} max={44100} step={100} defaultValue={44100} format={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`)} onChange={(v) => onPatch({ bitcrusherRateHz: v })} accent="#c67c3c" />
            <RackKnob label="Mix" value={layer.bitcrusherMix} min={0} max={1} step={0.01} defaultValue={1} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onPatch({ bitcrusherMix: v })} accent="#c67c3c" />
          </RackFxModule>

          {/* shimmer — controles equivalentes ao Valhalla Shimmer (Mix/Shift/Feedback/Diffusion/Size/Low Cut/High Cut/Mod Rate/Mod Depth/Reverb Mode/Pitch Mode/Color) */}
          <RackFxModule
            title="Shimmer"
            enabled={layer.shimmerEnabled}
            onToggle={(v) => onPatch({ shimmerEnabled: v })}
            accent="#d64fb0"
            hint="Pitch shifter dentro de um loop de realimentação difuso (como o Valhalla Shimmer) — desloca o sinal (Shift) e vai acumulando numa cauda etérea, diferente do Reverb (grave/sala), autocontido nesta camada."
          >
            <div className="rack-fx-knob-row">
              <RackKnob label="Mix" value={layer.shimmerMix} min={0} max={1} step={0.01} defaultValue={0.35} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onPatch({ shimmerMix: v })} accent="#d64fb0" />
              <RackKnob label="Shift" value={layer.shimmerShiftSemitones} min={-12} max={12} step={1} defaultValue={12} unit="st" onChange={(v) => onPatch({ shimmerShiftSemitones: Math.round(v) })} accent="#d64fb0" />
              <RackKnob label="Feedback" value={layer.shimmerFeedback} min={0} max={0.92} step={0.01} defaultValue={0.55} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onPatch({ shimmerFeedback: v })} accent="#d64fb0" />
            </div>
            <div className="rack-fx-knob-row">
              <RackKnob label="Diffusion" value={layer.shimmerDiffusion} min={0} max={0.9} step={0.01} defaultValue={0.6} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onPatch({ shimmerDiffusion: v })} accent="#d64fb0" />
              <RackKnob label="Size" value={layer.shimmerSize} min={0.3} max={2} step={0.01} defaultValue={1} format={(v) => `${v.toFixed(2)}x`} onChange={(v) => onPatch({ shimmerSize: v })} accent="#d64fb0" />
            </div>
            <div className="rack-fx-knob-row">
              <RackKnob label="Low Cut" value={layer.shimmerLowCutHz} min={20} max={2000} step={10} defaultValue={200} format={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}Hz`)} onChange={(v) => onPatch({ shimmerLowCutHz: v })} accent="#d64fb0" />
              <RackKnob label="High Cut" value={layer.shimmerToneHz} min={500} max={14000} step={50} defaultValue={6000} format={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}Hz`)} onChange={(v) => onPatch({ shimmerToneHz: v })} accent="#d64fb0" />
            </div>
            <div className="rack-fx-knob-row">
              <RackKnob label="Mod Rate" value={layer.shimmerModRateHz} min={0.05} max={5} step={0.01} defaultValue={0.6} unit="Hz" onChange={(v) => onPatch({ shimmerModRateHz: v })} accent="#d64fb0" />
              <RackKnob label="Mod Depth" value={layer.shimmerModDepth} min={0} max={1} step={0.01} defaultValue={0.25} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onPatch({ shimmerModDepth: v })} accent="#d64fb0" />
            </div>
            <div className="rack-toggle-label">Reverb mode</div>
            <div className="rack-toggle-row" style={{ '--toggle-accent': '#d64fb0' } as CSSProperties}>
              <button type="button" className={`rack-toggle-btn ${layer.shimmerReverbMode === 'mono' ? 'active' : ''}`} onClick={() => onPatch({ shimmerReverbMode: 'mono' })} title="Loop centralizado — artefato de pitch mais evidente, som mais 'cru'">MONO</button>
              <button type="button" className={`rack-toggle-btn ${layer.shimmerReverbMode === 'stereo' ? 'active' : ''}`} onClick={() => onPatch({ shimmerReverbMode: 'stereo' })} title="Soma um 2º canal decorrelacionado — cauda mais larga e suave">STEREO</button>
            </div>
            <div className="rack-toggle-label">Pitch mode</div>
            <div className="rack-toggle-row" style={{ '--toggle-accent': '#d64fb0' } as CSSProperties}>
              <button type="button" className={`rack-toggle-btn ${layer.shimmerPitchMode === 'single' ? 'active' : ''}`} onClick={() => onPatch({ shimmerPitchMode: 'single' })} title="Desloca só na direção de Shift — clássico Eno/Lanois">SINGLE</button>
              <button type="button" className={`rack-toggle-btn ${layer.shimmerPitchMode === 'dual' ? 'active' : ''}`} onClick={() => onPatch({ shimmerPitchMode: 'dual' })} title="Desloca pra cima E pra baixo ao mesmo tempo — mais denso/sinfônico">DUAL</button>
            </div>
            <div className="rack-toggle-label">Color</div>
            <div className="rack-toggle-row" style={{ '--toggle-accent': '#d64fb0' } as CSSProperties}>
              <button
                type="button"
                className={`rack-toggle-btn ${layer.shimmerColor === 'dark' ? 'active' : ''}`}
                onClick={() => onPatch({ shimmerColor: 'dark', shimmerLowCutHz: 350, shimmerToneHz: 3200 })}
                title="Atalho: corta mais grave e mais agudo da cauda — simula absorção de ar de espaços grandes"
              >
                DARK
              </button>
              <button
                type="button"
                className={`rack-toggle-btn ${layer.shimmerColor === 'bright' ? 'active' : ''}`}
                onClick={() => onPatch({ shimmerColor: 'bright', shimmerLowCutHz: 120, shimmerToneHz: 9500 })}
                title="Atalho: largura de banda cheia na cauda"
              >
                BRIGHT
              </button>
            </div>
          </RackFxModule>

          {/* delay (eco) */}
          <RackFxModule
            title="Delay"
            enabled={layer.delayEnabled}
            onToggle={(v) => onPatch({ delayEnabled: v })}
            accent="#4f8fae"
            hint="Tempos maiores soam como eco separado; tempos bem curtos (abaixo de ~40ms) engrossam o timbre."
            extra={
              <div className="rack-field-label-row">
                <button
                  type="button"
                  className={`rack-fx-led-btn ${layer.delaySync ? 'on' : ''}`}
                  onClick={() => onPatch({ delaySync: !layer.delaySync })}
                  title={`Sync: ${layer.delaySync ? 'ligado' : 'desligado'}${layer.delaySync ? ` (${bpm.toFixed(1)} BPM)` : ''}`}
                >
                  <span className="rack-fx-led" style={layer.delaySync ? { background: '#4f8fae', boxShadow: '0 0 6px #4f8fae' } : undefined} />
                  Sync
                </button>
                {layer.delaySync ? (
                  <select value={layer.delayDivision} onChange={(e) => onPatch({ delayDivision: e.target.value as RackDelayDivision })}>
                    {DELAY_DIVISION_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                ) : null}
                <button
                  type="button"
                  className={`rack-fx-led-btn ${layer.delayPingPong ? 'on' : ''}`}
                  onClick={() => onPatch({ delayPingPong: !layer.delayPingPong })}
                  title={`Ping-pong: ${layer.delayPingPong ? 'ligado' : 'desligado'}`}
                >
                  <span className="rack-fx-led" style={layer.delayPingPong ? { background: '#4f8fae', boxShadow: '0 0 6px #4f8fae' } : undefined} />
                  Ping-pong
                </button>
                <button
                  type="button"
                  className={`rack-fx-led-btn ${layer.delayAnalog ? 'on' : ''}`}
                  onClick={() => onPatch({ delayAnalog: !layer.delayAnalog })}
                  title={`Analog: ${layer.delayAnalog ? 'ligado' : 'desligado'} — satura a cauda + leve oscilação de afinação (wow/flutter), tipo eco de fita`}
                >
                  <span className="rack-fx-led" style={layer.delayAnalog ? { background: '#4f8fae', boxShadow: '0 0 6px #4f8fae' } : undefined} />
                  Analog
                </button>
              </div>
            }
            meter={
              <div className="rack-field-label-row rack-fx-delay-footer">
                <label className="rack-fx-filter-select">
                  <span>Filter</span>
                  <select value={layer.delayFilterType} onChange={(e) => onPatch({ delayFilterType: e.target.value as RackDelayFilterType })}>
                    <option value="off">Off</option>
                    <option value="low">Low</option>
                    <option value="high">High</option>
                    <option value="band">Band</option>
                  </select>
                </label>
                <button type="button" className="rack-fx-tap-btn" onClick={handleDelayTap} title="Tap: clique no ritmo 2x ou mais pra ajustar o Tempo do eco">
                  Tap
                </button>
              </div>
            }
          >
            {!layer.delaySync && (
              <RackKnob label="Tempo" value={layer.delayTimeMs} min={0} max={1500} step={10} defaultValue={300} format={(v) => `${Math.round(v)}ms`} onChange={(v) => onPatch({ delayTimeMs: v })} accent="#4f8fae" />
            )}
            <RackKnob label="Feedback" value={layer.delayFeedback} min={0} max={0.9} step={0.01} defaultValue={0.3} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onPatch({ delayFeedback: v })} accent="#4f8fae" />
            <RackKnob label="Mix" value={layer.delayMix} min={0} max={1} step={0.01} defaultValue={0.35} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onPatch({ delayMix: v })} accent="#4f8fae" />
          </RackFxModule>

          {/* oitavador (por camada) */}
          <RackFxModule
            title="Oitavador"
            enabled={layer.octaverEnabled}
            onToggle={(v) => onPatch({ octaverEnabled: v })}
            accent="#8a5fd6"
            hint="Dobra toda nota tocada NESTA camada numa oitava abaixo/acima, pra engrossar o timbre dela."
            extra={
              <div className="rack-octaver-modes">
                {OCTAVER_MODE_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    className={`rack-octaver-mode-btn ${layer.octaverMode === o.value ? 'on' : ''}`}
                    onClick={() => onPatch({ octaverMode: o.value })}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            }
          >
            <RackKnob label="Mix" value={layer.octaverMix} min={0} max={1} step={0.01} defaultValue={0.7} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onPatch({ octaverMix: v })} accent="#8a5fd6" />
          </RackFxModule>

          {/* arpejador (por camada) */}
          <RackFxModule
            title="Arpejador"
            enabled={layer.arpEnabled}
            onToggle={(v) => onPatch({ arpEnabled: v })}
            accent="#4a7fd6"
            wide
            hint="Com o arpejador ligado, o modo de voz (Poly/Mono/Legato) e o oitavador desta camada não se aplicam — segure um acorde e o arpejador decide quando/quais notas soam."
            extra={
              <div className="rack-field-label-row">
                <select value={layer.arpPattern} onChange={(e) => onPatch({ arpPattern: e.target.value as RackArpPattern })}>
                  {ARP_PATTERN_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className={`rack-fx-led-btn ${layer.arpSync ? 'on' : ''}`}
                  onClick={() => onPatch({ arpSync: !layer.arpSync })}
                  title={`Sync: ${layer.arpSync ? 'ligado' : 'desligado'}${layer.arpSync ? ` (${bpm.toFixed(1)} BPM)` : ''}`}
                >
                  <span className="rack-fx-led" style={layer.arpSync ? { background: '#4a7fd6', boxShadow: '0 0 6px #4a7fd6' } : undefined} />
                  Sync
                </button>
                {layer.arpSync ? (
                  <select value={layer.arpDivision} onChange={(e) => onPatch({ arpDivision: e.target.value as RackArpDivision })}>
                    {ARP_DIVISION_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                ) : null}
                <button
                  type="button"
                  className={`rack-fx-led-btn ${layer.arpLatch ? 'on' : ''}`}
                  onClick={() => onPatch({ arpLatch: !layer.arpLatch })}
                  title={`Hold/Latch: ${layer.arpLatch ? 'ligado' : 'desligado'} — continua arpejando depois de soltar as teclas`}
                >
                  <span className="rack-fx-led" style={layer.arpLatch ? { background: '#4a7fd6', boxShadow: '0 0 6px #4a7fd6' } : undefined} />
                  Hold
                </button>
              </div>
            }
          >
            {!layer.arpSync && (
              <RackKnob label="Rate" value={layer.arpRateHz} min={0.5} max={20} step={0.1} defaultValue={6} format={(v) => `${v.toFixed(1)}Hz`} onChange={(v) => onPatch({ arpRateHz: v })} accent="#4a7fd6" />
            )}
            <RackKnob label="Oitavas" value={layer.arpOctaves} min={1} max={4} step={1} defaultValue={1} format={(v) => `${Math.round(v)}`} onChange={(v) => onPatch({ arpOctaves: Math.round(v) })} accent="#4a7fd6" />
            <RackKnob label="Gate" value={layer.arpGate} min={0.05} max={1} step={0.01} defaultValue={0.7} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onPatch({ arpGate: v })} accent="#4a7fd6" />
            <RackKnob label="Swing" value={layer.arpSwing} min={0} max={0.75} step={0.01} defaultValue={0} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onPatch({ arpSwing: v })} accent="#4a7fd6" />
          </RackFxModule>
        </div>
      </div>
    </div>
  );
}

function ToggleHeader({
  title,
  enabled,
  onToggle,
  compact,
}: {
  title: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  compact?: boolean;
}) {
  return (
    <button className={`rack-toggle-header ${enabled ? 'on' : ''} ${compact ? 'compact' : ''}`} onClick={() => onToggle(!enabled)}>
      {title} / {enabled ? 'LIGADO' : 'DESLIGADO'}
    </button>
  );
}

function MasterColumn({
  masterVolume,
  reverb,
  reverbRoom,
  reverbDecaySec,
  reverbDampingHz,
  reverbBassMult,
  reverbPredelayMs,
  reverbSize,
  reverbAttack,
  reverbDiffusionEarly,
  reverbDiffusionLate,
  reverbModRateHz,
  reverbModDepth,
  reverbEqLowCutHz,
  reverbEqHighCutHz,
  reverbColor,
  bpm,
  transpose,
  onMasterVolumeChange,
  onReverbChange,
  onReverbRoomChange,
  onReverbDecayChange,
  onReverbDampingChange,
  onReverbBassMultChange,
  onReverbPredelayChange,
  onReverbSizeChange,
  onReverbAttackChange,
  onReverbDiffusionEarlyChange,
  onReverbDiffusionLateChange,
  onReverbModRateChange,
  onReverbModDepthChange,
  onReverbEqLowCutChange,
  onReverbEqHighCutChange,
  onReverbColorChange,
  onBpmChange,
  onTransposeChange,
  onPanic,
  scenes,
  onSaveScene,
  onLoadScene,
  onDeleteScene,
}: {
  masterVolume: number;
  reverb: number;
  reverbRoom: RackReverbRoom;
  reverbDecaySec: number;
  reverbDampingHz: number;
  reverbBassMult: number;
  reverbPredelayMs: number;
  reverbSize: number;
  reverbAttack: number;
  reverbDiffusionEarly: number;
  reverbDiffusionLate: number;
  reverbModRateHz: number;
  reverbModDepth: number;
  reverbEqLowCutHz: number;
  reverbEqHighCutHz: number;
  reverbColor: RackReverbColor;
  bpm: number;
  transpose: number;
  onMasterVolumeChange: (v: number) => void;
  onReverbChange: (v: number) => void;
  onReverbRoomChange: (v: RackReverbRoom) => void;
  onReverbDecayChange: (v: number) => void;
  onReverbDampingChange: (v: number) => void;
  onReverbBassMultChange: (v: number) => void;
  onReverbPredelayChange: (v: number) => void;
  onReverbSizeChange: (v: number) => void;
  onReverbAttackChange: (v: number) => void;
  onReverbDiffusionEarlyChange: (v: number) => void;
  onReverbDiffusionLateChange: (v: number) => void;
  onReverbModRateChange: (v: number) => void;
  onReverbModDepthChange: (v: number) => void;
  onReverbEqLowCutChange: (v: number) => void;
  onReverbEqHighCutChange: (v: number) => void;
  onReverbColorChange: (v: RackReverbColor) => void;
  onBpmChange: (v: number) => void;
  onTransposeChange: (v: number) => void;
  onPanic: () => void;
  scenes: RackScene[];
  onSaveScene: () => void;
  onLoadScene: (scene: RackScene) => void;
  onDeleteScene: (id: string) => void;
}) {
  const [pendingRoom, setPendingRoom] = useState<RackReverbRoom>(reverbRoom);
  const [fxOpen, setFxOpen] = useState(false);
  useEffect(() => {
    setPendingRoom(reverbRoom);
  }, [reverbRoom]);
  return (
    <>
    <div className="rack-master-col">
      <div className="rack-master-title">MASTER</div>

      <div className="rack-fader-row">
        <div className="rack-fader-ticks">
          <span>100</span>
          <span>75</span>
          <span>50</span>
          <span>25</span>
          <span>0</span>
        </div>
        <input
          className="rack-fader"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={masterVolume}
          onChange={(e) => onMasterVolumeChange(Number(e.target.value))}
        />
      </div>
      <div className="rack-volume-value">{masterVolume.toFixed(2)}</div>
      <div className="rack-volume-label">Saída</div>

      <RackKnob
        label="Transpose"
        value={transpose}
        min={-12}
        max={12}
        step={1}
        defaultValue={0}
        bipolar
        format={(v) => `${v >= 0 ? '+' : ''}${Math.round(v)}`}
        onChange={(v) => onTransposeChange(Math.round(v))}
        accent="#f2a93b"
      />
      <div className="rack-edit-hint" style={{ textAlign: 'center' }}>Transposição global (semitons)</div>

      <button className="btn rack-edit-btn" style={{ width: '100%' }} onClick={() => setFxOpen(true)}>
        FX
      </button>

      <button className="rack-panic-btn" onClick={onPanic}>
        PARAR NOTAS
      </button>

      <div className="rack-scenes">
        <div className="rack-scenes-title">Cenas</div>
        <div className="rack-scenes-list">
          {scenes.length === 0 && <div className="rack-scenes-empty">Nenhuma cena salva ainda.</div>}
          {scenes.map((scene, i) => (
            <div key={scene.id} className="rack-scene-row">
              <button type="button" className="rack-scene-btn" onClick={() => onLoadScene(scene)} title={`Program Change ${i} no teclado físico recarrega esta cena`}>
                <span className="rack-scene-pc">{i}</span> {scene.name}
              </button>
              <button type="button" className="rack-scene-del" onClick={() => onDeleteScene(scene.id)} title="Excluir cena">
                <XIcon size={11} />
              </button>
            </div>
          ))}
        </div>
        <button type="button" className="btn rack-scene-save-btn" onClick={onSaveScene}>
          Salvar cena atual
        </button>
      </div>

      <div className="rack-master-legend">M: MUDO · S: SOLO</div>
    </div>

    {fxOpen && (
      <div className="rack-edit-overlay" onClick={() => setFxOpen(false)}>
        <div className="rack-edit-panel card" style={{ width: 'min(400px, 100%)' }} onClick={(e) => e.stopPropagation()}>
          <div className="rack-edit-panel-header">
            <span>MASTER / FX</span>
            <button className="rack-edit-close" onClick={() => setFxOpen(false)} title="Fechar">
              <XIcon size={16} />
            </button>
          </div>

          <div className="rack-field" style={{ marginBottom: 14 }}>
            <label>BPM (pra delay sincronizado) {bpm.toFixed(1)}</label>
            <input
              type="range"
              min={40}
              max={240}
              step={0.5}
              value={bpm}
              onChange={(e) => onBpmChange(Number(e.target.value))}
            />
          </div>

          <RackFxModule
              title="Reverb"
              accent="#4fae5e"
              hint={'Bus único do rack (plate algorítmico estilo Dattorro) — o envio de cada camada é o "Amount" do Reverb dela. Shimmer é outro efeito, por camada.'}
            >
              <div className="rack-toggle-label">Mode</div>
              <div className="rack-reverb-room-list">
                {REVERB_ROOM_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className={`rack-reverb-room-item ${pendingRoom === o.value ? 'active' : ''}`}
                  onClick={() => setPendingRoom(o.value)}
                  title={o.hint}
                >
                  <span className="rack-reverb-room-dot" />
                  {o.label}
                </button>
              ))}
              <button
                type="button"
                className="rack-reverb-select-btn"
                disabled={pendingRoom === reverbRoom}
                onClick={() => onReverbRoomChange(pendingRoom)}
                title="Aplica o Mode selecionado acima (Size/Diffusion/Damping/Mod) — Decay/Mix/Predelay/EQ/Bass Mult/Color continuam como estão"
              >
                SELECT
              </button>
            </div>
            <div className="rack-fx-knob-row">
              <RackKnob label="Mix" value={reverb} min={0} max={1} step={0.01} defaultValue={0} format={(v) => `${Math.round(v * 100)}%`} onChange={onReverbChange} accent="#4fae5e" />
              <RackKnob label="Predelay" value={reverbPredelayMs} min={0} max={200} step={1} defaultValue={20} unit="ms" onChange={onReverbPredelayChange} accent="#4fae5e" />
              <RackKnob label="Decay" value={reverbDecaySec} min={0.2} max={8} step={0.1} defaultValue={1.8} unit="s" onChange={onReverbDecayChange} accent="#4fae5e" />
            </div>
            <div className="rack-toggle-label">Shape</div>
            <div className="rack-fx-knob-row">
              <RackKnob label="Size" value={reverbSize} min={0.4} max={1.8} step={0.01} defaultValue={1} format={(v) => `${v.toFixed(2)}x`} onChange={onReverbSizeChange} accent="#4fae5e" />
              <RackKnob label="Attack" value={reverbAttack} min={0} max={1} step={0.01} defaultValue={0.3} format={(v) => `${Math.round(v * 100)}%`} onChange={onReverbAttackChange} accent="#4fae5e" />
            </div>
            <div className="rack-toggle-label">Diffusion</div>
            <div className="rack-fx-knob-row">
              <RackKnob label="Early" value={reverbDiffusionEarly} min={0} max={0.95} step={0.01} defaultValue={0.65} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onReverbDiffusionEarlyChange(v)} accent="#4fae5e" />
              <RackKnob label="Late" value={reverbDiffusionLate} min={0} max={0.95} step={0.01} defaultValue={0.5} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onReverbDiffusionLateChange(v)} accent="#4fae5e" />
            </div>
            <div className="rack-toggle-label">Damping</div>
            <div className="rack-fx-knob-row">
              <RackKnob label="HighFreq" value={reverbDampingHz} min={200} max={16000} step={50} defaultValue={6000} format={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}Hz`)} onChange={onReverbDampingChange} accent="#4fae5e" />
              <RackKnob label="BassMult" value={reverbBassMult} min={0.4} max={3} step={0.01} defaultValue={1} format={(v) => `${v.toFixed(2)}x`} onChange={onReverbBassMultChange} accent="#4fae5e" />
            </div>
            <div className="rack-toggle-label">Mod</div>
            <div className="rack-fx-knob-row">
              <RackKnob label="Rate" value={reverbModRateHz} min={0.05} max={2} step={0.01} defaultValue={0.3} unit="Hz" onChange={(v) => onReverbModRateChange(v)} accent="#4fae5e" />
              <RackKnob label="Depth" value={reverbModDepth} min={0} max={1} step={0.01} defaultValue={0.4} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onReverbModDepthChange(v)} accent="#4fae5e" />
            </div>
            <div className="rack-toggle-label">EQ</div>
            <div className="rack-fx-knob-row">
              <RackKnob label="LowCut" value={reverbEqLowCutHz} min={10} max={500} step={5} defaultValue={20} unit="Hz" onChange={(v) => onReverbEqLowCutChange(v)} accent="#4fae5e" />
              <RackKnob label="HighCut" value={reverbEqHighCutHz} min={1000} max={18000} step={100} defaultValue={16000} format={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}Hz`)} onChange={(v) => onReverbEqHighCutChange(v)} accent="#4fae5e" />
            </div>
            <div className="rack-toggle-label">Color</div>
            <div className="rack-toggle-row" style={{ '--toggle-accent': '#4fae5e' } as CSSProperties}>
              <button
                type="button"
                className={`rack-toggle-btn ${reverbColor === 'vintage' ? 'active' : ''}`}
                onClick={() => onReverbColorChange('vintage')}
                title="Acrescenta uma saturação sutil dentro do tanque — 'warmth' de reverb de hardware/plate antigo"
              >
                1970s
              </button>
              <button
                type="button"
                className={`rack-toggle-btn ${reverbColor === 'modern' ? 'active' : ''}`}
                onClick={() => onReverbColorChange('modern')}
                title="Loop limpo/linear, sem saturação"
              >
                MODERN
              </button>
            </div>
          </RackFxModule>
        </div>
      </div>
    )}
    </>
  );
}

