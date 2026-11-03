import type { RackPresetOption } from '../../../shared/types';
import { parseExsFile, type ExsZone } from './ExsFile';

const ATTACK_SEC = 0.003;
const RELEASE_SEC = 0.12;

/** Mesmo motivo/forma de `NkiUnresolvedSample` (ver NkiLayerVoice.ts) —
 *  `unsupported-codec` aqui cobre tanto amostra "consolidada" (offset
 *  interno num único arquivo de Auto Sampler) quanto marcada como
 *  comprimida internamente pelo .exs (ver `ExsZone.unsupportedAudio` em
 *  ExsFile.ts), nenhum dos dois casos resolvido procurando o arquivo em
 *  disco. */
export interface ExsUnresolvedSample {
  samplePath: string;
  reason: 'not-found' | 'unsupported-codec';
}

interface ResolvedExsZone extends ExsZone {
  /** Nome do arquivo de amostra referenciado por esta zona (já resolvido a
   *  partir do índice `sampleIndex` contra a lista de amostras do .exs —
   *  ver `buildResolvedZones` abaixo). Vazio quando a zona não referenciava
   *  nenhuma amostra válida. */
  sampleFileName: string;
}

/**
 * Camada "Logic EXS24 / .exs": carrega de verdade (sem simplificação) os
 * timbres/amostras de um instrumento EXS24 do Logic Pro. Ao contrário do
 * `.nki` (NkiLayerVoice.ts), o parsing binário do contêiner nunca foi
 * criptografado pela Apple — roda inteiro em `ExsFile.ts` (puro, sem
 * nenhuma API de navegador, testável em Node — ver
 * scripts/test-exs-import.mjs). Esta classe só cuida da parte que
 * `ExsFile.ts` não pode fazer sozinho: resolver cada amostra referenciada
 * contra o disco de verdade (igual a NkiLayerVoice.resolveSample) e
 * decodificar o áudio real via `decodeAudioData` — nunca um tom sintético.
 *
 * Mesmo princípio de honestidade do resto do app: não reimplementamos o
 * motor de filtro/envelope/matriz de modulação do EXS24 (fora do plano de
 * licenciamento), nem loop/offset de amostra (mesma limitação já aceita
 * pro SFZ, ver SfzLayerVoice.ts) — ver o relatório de compatibilidade em
 * exsImport.ts pra a lista completa, nunca escondida do usuário.
 */
