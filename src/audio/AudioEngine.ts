import { PitchShifter } from 'soundtouchjs';
import type { ClickSettings, Song, SongArrangement, SongPart, SongTrack } from '../../shared/types';
import { semitoneDistance } from '../../shared/types';
import { AudioContextCompat } from './audioContextCompat';

export interface EngineTrackState {
  id: string;
  peakL: number;
  peakR: number;
}

export interface EngineState {
  isPlaying: boolean;
  isLoaded: boolean;
  isCountingIn: boolean;
  countInBeatsLeft: number;
  originalSeconds: number;
  realSeconds: number;
  realTotalSeconds: number;
  currentBar: number;
  activePartId: string | null;
  pendingPartId: string | null;
  /** id da parte que vai tocar depois que a parte ativa atual terminar (ordem natural ou próximo passo do arranjo); null quando não há previsão (ex.: loop ao vivo armado, ou é a última parte) */
  upcomingPartId: string | null;
  loopActivePart: boolean;
  songEnded: boolean;
  /** pico instantâneo (0..1) do sinal pós-fader de cada faixa, usado pelo indicador de pico/clipping do mixer */
  trackLevels: Record<string, number>;
  /** "Loop A/B" de ensaio: repete só um trechinho (em compassos) dentro da parte ativa, pra
   *  martelar uma passagem difícil sem precisar reiniciar a parte inteira a cada volta.
   *  Independente do loop normal da parte (loopActivePart) — ver setPracticeLoop(). */
  practiceLoop: { startBar: number; endBar: number } | null;
}

interface LoadedTrack {
  track: SongTrack;
  buffer: AudioBuffer;
  shifter: PitchShifter;
  gainNode: GainNode;
  analyser: AnalyserNode;
  merger: ChannelMergerNode;
  connected: boolean;
}

export type EngineListener = (state: EngineState) => void;

const MAX_OUTPUT_PAIRS = 16;

function logDiag(line: string) {
  try {
    console.log('[audio]', line);
    void window.api?.log?.append(line);
  } catch { /* noop */ }
}

function bytesPreview(buf: ArrayBuffer, n = 16): string {
  try {
    const arr = new Uint8Array(buf.slice(0, n));
    const hex = Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = Array.from(arr).map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    return `${hex} | "${ascii}"`;
  } catch {
    return '(indisponivel)';
  }
}

function noteFrequency(note: string, octave = 3): number {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const idx = names.indexOf(note);
  if (idx < 0) return 220;
  const midi = (octave + 1) * 12 + idx;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export class AudioEngine {
  ctx: AudioContext;
  private merger: ChannelMergerNode | null = null;
  private channelCount = 2;
  private tracks = new Map<string, LoadedTrack>();
  private song: Song | null = null;
  private referenceTrackId: string | null = null;
  private secPerBarOriginal = 2;
  private listeners = new Set<EngineListener>();
  private monitorHandle: ReturnType<typeof setInterval> | null = null;
  private lastIntegerBar = 1;
  private arrangementIndex = 0;
  private arrangementRepeatsLeft: number = 1;
  /** silencia a faixa de voz guia temporariamente durante um pulo manual fora de ordem */
  private guideOverrideSilent = false;
  private onAnnounce: ((text: string) => void) | null = null;

  private state: EngineState = {
    isPlaying: false,
    isLoaded: false,
    isCountingIn: false,
    countInBeatsLeft: 0,
    originalSeconds: 0,
    realSeconds: 0,
    realTotalSeconds: 0,
    currentBar: 1,
    activePartId: null,
    pendingPartId: null,
    upcomingPartId: null,
    loopActivePart: false,
    songEnded: false,
    trackLevels: {},
    practiceLoop: null,
  };

  private levelScratch = new Uint8Array(256);

  private clickOsc: OscillatorNode | null = null;
  private clickGain: GainNode | null = null;

  constructor() {
    this.ctx = new AudioContextCompat();
    this.buildMerger(2);
  }

  // ---------------- infra ----------------

  subscribe(listener: EngineListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    const snapshot = { ...this.state };
    this.listeners.forEach((l) => l(snapshot));
  }

  private buildMerger(channelCount: number) {
    this.channelCount = Math.max(2, channelCount);
    if (this.merger) {
      try { this.merger.disconnect(); } catch { /* noop */ }
    }
    this.merger = this.ctx.createChannelMerger(this.channelCount);
    try {
      this.ctx.destination.channelCount = Math.min(this.channelCount, this.ctx.destination.maxChannelCount || this.channelCount);
      this.ctx.destination.channelInterpretation = 'discrete';
    } catch { /* alguns dispositivos não aceitam, seguimos no padrão estéreo */ }
    this.merger.connect(this.ctx.destination);
  }

  async setChannelCount(n: number) {
    const wasPlaying = this.state.isPlaying;
    this.buildMerger(n);
    for (const lt of this.tracks.values()) {
      if (lt.connected) {
        lt.gainNode.disconnect();
        this.connectTrackOutput(lt);
      }
    }
    if (wasPlaying) await this.ctx.resume();
  }

  async setOutputDevice(deviceId: string | null) {
    if (!deviceId || !this.ctx.setSinkId) return;
    try {
      await this.ctx.setSinkId(deviceId);
    } catch (err) {
      console.warn('[audio] não foi possível trocar o dispositivo de saída', err);
    }
  }

  private connectTrackOutput(lt: LoadedTrack) {
    if (!this.merger) return;
    const pairIndex = outputToPairIndex(lt.track.output);
    const left = Math.min(pairIndex * 2, this.channelCount - 1);
    const right = Math.min(pairIndex * 2 + 1, this.channelCount - 1);
    const splitter = this.ctx.createChannelSplitter(2);
    lt.gainNode.disconnect();
    lt.analyser.disconnect();
    // o analisador fica "no meio do caminho" só para poder medir o pico pós-fader
    // (indicador de pico/clipping do mixer) — não altera o som, é um simples tap.
    lt.gainNode.connect(lt.analyser);
    lt.analyser.connect(splitter);
    splitter.connect(this.merger, 0, left);
    splitter.connect(this.merger, lt.buffer.numberOfChannels > 1 ? 1 : 0, right);
  }

  /**
   * Conecta um nó de áudio "mono" (ex.: o beep do click, o pad contínuo) a um
   * par de saída do dispositivo, reaproveitando o mesmo merger multi-canal
   * já usado pelas faixas — assim o click/pad respeitam a mesma interface de
   * áudio multi-saída configurada em Ajustes > Áudio. Aceita:
   *  - 'auto' / 'with-song' / 'stereo-N-M': manda para os DOIS canais do par
   *    correspondente (N/M define o par; 'auto'/'with-song' usam o par 1/2).
   *  - 'left-N' / 'right-N': manda só para um lado do par N (útil, por
   *    exemplo, pra mandar o click só pro fone do baterista, deixando o
   *    outro canal livre pra música).
   */
  connectMonoToOutput(node: AudioNode, outputId: string) {
    if (!this.merger) {
      node.connect(this.ctx.destination);
      return;
    }
    const isLeftOnly = outputId.startsWith('left-');
    const isRightOnly = outputId.startsWith('right-');
    const normalized = outputId === 'auto' || outputId === 'with-song' ? 'stereo-1-2' : outputId;
    const pairIndex = outputToPairIndex(normalized);
    const left = Math.min(pairIndex * 2, this.channelCount - 1);
    const right = Math.min(pairIndex * 2 + 1, this.channelCount - 1);
    if (isLeftOnly) node.connect(this.merger, 0, left);
    else if (isRightOnly) node.connect(this.merger, 0, right);
    else {
      node.connect(this.merger, 0, left);
      node.connect(this.merger, 0, right);
    }
  }

  // ---------------- carregamento ----------------

  async loadSong(song: Song, trackUrls: Record<string, string>): Promise<{ failed: { name: string; reason: string }[] }> {
    this.unloadSong();
    this.song = song;
    this.secPerBarOriginal = (60 / song.originalBpm) * song.timeSignatureNum;

    let maxDuration = 0;
    const failed: { name: string; reason: string }[] = [];
    // Cada faixa é carregada de forma independente: se uma faixa estiver corrompida,
    // num formato não suportado ou com o arquivo ausente, as demais continuam
    // carregando normalmente (importante para não travar o show inteiro por causa
    // de 1 arquivo problemático entre várias faixas).
    const decoded = await Promise.all(
      song.tracks.map(async (track) => {
        const url = trackUrls[track.id];
        logDiag(`faixa="${track.name}" filePath="${track.filePath}" url="${url ?? '(sem url)'}"`);
        if (!url) {
          logDiag(`faixa="${track.name}": FALHA - nenhuma URL foi resolvida para esse arquivo`);
          failed.push({ name: track.name, reason: 'arquivo nao encontrado' });
          return null;
        }

        let res: Response;
        try {
          res = await fetch(url);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logDiag(`faixa="${track.name}": FALHA DE ACESSO ao buscar "${url}" -> ${msg}`);
          failed.push({ name: track.name, reason: `nao foi possivel acessar o arquivo (${msg})` });
          return null;
        }
        if (!res.ok) {
          logDiag(`faixa="${track.name}": HTTP nao-OK status=${res.status} url="${url}"`);
          failed.push({ name: track.name, reason: `nao foi possivel ler o arquivo (HTTP ${res.status})` });
          return null;
        }

        let arrayBuffer: ArrayBuffer;
        try {
          arrayBuffer = await res.arrayBuffer();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logDiag(`faixa="${track.name}": FALHA ao ler bytes da resposta -> ${msg}`);
          failed.push({ name: track.name, reason: `falha ao ler os dados do arquivo (${msg})` });
          return null;
        }
        if (arrayBuffer.byteLength === 0) {
          logDiag(`faixa="${track.name}": arquivo retornou 0 bytes (url="${url}")`);
          failed.push({ name: track.name, reason: 'arquivo vazio' });
          return null;
        }
        logDiag(
          `faixa="${track.name}": bytes recebidos=${arrayBuffer.byteLength} content-type="${res.headers.get('content-type') ?? ''}" primeirosBytes=[${bytesPreview(arrayBuffer)}]`
        );

        try {
          // Não usamos mais `arrayBuffer` depois deste ponto, então passamos
          // ele direto para o decode em vez de duplicá-lo com slice(0) — isso
          // evita manter 2 cópias de cada arquivo (bruto + decodificado) na
          // memória ao mesmo tempo, o que é importante com várias faixas
          // grandes carregadas juntas (ex: 18 faixas de uma música ao vivo).
          const buffer = await this.ctx.decodeAudioData(arrayBuffer);
          logDiag(
            `faixa="${track.name}": OK duration=${buffer.duration.toFixed(2)}s sampleRate=${buffer.sampleRate} canais=${buffer.numberOfChannels}`
          );
          return { track, buffer };
        } catch (err) {
          const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
          logDiag(
            `faixa="${track.name}": FALHA DE DECODE (bytes=${arrayBuffer.byteLength}) -> ${msg} | primeirosBytes=[${bytesPreview(arrayBuffer)}]`
          );
          failed.push({ name: track.name, reason: 'formato de audio nao suportado ou arquivo corrompido' });
          return null;
        }
      })
    );

    for (const item of decoded) {
      if (!item) continue;
      const { track, buffer } = item;
      const shifter = new PitchShifter(this.ctx, buffer, 4096);
      shifter.tempo = song.currentBpm / song.originalBpm;
      shifter.pitchSemitones = track.followsKey ? semitoneDistance(song.originalKey, song.currentKey) : 0;

      const gainNode = this.ctx.createGain();
      gainNode.gain.value = track.muted ? 0 : dbGain(track.volumeDb);
      shifter.connect(gainNode);
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0;

      const lt: LoadedTrack = { track, buffer, shifter, gainNode, analyser, merger: this.merger!, connected: false };
      this.tracks.set(track.id, lt);

      if (buffer.duration > maxDuration) {
        maxDuration = buffer.duration;
        this.referenceTrackId = track.id;
      }
    }

    const ref = this.referenceTrackId ? this.tracks.get(this.referenceTrackId) : null;
    if (ref) {
      ref.shifter.on('play', (detail: { timePlayed: number }) => {
        this.onReferenceTick(detail.timePlayed);
      });
    }

    this.guideOverrideSilent = false;
    this.applySoloMuteLogic();
    this.connectAll();
    this.state.isLoaded = this.tracks.size > 0;
    this.state.realTotalSeconds = maxDuration / (song.currentBpm / song.originalBpm);
    this.resetArrangementPointer(this.getActiveArrangement(), 0);
    this.seekToBar(1);
    this.startMonitor();
    this.emit();
    return { failed };
  }


  private connectAll() {
    for (const lt of this.tracks.values()) {
      this.connectTrackOutput(lt);
      lt.connected = true;
    }
  }

  unloadSong() {
    this.stopMonitor();
    for (const lt of this.tracks.values()) {
      try { lt.shifter.off(); lt.shifter.disconnect(); } catch { /* noop */ }
    }
    this.tracks.clear();
    this.referenceTrackId = null;
    this.song = null;
    this.state = { ...this.state, isLoaded: false, isPlaying: false, originalSeconds: 0, realSeconds: 0, activePartId: null, upcomingPartId: null, pendingPartId: null, trackLevels: {}, practiceLoop: null };
  }

  // ---------------- transporte ----------------

  async play() {
    if (!this.song) return;
    await this.ctx.resume();
    this.state.isPlaying = true;
    this.state.songEnded = false;
    this.emit();
  }

  async pause() {
    await this.ctx.suspend();
    this.state.isPlaying = false;
    this.emit();
  }

  async stop() {
    await this.pause();
    const part = this.song?.parts.find((p) => p.id === this.state.activePartId);
    this.seekToBar(part ? part.startBar : 1);
  }

  async playCountIn(beats: number, bpm: number, onBeat: (n: number) => void, click?: ClickSettings) {
    await this.ctx.resume();
    this.state.isCountingIn = true;
    const beatDur = 60 / bpm;
    for (let i = 0; i < beats; i++) {
      this.state.countInBeatsLeft = beats - i;
      this.emit();
      onBeat(i);
      this.playClickBeat(i === 0, click);
      await sleep(beatDur * 1000);
    }
    this.state.isCountingIn = false;
    this.emit();
  }

  private noiseBufferCache: AudioBuffer | null = null;
  /** buffer de ruído branco, gerado uma vez e reaproveitado pelos timbres de click que precisam dele. */
  private getNoiseBuffer(): AudioBuffer {
    if (this.noiseBufferCache) return this.noiseBufferCache;
    const length = Math.floor(this.ctx.sampleRate * 0.2);
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBufferCache = buffer;
    return buffer;
  }

  /**
   * Toca um tique do click de contagem (count-in), respeitando o timbre, o
   * acento no tempo 1, o volume e a saída configurados em Ajustes > Click.
   * Antes, isto era um bipe fixo direto pro destino padrão, ignorando
   * completamente essas 4 configurações.
   */
  private playClickBeat(accent: boolean, click?: ClickSettings) {
    const settings: ClickSettings = click ?? {
      countInBars: 1, sound: 'beep', accentFirstBeat: true, volumeDb: 0, output: 'auto', doubleClick: 'off',
    };
    const isAccent = accent && settings.accentFirstBeat;
    const t = this.ctx.currentTime;
    const peakGain = Math.pow(10, settings.volumeDb / 20) * (isAccent ? 0.3 : 0.2);

    const out = this.ctx.createGain();
    out.gain.value = 1;
    this.connectMonoToOutput(out, settings.output);

    const sound = settings.sound ?? 'beep';

    if (sound === 'beep') {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = isAccent ? 1500 : 1000;
      gain.gain.setValueAtTime(peakGain, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      osc.connect(gain);
      gain.connect(out);
      osc.start(t);
      osc.stop(t + 0.1);
    } else if (sound === 'click') {
      // "clique seco": ruído curto filtrado em passa-alta, decaimento quase imediato
      const src = this.ctx.createBufferSource();
      src.buffer = this.getNoiseBuffer();
      const hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = isAccent ? 3500 : 2500;
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(peakGain * 1.4, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.02);
      src.connect(hp);
      hp.connect(gain);
      gain.connect(out);
      src.start(t);
      src.stop(t + 0.03);
    } else if (sound === 'rimshot') {
      // aproximação de rimshot: ruído filtrado em banda + um "thwack" grave curto
      const src = this.ctx.createBufferSource();
      src.buffer = this.getNoiseBuffer();
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1800;
      bp.Q.value = 1.2;
      const noiseGain = this.ctx.createGain();
      noiseGain.gain.setValueAtTime(peakGain * 1.1, t);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.045);
      src.connect(bp);
      bp.connect(noiseGain);
      noiseGain.connect(out);
      src.start(t);
      src.stop(t + 0.05);

      const thump = this.ctx.createOscillator();
      thump.type = 'triangle';
      thump.frequency.setValueAtTime(isAccent ? 260 : 200, t);
      thump.frequency.exponentialRampToValueAtTime(80, t + 0.05);
      const thumpGain = this.ctx.createGain();
      thumpGain.gain.setValueAtTime(peakGain * 0.8, t);
      thumpGain.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
      thump.connect(thumpGain);
      thumpGain.connect(out);
      thump.start(t);
      thump.stop(t + 0.07);
    } else if (sound === 'cowbell') {
      // cowbell clássico de caixa de ritmo: 2 ondas quadradas desafinadas entre si
      const freqs = isAccent ? [845, 1290] : [800, 1200];
      for (const f of freqs) {
        const osc = this.ctx.createOscillator();
        osc.type = 'square';
        osc.frequency.value = f;
        const bp = this.ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = f;
        bp.Q.value = 3;
        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(peakGain * 0.6, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
        osc.connect(bp);
        bp.connect(gain);
        gain.connect(out);
        osc.start(t);
        osc.stop(t + 0.14);
      }
    }
  }

  seekToOriginalSeconds(origSec: number) {
    for (const lt of this.tracks.values()) {
      const frac = clamp01(origSec / lt.buffer.duration);
      lt.shifter.percentagePlayed = frac;
    }
    this.state.originalSeconds = origSec;
    this.updateDerivedTime();
    this.emit();
  }

  seekToBar(bar: number) {
    this.seekToOriginalSeconds((bar - 1) * this.secPerBarOriginal);
  }

  /**
   * @param guideAnnounce Quando o pulo é manual e "fora da ordem", informa como a
   * voz guia deve se comportar: calar até a parte pedida chegar, opcionalmente
   * anunciando (por voz sintetizada) o nome da parte antes da virada.
   */
  jumpToPart(partId: string, quantized = true, guideAnnounce?: { behavior: 'mute' | 'mute-and-announce' }) {
    if (!this.song) return;
    const part = this.song.parts.find((p) => p.id === partId);
    if (!part) return;

    if (guideAnnounce) {
      this.guideOverrideSilent = true;
      this.applySoloMuteLogic();
      if (guideAnnounce.behavior === 'mute-and-announce') {
        try { this.onAnnounce?.(part.name); } catch { /* noop */ }
      }
    }

    if (!this.state.isPlaying || !quantized) {
      this.seekToBar(part.startBar);
      this.state.activePartId = partId;
      this.state.pendingPartId = null;
      this.syncArrangementPointerTo(partId);
      if (guideAnnounce) {
        // pulo imediato (não tocando ainda): não há "chegada" futura para esperar
        this.guideOverrideSilent = false;
        this.applySoloMuteLogic();
      }
      this.emit();
    } else {
      this.state.pendingPartId = partId;
      this.emit();
    }
  }

  /** Quando o usuário pula manualmente para uma parte, realinha o ponteiro do arranjo ativo. */
  private syncArrangementPointerTo(partId: string) {
    const arrangement = this.getActiveArrangement();
    if (!arrangement) return;
    const idx = arrangement.steps.findIndex((s) => s.partId === partId);
    if (idx >= 0) this.resetArrangementPointer(arrangement, idx);
  }

  setLoopActivePart(loop: boolean) {
    this.state.loopActivePart = loop;
    this.emit();
  }

  /**
   * Arma o "Loop A/B" de ensaio num trecho de `startBar` a `endBar` (em
   * compassos, mesma unidade de `currentBar`/`SongPart.startBar`). Tem
   * prioridade sobre o loop normal da parte e sobre o avanço do arranjo
   * enquanto estiver ativo — ver checagem no início de tick(). Não mexe em
   * nada do estado de reprodução além de, quando o trecho é ultrapassado,
   * voltar o ponteiro pro início do trecho (mesma técnica já usada por
   * loopActivePart/seekToBar, só que com limites mais estreitos).
   */
  setPracticeLoop(startBar: number, endBar: number) {
    if (endBar <= startBar) return;
    this.state.practiceLoop = { startBar, endBar };
    this.emit();
  }

  clearPracticeLoop() {
    this.state.practiceLoop = null;
    this.emit();
  }

  updateParts(parts: SongPart[]) {
    if (!this.song) return;
    this.song.parts = parts;
  }

  updateArrangements(arrangements: SongArrangement[], activeId: string | null) {
    if (!this.song) return;
    const changed = this.song.activeArrangementId !== activeId;
    this.song.arrangements = arrangements;
    this.song.activeArrangementId = activeId;
    if (changed) {
      const arr = arrangements.find((a) => a.id === activeId);
      this.resetArrangementPointer(arr ?? null, 0);
    }
  }

  private getActiveArrangement(): SongArrangement | null {
    if (!this.song?.activeArrangementId) return null;
    return this.song.arrangements.find((a) => a.id === this.song!.activeArrangementId) ?? null;
  }

  /**
   * Posiciona o ponteiro do arranjo num passo e arma/desarma o loop automático
   * quando esse passo é do tipo "repetir até eu desativar".
   */
  private resetArrangementPointer(arrangement: SongArrangement | null, index: number) {
    this.arrangementIndex = index;
    const step = arrangement?.steps[index];
    const infinite = step?.repeat === 'infinite';
    this.arrangementRepeatsLeft = infinite ? Infinity : (step?.repeat as number) ?? 1;
    if (step) this.state.loopActivePart = infinite;
  }

  /** Define quem recebe o texto a ser falado (TTS) quando a voz guia anuncia uma parte. */
  setAnnounceHandler(handler: ((text: string) => void) | null) {
    this.onAnnounce = handler;
  }

  // ---------------- parâmetros musicais ----------------

  setBpm(bpm: number) {
    if (!this.song) return;
    const beforeOriginalSec = this.state.originalSeconds;
    this.song.currentBpm = bpm;
    const ratio = bpm / this.song.originalBpm;
    for (const lt of this.tracks.values()) lt.shifter.tempo = ratio;
    this.seekToOriginalSeconds(beforeOriginalSec);
  }

  setKey(key: string) {
    if (!this.song) return;
    this.song.currentKey = key;
    for (const lt of this.tracks.values()) {
      const semis = lt.track.followsKey ? semitoneDistance(this.song.originalKey, key) : 0;
      lt.shifter.pitchSemitones = semis;
    }
  }

  setTrackFollowsKey(trackId: string, follow: boolean) {
    const lt = this.tracks.get(trackId);
    if (!lt || !this.song) return;
    lt.track.followsKey = follow;
    lt.shifter.pitchSemitones = follow ? semitoneDistance(this.song.originalKey, this.song.currentKey) : 0;
  }

  setTrackVolumeDb(trackId: string, db: number) {
    const lt = this.tracks.get(trackId);
    if (!lt) return;
    lt.track.volumeDb = db;
    this.applySoloMuteLogic();
  }

  setTrackMuted(trackId: string, muted: boolean) {
    const lt = this.tracks.get(trackId);
    if (!lt) return;
    lt.track.muted = muted;
    this.applySoloMuteLogic();
  }

  setTrackSolo(trackId: string, solo: boolean) {
    const lt = this.tracks.get(trackId);
    if (!lt) return;
    lt.track.solo = solo;
    this.applySoloMuteLogic();
  }

  setTrackOutput(trackId: string, output: string) {
    const lt = this.tracks.get(trackId);
    if (!lt) return;
    lt.track.output = output;
    this.connectTrackOutput(lt);
  }

  private applySoloMuteLogic() {
    const anySolo = Array.from(this.tracks.values()).some((lt) => lt.track.solo);
    for (const lt of this.tracks.values()) {
      const audible = anySolo ? lt.track.solo : !lt.track.muted;
      let target = audible ? dbGain(lt.track.volumeDb) : 0;
      if (this.guideOverrideSilent && lt.track.role === 'guide') target = 0;
      lt.gainNode.gain.setTargetAtTime(target, this.ctx.currentTime, 0.01);
    }
  }

  // ---------------- loop de monitoramento ----------------

  private onReferenceTick(originalSeconds: number) {
    this.state.originalSeconds = originalSeconds;
    this.updateDerivedTime();
  }

  private updateDerivedTime() {
    if (!this.song) return;
    this.state.currentBar = 1 + this.state.originalSeconds / this.secPerBarOriginal;
    const ratio = this.song.currentBpm / this.song.originalBpm;
    this.state.realSeconds = this.state.originalSeconds / ratio;
  }

  private startMonitor() {
    this.stopMonitor();
    this.lastIntegerBar = Math.floor(this.state.currentBar);
    this.monitorHandle = setInterval(() => this.tick(), 40);
  }

  private stopMonitor() {
    if (this.monitorHandle) clearInterval(this.monitorHandle);
    this.monitorHandle = null;
  }

  /**
   * Qual parte deve tocar depois que a parte ativa atual chegar ao fim —
   * usado só pra dar uma dica visual ("A seguir: ...") na interface, sem
   * nenhum efeito sobre a reprodução em si. Segue a mesma lógica de decisão
   * do tickArrangement()/tick(), mas sem mexer em nenhum estado.
   */
  private computeUpcomingPartId(): string | null {
    if (!this.song) return null;
    const activePart = this.song.parts.find((p) => p.id === this.state.activePartId);
    if (!activePart) return null;
    const arrangement = this.getActiveArrangement();
    if (arrangement && arrangement.steps.length > 0) {
      const step = arrangement.steps[this.arrangementIndex];
      if (!step) return null;
      if (step.repeat === 'infinite') return null; // loop ao vivo: sem previsão até desarmarem
      if (this.arrangementRepeatsLeft > 1) return step.partId; // ainda vai repetir a mesma parte
      const nextIndex = (this.arrangementIndex + 1) % arrangement.steps.length;
      const nextStep = arrangement.steps[nextIndex];
      return nextStep ? nextStep.partId : null;
    }
    // sem arranjo customizado: segue a ordem natural das partes marcadas
    const idx = this.song.parts.findIndex((p) => p.id === activePart.id);
    if (idx < 0 || idx === this.song.parts.length - 1) return null;
    return this.song.parts[idx + 1].id;
  }

  /** Lê o pico pós-fader de cada faixa (indicador de pico/clipping do mixer). Só roda enquanto toca, pra não gastar CPU à toa parado. */
  private computeTrackLevels() {
    const levels: Record<string, number> = {};
    for (const [id, lt] of this.tracks) {
      lt.analyser.getByteTimeDomainData(this.levelScratch);
      let peak = 0;
      for (let i = 0; i < this.levelScratch.length; i++) {
        const v = Math.abs(this.levelScratch[i] - 128) / 128;
        if (v > peak) peak = v;
      }
      levels[id] = peak;
    }
    this.state.trackLevels = levels;
  }

  private tick() {
    if (!this.song) return;
    const bar = this.state.currentBar;
    const barInt = Math.floor(bar);
    this.state.upcomingPartId = this.computeUpcomingPartId();
    if (this.state.isPlaying) this.computeTrackLevels();

    // "Loop A/B" de ensaio tem PRIORIDADE MÁXIMA sobre qualquer outra lógica de
    // navegação (troca manual pendente, loop da parte inteira, avanço do
    // arranjo) — é o modo "martelar só este trechinho" até o usuário desarmar.
    if (this.state.practiceLoop && bar >= this.state.practiceLoop.endBar) {
      this.seekToBar(this.state.practiceLoop.startBar);
      this.lastIntegerBar = barInt;
      this.emit();
      return;
    }

    // Parte que está tocando "agora" (antes de qualquer atualização desta
    // chamada) — usada para decidir quando uma troca manual pendente deve
    // disparar.
    const activePartNow = this.song.parts.find((p) => p.id === this.state.activePartId);

    // troca quantizada manual: só dispara quando a parte QUE ESTÁ TOCANDO
    // termina (bar >= endBar dela) — e não simplesmente no próximo compasso
    // qualquer. Assim dá pra ouvir a parte atual inteira até o fim antes de
    // pular pra parte escolhida, em vez de cortá-la no meio. Se por algum
    // motivo não houver uma parte ativa identificável (ex.: fora de qualquer
    // parte marcada), cai de volta no comportamento antigo (troca no próximo
    // compasso) pra nunca deixar o pulo pendente preso pra sempre.
    if (this.state.pendingPartId) {
      const ready = activePartNow ? bar >= activePartNow.endBar : barInt !== this.lastIntegerBar;
      if (ready) {
        const target = this.state.pendingPartId;
        this.state.pendingPartId = null;
        this.jumpToPart(target, false);
        if (this.guideOverrideSilent) {
          // a parte pedida chegou: a voz guia volta a tocar normalmente
          this.guideOverrideSilent = false;
          this.applySoloMuteLogic();
        }
        this.lastIntegerBar = barInt;
        this.emit();
        return;
      }
    }

    if (!this.state.pendingPartId) {
      const current = this.song.parts.find((p) => bar >= p.startBar && bar < p.endBar);
      if (current && current.id !== this.state.activePartId) {
        this.state.activePartId = current.id;
      }
    }

    const activePart = this.song.parts.find((p) => p.id === this.state.activePartId);

    // loop da parte ativa tem prioridade sobre o avanço automático do arranjo
    if (this.state.loopActivePart && activePart && bar >= activePart.endBar) {
      this.seekToBar(activePart.startBar);
      this.lastIntegerBar = barInt;
      this.emit();
      return;
    }

    const arrangement = this.getActiveArrangement();
    if (arrangement && arrangement.steps.length > 0 && !this.state.pendingPartId) {
      this.tickArrangement(arrangement, bar);
      this.lastIntegerBar = barInt;
      this.emit();
      return;
    }

    // sem arranjo customizado: segue a ordem original e para ao fim da última parte
    const isLastPart = activePart && this.song.parts[this.song.parts.length - 1]?.id === activePart.id;
    const reachedEndOfAudio = this.state.realSeconds >= this.state.realTotalSeconds - 0.03;
    if ((isLastPart && bar >= activePart!.endBar) || reachedEndOfAudio) {
      // A checagem por duração real (reachedEndOfAudio) é um reforço: garante que a
      // música pare quando o áudio de fato termina, mesmo quando a única parte
      // marcada é o placeholder "Música inteira" (endBar muito maior que o real).
      this.state.songEnded = true;
      this.pause();
    }

    this.lastIntegerBar = barInt;
    this.emit();
  }

  private tickArrangement(arrangement: SongArrangement, bar: number) {
    const step = arrangement.steps[this.arrangementIndex];
    const part = step ? this.song!.parts.find((p) => p.id === step.partId) : null;
    if (!part || !step) return;
    if (part.id !== this.state.activePartId) this.state.activePartId = part.id;
    if (bar < part.endBar) return;

    const isInfinite = step.repeat === 'infinite';

    // "repetir até eu desativar": continua em loop enquanto o botão de loop
    // estiver armado. O bloco de prioridade no início do tick() já cuida disso
    // na maioria dos casos; isto aqui é um reforço de segurança.
    if (isInfinite && this.state.loopActivePart) {
      this.seekToBar(part.startBar);
      return;
    }

    if (!isInfinite) {
      this.arrangementRepeatsLeft -= 1;
      if (this.arrangementRepeatsLeft > 0) {
        this.seekToBar(part.startBar);
        return;
      }
    }

    const isLastStep = this.arrangementIndex === arrangement.steps.length - 1;
    const nextIndex = (this.arrangementIndex + 1) % arrangement.steps.length;
    this.resetArrangementPointer(arrangement, nextIndex);
    const nextStep = arrangement.steps[nextIndex];
    const nextPart = nextStep ? this.song!.parts.find((p) => p.id === nextStep.partId) : null;

    if (isLastStep) {
      this.state.songEnded = true;
      this.pause();
      this.resetArrangementPointer(arrangement, 0);
      this.seekToBar((nextPart ?? part).startBar);
      return;
    }

    if (nextPart) {
      this.seekToBar(nextPart.startBar);
      this.state.activePartId = nextPart.id;
    }
  }

  getSong() {
    return this.song;
  }

  getTrackBuffer(trackId: string): AudioBuffer | null {
    return this.tracks.get(trackId)?.buffer ?? null;
  }

  getState() {
    return this.state;
  }
}

function dbGain(db: number): number {
  return Math.pow(10, db / 20);
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function outputToPairIndex(output: string): number {
  const match = output.match(/(\d+)/);
  if (!match) return 0;
  const n = parseInt(match[1], 10);
  return Math.min(Math.max(0, Math.floor((n - 1) / 2)), MAX_OUTPUT_PAIRS - 1);
}

export function pairIndexLabel(index: number): string {
  return `Estéreo (${index * 2 + 1}/${index * 2 + 2})`;
}

export function buildPartFromBars(startBar: number, endBar: number, name: string, type: SongPart['type'], color: string): SongPart {
  return { id: crypto.randomUUID(), name, type, startBar, endBar, color };
}