export class ExsLayerVoice {
  private ctx: AudioContext;
  private zones: ResolvedExsZone[] = [];
  private buffers = new Map<ResolvedExsZone, AudioBuffer>();
  private active = new Map<number, { src: AudioBufferSourceNode; gain: GainNode; baseRate: number }[]>();
  private bendSemitones = 0;
  private instrumentName = '';
  private unresolved: ExsUnresolvedSample[] = [];
  /** TODAS as zonas resolvidas do .exs, igual `NkiLayerVoice.rawGroups` —
   *  preserva as que ficaram "not-found" em `load()`, pra
   *  `resolveFromLibraryRoot` poder tentar de novo sem reabrir o arquivo. */
  private rawZones: ResolvedExsZone[] = [];
  readonly output: GainNode;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.output = ctx.createGain();
  }

  get name(): string {
    return this.instrumentName;
  }

  get unresolvedSamples(): ExsUnresolvedSample[] {
    return this.unresolved;
  }

  /** @param libraryRoot Ver o mesmo parâmetro em NkiLayerVoice.load — pasta-raiz
   *  de biblioteca escolhida manualmente pelo usuário, usada como fonte
   *  adicional de busca quando as amostras não estão perto do .exs. */
  async load(buffer: ArrayBuffer, sourcePath?: string, libraryRoot?: string): Promise<RackPresetOption[]> {
    this.dispose();
    const parsed = parseExsFile(buffer);
    this.instrumentName =
      parsed.instrument?.name || (sourcePath ? (sourcePath.split(/[\\/]/).pop() ?? '').replace(/\.exs$/i, '') : '');

    const resolvedZones: ResolvedExsZone[] = parsed.zones.map((zone) => {
      const sample = zone.sampleIndex >= 0 ? parsed.samples[zone.sampleIndex] : undefined;
      const sampleFileName = sample ? sample.fileName.split(/[\\/]/).pop() ?? sample.fileName : '';
      return { ...zone, sampleFileName };
    });

    if (resolvedZones.length === 0) {
      throw new Error('O .exs foi aberto, mas nenhuma zona foi reconhecida dentro dele (estrutura interna não reconhecida).');
    }

    const baseDir = sourcePath ? sourcePath.replace(/[\\/][^\\/]*$/, '') : '';
    this.unresolved = [];
    for (const zone of resolvedZones) {
      if (zone.unsupportedAudio || !zone.sampleFileName) {
        this.unresolved.push({ samplePath: zone.sampleFileName || zone.name || '(amostra sem nome)', reason: 'unsupported-codec' });
        continue;
      }
      const audioBuffer = await this.resolveSample(zone.sampleFileName, baseDir);
      if (audioBuffer) {
        this.buffers.set(zone, audioBuffer);
      } else {
        this.unresolved.push({ samplePath: zone.sampleFileName, reason: 'not-found' });
      }
    }

    this.rawZones = resolvedZones;

    if (libraryRoot) {
      await this.resolveFromLibraryRoot(libraryRoot);
    } else {
      this.rebuildZones();
    }

    if (this.buffers.size === 0) {
      throw new Error(
        'Nenhuma das amostras referenciadas por este .exs foi encontrada ao lado do arquivo no disco ' +
          '(mantenha a pasta de amostras original na mesma pasta do .exs, ou escolha a pasta raiz da biblioteca ' +
          'quando solicitado), ou o instrumento é "consolidado" num único arquivo de áudio (Auto Sampler do Logic), ' +
          'ainda não suportado.'
      );
    }
    if (this.unresolved.length > 0) {
      const names = this.unresolved.map((u) => u.samplePath.split(/[\\/]/).pop() ?? u.samplePath);
      console.warn(`[exs] ${names.length} amostra(s) não encontrada(s)/suportada(s) e ficarão mudas: ${names.join(', ')}`);
    }

    return [{ value: 'default', label: this.instrumentName || 'Instrumento EXS24' }];
  }

  /** Devolve TODO o instrumento já resolvido (todas as zonas, cada uma já
   *  com o AudioBuffer real decodificado) — usado pela exportação pra
   *  `.mrq` (ver exsImport.ts). */
  exportForMrqi(): {
    instrumentName: string;
    zones: {
      buffer: AudioBuffer;
      samplePath: string;
      rootNote: number;
      loNote: number;
      hiNote: number;
      loVel: number;
      hiVel: number;
      tuneCents: number;
      gainDb: number;
      pan: number;
    }[];
  } {
    return {
      instrumentName: this.instrumentName || 'Instrumento EXS24',
      zones: this.rawZones
        .map((z) => {
          const buffer = this.buffers.get(z);
          if (!buffer) return null;
          return {
            buffer,
            samplePath: z.sampleFileName,
            rootNote: z.key,
            loNote: z.keyLow,
            hiNote: z.keyHigh,
            loVel: z.velocityRangeOn ? z.velocityLow : 0,
            hiVel: z.velocityRangeOn ? z.velocityHigh : 127,
            tuneCents: z.tuneCents,
            gainDb: z.gainDb,
            pan: z.pan,
          };
        })
        .filter((z): z is NonNullable<typeof z> => z !== null),
    };
  }

  /** Reconstrói `zones` a partir de `rawZones`, mantendo só as que já tem
   *  áudio em `buffers` — mesmo papel de `NkiLayerVoice.rebuildProgramGroupsAndZones`. */
  private rebuildZones() {
    this.zones = this.rawZones.filter((z) => this.buffers.has(z));
  }

  /** Mesma lógica de `NkiLayerVoice.resolveFromLibraryRoot` — ver lá pro
   *  comentário completo do porquê. */
  async resolveFromLibraryRoot(libraryRoot: string): Promise<{ resolved: number; stillUnresolved: number }> {
    const pending = this.unresolved.filter((u) => u.reason === 'not-found');
    if (pending.length === 0 || !libraryRoot) {
      this.rebuildZones();
      return { resolved: 0, stillUnresolved: this.unresolved.length };
    }

    const wantedNames = Array.from(new Set(pending.map((u) => (u.samplePath.split(/[\\/]/).pop() ?? u.samplePath).toLowerCase())));

    let matches: Record<string, string> = {};
    try {
      matches = await window.api.fs.findSampleFiles(libraryRoot, wantedNames);
    } catch (err) {
      console.warn('[exs] falha ao varrer a pasta da biblioteca escolhida:', err);
      this.rebuildZones();
      return { resolved: 0, stillUnresolved: this.unresolved.length };
    }

    let resolvedCount = 0;
    for (const zone of this.rawZones) {
      if (this.buffers.has(zone) || zone.unsupportedAudio || !zone.sampleFileName) continue;
      const fileName = zone.sampleFileName.toLowerCase();
      const foundPath = matches[fileName];
      if (!foundPath) continue;
      const audio = await this.tryLoadFile(foundPath);
      if (audio) {
        this.buffers.set(zone, audio);
        resolvedCount++;
      }
    }

    const stillUnresolved: ExsUnresolvedSample[] = [];
    for (const zone of this.rawZones) {
      if (this.buffers.has(zone)) continue;
      stillUnresolved.push({
        samplePath: zone.sampleFileName || zone.name || '(amostra sem nome)',
        reason: zone.unsupportedAudio || !zone.sampleFileName ? 'unsupported-codec' : 'not-found',
      });
    }
    this.unresolved = stillUnresolved;
    this.rebuildZones();

    return { resolved: resolvedCount, stillUnresolved: this.unresolved.length };
  }

  /** O .exs é sempre um instrumento só (sem o conceito de "vários Programas"
   *  que o .nki tem) — existe só pra manter a mesma interface pública que as
   *  outras camadas do Rack esperam; nunca há nada pra trocar de verdade. */
  selectPreset(_value: string) {
    /* no-op de propósito — ver comentário acima. */
  }

  /** Mesma lógica de `NkiLayerVoice.resolveSample` — ver lá pro comentário
   *  completo (resolução perto do .exs, subpasta Samples/samples, e
   *  fallback case-insensitive pra Linux). */
  private async resolveSample(fileName: string, baseDir: string): Promise<AudioBuffer | null> {
    if (!baseDir || !fileName) return null;
    const candidates = [`${baseDir}/${fileName}`, `${baseDir}/Samples/${fileName}`, `${baseDir}/samples/${fileName}`];
    for (const candidate of candidates) {
      const audio = await this.tryLoadFile(candidate);
      if (audio) return audio;
    }
    const fallbackCandidates = [
      { dir: baseDir, segments: [fileName] },
      { dir: `${baseDir}/Samples`, segments: [fileName] },
      { dir: `${baseDir}/samples`, segments: [fileName] },
    ];
    for (const { dir, segments } of fallbackCandidates) {
      const resolvedPath = await this.resolveCaseInsensitive(dir, segments);
      if (!resolvedPath) continue;
      const audio = await this.tryLoadFile(resolvedPath);
      if (audio) return audio;
    }
    return null;
  }

  private async tryLoadFile(path: string): Promise<AudioBuffer | null> {
    try {
      const url = await window.api.fs.toFileUrl(path);
      const res = await fetch(url);
      if (!res.ok) return null;
      const arrayBuffer = await res.arrayBuffer();
      return await this.ctx.decodeAudioData(arrayBuffer.slice(0));
    } catch {
      return null;
    }
  }

  private async resolveCaseInsensitive(startDir: string, segments: string[]): Promise<string | null> {
    let currentDir = startDir;
    for (let i = 0; i < segments.length; i += 1) {
      let names: string[];
      try {
        names = await window.api.fs.listDirNames(currentDir);
      } catch {
        return null;
      }
      const wanted = segments[i].toLowerCase();
      const match = names.find((n) => n.toLowerCase() === wanted);
      if (!match) return null;
      currentDir = `${currentDir}/${match}`;
    }
    return currentDir;
  }

  private zonesFor(note: number, velocity: number): ResolvedExsZone[] {
    const matches = this.zones.filter(
      (z) => note >= z.keyLow && note <= z.keyHigh && (!z.velocityRangeOn || (velocity >= z.velocityLow && velocity <= z.velocityHigh))
    );
    return matches.length > 0 ? matches : this.zones.filter((z) => note >= z.keyLow && note <= z.keyHigh);
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
      const baseRate = Math.pow(2, (note - zone.key + zone.tuneCents / 100) / 12);
      src.playbackRate.value = baseRate * Math.pow(2, this.bendSemitones / 12);
      const gain = this.ctx.createGain();
      const linearGain = Math.pow(10, zone.gainDb / 20);
      const target = Math.max(0, Math.min(1, (velocity / 127) * linearGain));
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(target, now + ATTACK_SEC);
      let node: AudioNode = gain;
      if (zone.pan) {
        const panner = this.ctx.createStereoPanner();
        panner.pan.value = Math.max(-1, Math.min(1, zone.pan));
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
    this.unresolved = [];
  }
}
