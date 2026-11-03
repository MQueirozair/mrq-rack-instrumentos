// Tipos compartilhados entre o processo principal (Electron/Node) e a interface (renderer).

export type PartType =
  | 'Intro'
  | 'Verso'
  | 'Pré-refrão'
  | 'Refrão'
  | 'Instrumental'
  | 'Ponte'
  | 'Solo'
  | 'Tag'
  | 'Interlúdio'
  | 'Final'
  | 'Outra';

export interface SongPart {
  id: string;
  name: string;
  type: PartType;
  /** compasso inicial (1-based) */
  startBar: number;
  /** compasso final (exclusivo) */
  endBar: number;
  color: string;
  loop?: boolean;
  /**
   * "Cue de palco": endereço OSC opcional disparado automaticamente assim
   * que esta parte fica ativa (ex.: "/light/scene/3"), pra acionar uma cena
   * de iluminação/vídeo em outro software (QLab, Resolume, mesa de luz) no
   * exato momento em que a banda entra nessa parte — ver settings.osc e
   * HelpPanel.tsx seção "osc". null/undefined = nenhum cue configurado.
   */
  cueOscAddress?: string | null;
  /** Cue equivalente via MIDI Program Change (canal 0-15, programa 0-127), pra
   *  consoles/softwares que só aceitam MIDI em vez de OSC. */
  cueMidiProgram?: { channel: number; program: number } | null;
  /**
   * Anacruse/"levada": quantos tempos (beats) do compasso anterior essa parte
   * já começa a soar antes da cabeça do compasso marcado em startBar (ex.:
   * refrão que "entra" 2 tempos antes do compasso 17). 0/undefined = começa
   * exatamente na cabeça do compasso, sem anacruse. É só metadado de exibição
   * pro usuário lembrar a intenção — quem efetivamente controla onde a faixa
   * soa é o startBar fracionário (ex.: 16.5), que o app já suportava via
   * arraste livre na forma de onda (ver WaveformCanvas FREE_SNAP_STEP).
   */
  pickupBeats?: number;
  /**
   * De onde veio essa marcação, pra mostrar um selo de confiança/origem na
   * lista de partes: 'speech' = ouvida na locução da faixa guia (alta
   * confiança), 'audio' = sugerida só pela heurística de energia/silêncio
   * (revisar), 'manual' = criada/arrastada à mão pelo operador. undefined =
   * músicas importadas antes dessa marcação existir (tratar como manual).
   */
  detectionSource?: 'speech' | 'audio' | 'manual';
}

export interface ArrangementStep {
  partId: string;
  /**
   * Quantas vezes repetir esta parte antes de seguir (1 = toca uma vez).
   * 'infinite' = "repetir até eu desativar": fica em loop ao vivo até o
   * operador desarmar o botão de loop, só então o roteiro segue adiante.
   */
  repeat: number | 'infinite';
}

export interface SongArrangement {
  id: string;
  name: string;
  steps: ArrangementStep[];
}

export type TrackRole =
  | 'click'
  | 'guide'
  | 'drums'
  | 'bass'
  | 'guitar'
  | 'keys'
  | 'vocal'
  | 'choir'
  | 'loop'
  | 'other';

export interface SongTrack {
  id: string;
  name: string;
  /** caminho absoluto do arquivo de áudio no disco do usuário */
  filePath: string;
  role: TrackRole;
  /** faixa muda de tom junto com a música (pitch-shift) */
  followsKey: boolean;
  /** saída de áudio escolhida (id do par de canais do dispositivo, ou 'stereo-1-2' etc.) */
  output: string;
  volumeDb: number;
  muted: boolean;
  solo: boolean;
  /** picos de forma de onda desta faixa específica (0..1), para a tela "Faixas". */
  peaks?: number[] | null;
}

export interface ChordChartData {
  /** texto bruto colado pelo usuário, com marcações [NomeDaParte] e acordes em linha própria */
  raw: string;
  /** tom em que a cifra foi escrita */
  originalKey: string;
  capo: number;
}

export interface Song {
  id: string;
  title: string;
  /** pasta de origem no disco (não copiamos os áudios) */
  folderPath: string;
  originalKey: string;
  currentKey: string;
  originalBpm: number;
  currentBpm: number;
  timeSignatureNum: number;
  timeSignatureDen: number;
  durationSec: number;
  tracks: SongTrack[];
  parts: SongPart[];
  arrangements: SongArrangement[];
  activeArrangementId: string | null;
  chordChart: ChordChartData | null;
  /** picos de forma de onda pré-calculados por faixa guia/mix, para desenhar rápido */
  waveformPeaks: number[] | null;
  createdAt: number;
  updatedAt: number;
  /** marcada como favorita pelo usuário, para achar rápido na biblioteca */
  favorite?: boolean;
  /** anotações rápidas do operador sobre esta música (lembretes, combinados com a banda etc.) */
  notes?: string;
}

export interface SceneItem {
  songId: string;
  /** tom escolhido para esta música dentro desta cena (pode diferir do currentKey salvo) */
  key: string;
  bpm: number;
}

export interface Scene {
  id: string;
  name: string;
  items: SceneItem[];
}

/**
 * Modelo de estrutura reutilizável: a sequência típica de TIPOS de parte (não
 * partes de uma música específica) que uma banda costuma seguir — ex. "Louvor
 * padrão": Intro, Verso, Verso, Refrão, Verso, Refrão, Ponte, Refrão, Final.
 * Guardado uma vez na biblioteca e aplicável em qualquer música: ao aplicar,
 * o app casa cada passo do modelo com a primeira parte daquele tipo ainda não
 * usada na música atual (repetindo partes do mesmo tipo se o modelo pedir mais
 * do que a música tem). Ferramenta nova (ver HelpPanel.tsx seção "roteiro").
 */
export interface ArrangementTemplate {
  id: string;
  name: string;
  steps: { type: PartType; repeat: number | 'infinite' }[];
}

export interface Library {
  songs: Song[];
  scenes: Scene[];
  /** Modelos de estrutura de roteiro salvos pelo usuário (ver ArrangementTemplate). */
  arrangementTemplates?: ArrangementTemplate[];
}

export type ClickSound = 'beep' | 'click' | 'rimshot' | 'cowbell';

export interface ClickSettings {
  countInBars: number;
  sound: ClickSound;
  accentFirstBeat: boolean;
  volumeDb: number;
  output: string;
  /** dobrar o click em cima da música quando ela já tem click próprio */
  doubleClick: 'off' | 'on';
}

export interface PadSettings {
  timbre: string | null;
  volumeDb: number;
  exitOnPlay: boolean;
  output: string;
  fadeInOutSec: number;
  keyChangeCrossfadeSec: number;
  loopCrossfadeSec: number;
}

export interface RemoteSettings {
  enabled: boolean;
  port: number;
  pin: string;
}

/**
 * Ponte OSC (Open Sound Control) por UDP com software externo de produção —
 * luz, vídeo, ProPresenter-like, consoles — ver src-tauri/src/osc.rs e
 * HelpPanel.tsx seção "osc". Tecnologia nova adotada nesta versão (pedido
 * explícito do usuário de "2 novas tecnologias").
 */
export interface OscSettings {
  enabled: boolean;
  /** porta UDP local onde o MRQ escuta mensagens OSC recebidas (de um TouchOSC, QLab etc.) */
  listenPort: number;
  /** host/IP de destino pra onde o MRQ manda as mensagens OSC de transporte/cue */
  sendHost: string;
  /** porta UDP de destino */
  sendPort: number;
}

export type OscArgValue =
  | { type: 'i'; value: number }
  | { type: 'f'; value: number }
  | { type: 's'; value: string };

export interface OscMessage {
  address: string;
  args: OscArgValue[];
}

/**
 * "MRQ Sync": sincronismo de tempo/transporte entre instâncias do MRQ na
 * mesma rede local (ex.: o notebook do baterista seguindo o tom/BPM/estado de
 * reprodução de quem está liderando a música) — um protocolo próprio, leve,
 * via UDP broadcast (ver src-tauri/src/sync.rs). NÃO é o protocolo Ableton
 * Link (que exigiria uma biblioteca externa não disponível pra Rust neste
 * projeto) — é uma alternativa mais simples pensada só pra múltiplas
 * instâncias do MRQ, não para interoperar com outros DAWs/apps.
 */
export interface SyncSettings {
  enabled: boolean;
  /** 'leader' manda o estado pra rede; 'follower' escuta e segue quem for 'leader' */
  role: 'leader' | 'follower';
  /** porta UDP usada pelo broadcast local (mesma em todas as instâncias da rede) */
  port: number;
}

/** Forma (camelCase) do estado trocado pelo MRQ Sync entre o front-end e o Rust — ver src-tauri/src/sync.rs. */
export interface SyncBroadcastState {
  isPlaying: boolean;
  bpm: number;
  key: string;
  songTitle: string;
}

export interface MidiBinding {
  action: string;
  /** 'note' ou 'cc' */
  type: 'note' | 'cc';
  channel: number;
  number: number;
  /** para teclas por tipo de parte: qual tipo essa tecla ativa */
  partType?: PartType;
  /** para ações do Rack que têm uma camada específica (ex.: "rack:layer:volume"): índice da camada (0-5) */
  layerIndex?: number;
}

/**
 * Ações do Rack que podem ser mapeadas num CC/botão do teclado MIDI físico
 * (ver RackMidiCcPanel). "fader" = usa o VALOR contínuo (0-127) do CC pra
 * controlar algo direto (volume, reverb, transposição); "trigger" = qualquer
 * mensagem (nota ligada ou CC, não importa o valor) alterna um liga/desliga.
 */
export const RACK_CC_FADER_ACTIONS = [
  'rack:layer:volume',
  'rack:master:volume',
  'rack:master:reverb',
  'rack:master:transpose',
] as const;
export const RACK_CC_TRIGGER_ACTIONS = [
  'rack:layer:mute',
  'rack:layer:solo',
  'rack:layer:octaver',
  'rack:master:panic',
] as const;
export type RackCcAction = (typeof RACK_CC_FADER_ACTIONS)[number] | (typeof RACK_CC_TRIGGER_ACTIONS)[number];

/**
 * Rack de instrumentos "ao vivo" (6 camadas simultâneas tocadas por um teclado
 * MIDI físico). Cada camada carrega um arquivo de instrumento real do usuário:
 *  - 'sf2'     → SoundFont real (.sf2/.sf3), tocado via motor FluidSynth (WASM).
 *  - 'dx7'     → Banco/voz real de FM Yamaha DX7 (.syx), via núcleo MSFA (o mesmo
 *                motor que o Google abriu publicamente e que o Dexed usa).
 *  - 'sampler' → Amostra de áudio do próprio usuário (.wav/.aiff/.flac/.ogg/.mp3),
 *                usada como "piano por amostra" simples (um único sample
 *                reamostrado por tecla) — opção independente de 'npno', não um
 *                substituto dele.
 *  - 'npno'    → Biblioteca de piano Nord real (.npno), decodificada de fato
 *                (múltiplas camadas de velocidade reais por tecla) via o crate
 *                Rust "nord-format" compilado pra WebAssembly — ver NpnoLayerVoice.ts.
 *                Projeto comunitário/não-oficial (a Clavia nunca documentou o
 *                formato publicamente), mas decodifica o layout real do arquivo.
 *  - 'nki'     → Instrumento Kontakt real (.nki), decodificado de fato (samples +
 *                mapeamento de zonas/grupos por nota e velocidade) via parser
 *                próprio — ver NkiLayerVoice.ts. Só cobre Kontakt 1 a 4 (formato
 *                documentado publicamente, sem criptografia); bibliotecas
 *                comerciais modernas (Kontakt 4.2.2+) usam um formato
 *                criptografado pela própria Native Instruments e dão erro claro
 *                em vez de tentar (e falhar) decodificar.
 *  - 'mrq'     → Instrumento no formato `.mrq` do MRQ Instrument Converter (ver
 *                docs/mrq-instrument-converter/mrq-converter-architecture.md e mrqFormat.ts) — gerado a
 *                partir de SF2/SF3, NPNO/NSMP, SYX, NKI ou um arquivo de áudio
 *                avulso. Zonas/amostras vêm de metadado e PCM REAIS, lidos e
 *                decodificados pelo backend Rust (mrq_read_metadata/
 *                mrq_extract_sample — nunca no WebView) — ver MrqLayerVoice.ts.
 *                Só funciona rodando dentro do Tauri (sem equivalente no build
 *                Electron legado, igual ao resto do MRQ Instrument Converter).
 */
export type RackLayerFormat = 'sf2' | 'dx7' | 'sampler' | 'npno' | 'nsmp' | 'nki' | 'exs' | 'sfz' | 'mrqi' | 'mrq';


/** Ajuste rápido de timbre por camada (filtro + curva de velocidade, não altera o arquivo original). */
export type RackCharacter = 'original' | 'soft' | 'bright' | 'warm';

export interface RackPresetOption {
  /** para sf2: "banco:programa"; para dx7: índice da voz no banco; para sampler: não usado */
  value: string;
  label: string;
}

/** Tipo de saturação/drive aplicado por camada no painel "Editar". */
export type RackDriveType = 'warm' | 'hard' | 'tube';

/** Modo do oitavador da camada (ver RackLayer.octaverMode): em qual direção dobrar cada nota tocada nesta camada. */
export type RackOctaverMode = 'down' | 'up' | 'both';

/** Modo de voz da camada — ver RackLayer.playMode. */
export type RackPlayMode = 'poly' | 'mono';

/** Divisão de compasso usada pelo delay sincronizado (ver RackLayer.delaySync). */
export type RackDelayDivision = '1/16' | '1/8t' | '1/8' | '1/8d' | '1/4' | '1/4d' | '1/2';

/** Tipo de filtro na cauda do delay por camada — ver RackLayer.delayFilterType. */
export type RackDelayFilterType = 'off' | 'low' | 'high' | 'band';

/** Duração de cada divisão em "tempos" (1 tempo = 1 nota semínima/quarter note), pra converter BPM em milissegundos: ms = (60000/bpm) * tempos. */
export const RACK_DELAY_DIVISION_BEATS: Record<RackDelayDivision, number> = {
  '1/16': 0.25,
  '1/8t': 1 / 3,
  '1/8': 0.5,
  '1/8d': 0.75,
  '1/4': 1,
  '1/4d': 1.5,
  '1/2': 2,
};

/**
 * Padrão de sequência do arpejador por camada (ver RackLayer.arpPattern):
 * - 'up': sobe pela sequência de notas seguradas (+ oitavas extras).
 * - 'down': desce.
 * - 'updown'/'downup': sobe-desce / desce-sobe, sem repetir a nota do topo/base.
 * - 'order': ordem em que as teclas foram pressionadas (não reordena por altura).
 * - 'random': sorteia uma nota do conjunto a cada passo.
 * - 'chord': toca todas as notas seguradas (+ oitavas) juntas a cada passo, como uma batida.
 */
export type RackArpPattern = 'up' | 'down' | 'updown' | 'downup' | 'order' | 'random' | 'chord';

/** Divisão de compasso usada pelo arpejador quando RackLayer.arpSync=true. */
export type RackArpDivision = '1/4' | '1/8' | '1/8t' | '1/16' | '1/16t' | '1/32';

/** Duração de cada divisão em "tempos" (1 tempo = 1 semínima), mesmo princípio de RACK_DELAY_DIVISION_BEATS. */
export const RACK_ARP_DIVISION_BEATS: Record<RackArpDivision, number> = {
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
export const RACK_EQ_BAND_ROLES = ['lowcut', 'lowshelf', 'bell1', 'bell2', 'highshelf', 'highcut'] as const;
export type RackEqBandRole = typeof RACK_EQ_BAND_ROLES[number];

export const RACK_EQ_BAND_LABELS: Record<RackEqBandRole, string> = {
  lowcut: 'Corte grave',
  lowshelf: 'Prateleira grave',
  bell1: 'Sino 1',
  bell2: 'Sino 2',
  highshelf: 'Prateleira aguda',
  highcut: 'Corte agudo',
};

export interface RackEqBandSettings {
  enabled: boolean;
  freqHz: number;
  /** dB, -18..+18 — sem efeito nas bandas de corte (lowcut/highcut), que só usam freqHz e q (inclinação). */
  gainDb: number;
  q: number;
}

/** Valores padrão das 6 bandas, na ordem de RACK_EQ_BAND_ROLES. */
export function defaultRackEqBands(): RackEqBandSettings[] {
  return [
    { enabled: true, freqHz: 70, gainDb: 0, q: 0.71 }, // lowcut
    { enabled: true, freqHz: 150, gainDb: 0, q: 0.71 }, // lowshelf
    { enabled: true, freqHz: 280, gainDb: 0, q: 1.2 }, // bell1
    { enabled: true, freqHz: 2500, gainDb: 0, q: 0.9 }, // bell2
    { enabled: true, freqHz: 6000, gainDb: 0, q: 0.71 }, // highshelf
    { enabled: true, freqHz: 12000, gainDb: 0, q: 0.71 }, // highcut
  ];
}

export interface RackLayer {
  id: string;
  /** cor de destaque do cabeçalho da camada (combina com o print de referência) */
  color: string;
  format: RackLayerFormat | null;
  filePath: string | null;
  fileName: string | null;
  /** nome do instrumento/timbre carregado, mostrado em destaque no card */
  displayName: string | null;
  presets: RackPresetOption[];
  selectedPreset: string | null;
  character: RackCharacter;
  /** 0..1 */
  volume: number;
  muted: boolean;
  solo: boolean;
  /** nota MIDI em que a amostra foi gravada (só usado no formato 'sampler') */
  rootNote: number;
  /** imagem customizada do card (data URL), escolhida no painel "Editar"; null = ícone padrão */
  photoDataUrl: string | null;
  /** panorama estéreo da camada, -1 (esquerda) .. 1 (direita), 0 = centro */
  pan: number;

  // --- painel "Editar" (ver InstrumentRack.tsx: <LayerEditPanel>) ---
  /** nota MIDI mais grave que esta camada responde (0-127) */
  noteRangeStart: number;
  /** nota MIDI mais aguda que esta camada responde (0-127) */
  noteRangeEnd: number;
  /** transposição em oitavas aplicada só a esta camada (-3..3) */
  octave: number;
  /** canal MIDI de entrada que esta camada escuta; 0 = todos os canais */
  midiChannel: number;

  /** envelope de amplitude da camada (fade ao ligar/desligar notas, somado ao envelope nativo do motor) */
  envelopeEnabled: boolean;
  attackMs: number;
  /** tempo (ms) pra cair do pico do ataque até o nível de sustentação interno, antes de aguardar o note-off (ver RackEngine). */
  decayMs: number;
  releaseMs: number;

  /**
   * Modo de voz da camada: 'poly' toca cada nota numa voz independente
   * (acordes normalmente); 'mono' deixa só uma nota soando por vez nesta
   * camada (nota nova corta a anterior) — uso típico em baixo/lead/sopro solo.
   */
  playMode: RackPlayMode;
  /**
   * Em modo 'mono', se uma nota nova chegar enquanto outra ainda está
   * segurada nesta camada, não reataca o envelope (sem novo "attack") — em
   * vez disso desliza a afinação da MESMA voz até a nota nova, em glideMs.
   * Fora do modo mono não tem efeito (ver HelpPanel.tsx seção "rack").
   */
  legato: boolean;
  /** tempo (ms) do deslizamento de afinação (portamento) usado pelo legato em modo mono. 0 = troca instantânea. */
  glideMs: number;

  /** filtro passa-baixa estático da camada (independente do "Caráter") */
  filterEnabled: boolean;
  cutoffHz: number;

  /** equalizador de 3 bandas da camada — mantido por compatibilidade; a UI atual usa eqBands (6 bandas) abaixo. */
  eqEnabled: boolean;
  eqBassDb: number;
  eqMidDb: number;
  eqTrebleDb: number;
  eqMidFreqHz: number;
  /**
   * Equalizador paramétrico de 6 bandas (substituiu a UI de 3 bandas):
   * sempre as mesmas 6 funções, na ordem RACK_EQ_BAND_ROLES — Corte grave,
   * Prateleira grave, Sino 1, Sino 2, Prateleira aguda, Corte agudo. Cada
   * banda liga/desliga independente, além do interruptor geral eqEnabled.
   */
  eqBands: RackEqBandSettings[];


  /** saturação/drive da camada */
  driveEnabled: boolean;
  driveType: RackDriveType;
  driveDb: number;
  /** mistura seco/processado, 0..1 */
  driveMix: number;

  /**
   * Reverb por camada: controla quanto desta camada entra no barramento de
   * reverb compartilhado do Rack (cuja "quantidade" geral de retorno é o
   * knob MASTER > Reverb). Padrão enabled=true/send=1 preserva o
   * comportamento de versões anteriores, quando toda camada ia 100% pro
   * reverb sem controle individual.
   */
  reverbEnabled: boolean;
  /** 0..1 */
  reverbSend: number;

  /**
   * Compressor por camada — nivela a dinâmica de um timbre que varia muito de
   * volume. compressorAmount é o controle principal da UI atual (0..1, um só
   * knob "Amount" que ajusta threshold/ratio/makeup juntos); os três campos
   * antigos abaixo continuam existindo só por compatibilidade com sessões
   * salvas antes deste controle único existir.
   */
  compressorEnabled: boolean;
  /** 0..1 — controle único "Amount": quanto mais alto, mais threshold desce e mais a razão sobe (ver RackEngine). */
  compressorAmount: number;
  /** ms, 0..200 — tempo de resposta ao início do som. */
  compressorAttackMs: number;
  /** ms, 0..1000 — tempo de soltura depois que o som cai. */
  compressorReleaseMs: number;
  /**
   * Atalho "FAST" (igual ao botão da foto de referência): quando true, ignora
   * compressorAttackMs/compressorReleaseMs e usa um ataque/soltura bem
   * rápidos fixos (modo "limitador", pega transientes rápidos) — os dois
   * knobs continuam guardando o valor deles (ficam desabilitados na UI
   * enquanto FAST está ligado) pra voltar fácil ao ajuste manual.
   */
  compressorFast: boolean;
  /** dB, -60..0 — mantido por compatibilidade (sessões antigas); não editável na UI atual. */
  compressorThresholdDb: number;
  /** 1..20 (1 = sem compressão) — mantido por compatibilidade (sessões antigas); não editável na UI atual. */
  compressorRatio: number;
  /** ganho de compensação pós-compressor, em dB, 0..24 — mantido por compatibilidade (sessões antigas); não editável na UI atual. */
  compressorMakeupDb: number;

  /** Delay (eco) por camada. */
  delayEnabled: boolean;
  /** ms, 0..1500 — usado só quando delaySync=false. */
  delayTimeMs: number;
  /** 0..0.9 */
  delayFeedback: number;
  /** mistura seco/processado, 0..1 */
  delayMix: number;
  /** quando true, o tempo do delay segue o BPM do rack (ver InstrumentRackState.bpm) em vez de delayTimeMs. */
  delaySync: boolean;
  /** fração/divisão de compasso usada quando delaySync=true. */
  delayDivision: RackDelayDivision;
  /** true = ecos alternam entre os canais esquerdo/direito (eco "ping-pong" estéreo) em vez de repetir no mesmo canal. */
  delayPingPong: boolean;
  /**
   * "ANALOG" (igual ao botão da foto de referência): caráter de eco de fita
   * analógica — satura levemente cada repetição e adiciona uma oscilação sutil
   * de afinação (wow/flutter, como uma fita de verdade com variação de
   * velocidade do motor) — ver RackEngine.setDelay/createTapeSaturationCurve.
   */
  delayAnalog: boolean;
  /** Filtro na cauda do eco (igual ao menu "Filter" da foto) — cada repetição fica mais escura/fina/telefônica conforme o tipo. */
  delayFilterType: RackDelayFilterType;

  /** Chorus por camada — engrossa/alarga o timbre com uma modulação sutil de afinação. */
  chorusEnabled: boolean;
  /** mistura seco/processado, 0..1 */
  chorusMix: number;

  /** Tremolo por camada — modula o volume periodicamente. */
  tremoloEnabled: boolean;
  /** Hz, 0.1..20 */
  tremoloRateHz: number;
  /** 0..1 */
  tremoloDepth: number;
  /** 0..1 — quanto o LFO esquerdo/direito ficam fora de fase (0 = mono, 1 = totalmente oposto, efeito "auto-pan") */
  tremoloStereo: number;

  /**
   * Oitavador POR CAMADA: dobra toda nota tocada nesta camada (só nesta,
   * não nas outras) numa oitava abaixo/acima/ambas, pra engrossar o timbre
   * dela sem precisar duplicar o instrumento em outra camada. Era um
   * controle único do MASTER (afetava todas as camadas juntas) — por
   * pedido do usuário, virou independente por camada, pra poder ligar numa
   * e deixar outra de fora.
   */
  octaverEnabled: boolean;
  octaverMode: RackOctaverMode;
  /** 0..1 — volume relativo (fração da velocity original) das notas extras geradas pelo oitavador */
  octaverMix: number;

  /** Gate (porta de ruído) por camada — silencia o sinal abaixo de um limiar, útil em captações/samples com ruído de fundo. */
  gateEnabled: boolean;
  /** dB, -80..0 */
  gateThresholdDb: number;
  /** ms, 0..100 — quão rápido a porta abre quando o sinal cruza o limiar. */
  gateAttackMs: number;
  /** ms, 10..1000 — quão rápido a porta fecha depois que o sinal cai abaixo do limiar. */
  gateReleaseMs: number;

  /** Phaser por camada — filtros passa-tudo em cascata modulados por LFO, dá aquele "giro" característico. */
  phaserEnabled: boolean;
  /** Hz, 0.02..8 */
  phaserRateHz: number;
  /** 0..1 */
  phaserDepth: number;
  /** 0..1 */
  phaserMix: number;

  /** Flanger por camada — linha de delay bem curta modulada por LFO + realimentação, som metálico/"jato". */
  flangerEnabled: boolean;
  /** Hz, 0.02..5 */
  flangerRateHz: number;
  /** 0..1 */
  flangerDepth: number;
  /** 0..0.95 */
  flangerFeedback: number;
  /** 0..1 */
  flangerMix: number;

  /** Bitcrusher/Lo-Fi por camada — reduz resolução (bits) e taxa de amostragem de propósito, pra um timbre "retrô"/digital sujo. */
  bitcrusherEnabled: boolean;
  /** 1..16 bits */
  bitcrusherBits: number;
  /** Hz, 500..44100 — taxa de amostragem "efetiva" alvo (quanto menor, mais granulado/retrô). */
  bitcrusherRateHz: number;
  /** 0..1 */
  bitcrusherMix: number;

  /**
   * Shimmer por camada — variante etérea de reverb: desloca o sinal uma
   * oitava acima e realimenta numa cauda que vai clareando/sumindo,
   * diferente do reverb normal (MASTER). Autocontido por camada (não usa o
   * barramento de reverb compartilhado), pois depende de uma rede própria
   * de deslocamento de afinação por camada.
   */
  shimmerEnabled: boolean;
  /** 0..1 — quanto do sinal "brilhante" (deslocado em afinação, com cauda) é somado à saída. */
  shimmerMix: number;
  /** 0..0.92 — realimentação da cauda etérea; mais alto = cauda mais longa (pode acumular várias oitavas). */
  shimmerFeedback: number;
  /** Hz, 500..14000 — filtro passa-baixa dentro do loop de realimentação ("High Cut"), controla o brilho/abafamento da cauda. */
  shimmerToneHz: number;
  /** semitons, -12..+12 — quanto o pitch shifter interno do loop desloca o sinal (padrão clássico "shimmer" = +12). */
  shimmerShiftSemitones: number;
  /** 0..1 — coeficiente dos allpasses difusores dentro do loop do Shimmer; mais alto = cauda mais densa/suave, menos "eco" perceptível. */
  shimmerDiffusion: number;
  /** 0.3..2 — escala um delay extra dentro do loop de realimentação, dando sensação de "tamanho de sala" independente do Feedback. */
  shimmerSize: number;
  /** Hz, 20..2000 — filtro passa-alta dentro do loop de realimentação, tira grave/lama da cauda etérea. */
  shimmerLowCutHz: number;
  /** Hz, 0.05..5 — taxa do LFO de modulação sutil (chorus) dentro do loop, dá movimento/vida à cauda. */
  shimmerModRateHz: number;
  /** 0..1 — profundidade do LFO de modulação sutil dentro do loop. */
  shimmerModDepth: number;
  /** 'mono' = loop centralizado (mais "cru", artefato de pitch mais evidente); 'stereo' = duas difusões levemente diferentes por canal, cauda mais larga e suave. */
  shimmerReverbMode: RackShimmerReverbMode;
  /** 'single' = desloca só pra cima (ou só pra baixo, se Shift negativo) — som clássico Eno/Lanois; 'dual' = desloca pra cima E pra baixo ao mesmo tempo, dentro do mesmo loop — mais denso/sinfônico. */
  shimmerPitchMode: RackShimmerPitchMode;
  /** Atalho de tom (como Escuro/Claro do reverb MASTER): ajusta Low Cut/High Cut juntos pra uma cauda mais escura ou mais brilhante. */
  shimmerColor: RackShimmerColor;

  /**
   * Arpejador por camada — em vez de tocar normalmente, as notas seguradas
   * nesta camada alimentam um sequenciador que as dispara uma de cada vez
   * (ou em acorde, no modo 'chord') num ritmo fixo. Quando ligado, o modo de
   * voz (Poly/Mono/Legato) e o oitavador desta camada não se aplicam — o
   * arpejador assume o controle de quais notas soam e quando (ver
   * RackEngine.noteOn/noteOff e tickArpStep).
   */
  arpEnabled: boolean;
  arpPattern: RackArpPattern;
  /** quando true, o ritmo do arpejador segue o BPM do rack (ver InstrumentRackState.bpm) usando arpDivision; quando false, usa arpRateHz livre. */
  arpSync: boolean;
  /** Hz, 0.5..20 — usado só quando arpSync=false. */
  arpRateHz: number;
  /** fração/divisão de compasso usada quando arpSync=true. */
  arpDivision: RackArpDivision;
  /** 1..4 — quantas oitavas acima das notas seguradas o arpejador percorre. */
  arpOctaves: number;
  /** 0..1 — fração de cada passo em que a nota soa antes do note-off; 1 = liga (quase) sem respiro até o próximo passo. */
  arpGate: number;
  /** 0..0.75 — alterna passos mais longos/curtos pra dar um balanço (feel) às subdivisões, sem mudar o andamento médio. */
  arpSwing: number;
  /**
   * Modo "hold": quando ligado, o acorde continua arpejando mesmo depois de
   * soltar as teclas físicas, até você tocar um conjunto de notas novo
   * (que substitui o anterior) ou desligar o modo.
   */
  arpLatch: boolean;
}

/** Curva de resposta de velocidade aplicada à entrada MIDI física inteira do rack. */
export type RackVelocityCurve = 'linear' | 'soft' | 'hard';

/**
 * Uma "cena" é uma foto completa da configuração das 4 camadas (instrumento,
 * efeitos, roteamento de nota) + volume geral/reverb, salva com um nome pra
 * recall rápido — pensado pra trocar repertório/música ao vivo sem reconfigurar
 * tudo na mão. Pode ser recuperada manualmente (ver InstrumentRack.tsx) ou por
 * Program Change do teclado físico (a cena de índice N na lista = PC número N).
 */
export interface RackScene {
  id: string;
  name: string;
  layers: RackLayer[];
  masterVolume: number;
  reverb: number;
}

export interface InstrumentRackState {
  layers: RackLayer[];
  /** 0..1 */
  masterVolume: number;
  /** 0..1 */
  reverb: number;
  /** id do dispositivo MIDI físico escolhido para tocar o rack, ou null = todos conectados */
  midiInputId: string | null;
  /** curva de resposta de velocidade do teclado físico conectado */
  velocityCurve: RackVelocityCurve;
  /** transposição global (semitons) aplicada à entrada MIDI física antes de chegar nas camadas */
  transpose: number;
  /** se true, segura as notas liberadas enquanto o pedal de sustain (CC64) estiver pressionado */
  sustainEnabled: boolean;
  /**
   * Tamanho do buffer de áudio (em amostras) pedido ao sistema de som pro
   * AudioContext do Rack — ver painel MIDI (RackMidiPanel) e RackEngine.setBufferFrames.
   * 0 = Automático (pede o menor buffer que o navegador conseguir, o mesmo
   * comportamento de sempre). Valores > 0 pedem um alvo explícito: menor =
   * responde mais rápido ao teclado físico, porém mais exigente do
   * processador (risco de "crackles"); maior = mais estável, porém mais atraso.
   */
  bufferFrames: number;
  /** cenas salvas (configuração completa das 4 camadas) — ver RackScene */
  scenes: RackScene[];
  /** mostra (ou não) a pílula de acorde detectado ao lado de "Áudio OK", quando a aba Rack está aberta */
  chordDisplayEnabled: boolean;
  /**
   * "Mode" do reverb compartilhado do rack (algoritmo tipo plate do
   * Dattorro, ver RackEngine) — ao apertar SELECT na UI aplica um conjunto
   * de parâmetros (Size/Diffusion/Damping/Mod) típico daquele espaço, mas
   * Decay/Mix/Predelay/EQ/Bass Mult/Color continuam ajustáveis livremente
   * depois (igual Mode nos plugins de referência).
   */
  reverbRoom: RackReverbRoom;
  /** segundos, 0.2..8 — tempo de decaimento (RT60 aproximado) do reverb compartilhado. */
  reverbDecaySec: number;
  /**
   * Hz, 200..16000 — frequência de corte do passa-baixa de amortecimento
   * (damping) dentro do tanque do reverb ("Damping: HighFreq"); mais baixo =
   * cauda mais escura/abafada. Os botões ESCURO/CLARO da UI pulam pros
   * extremos; o parâmetro em si é contínuo.
   */
  reverbDampingHz: number;
  /** 0.4..3 — multiplicador do tempo de decaimento dos graves (abaixo de ~250Hz) em relação ao Decay geral ("Damping: BassMult"); >1 = graves duram mais, <1 = graves somem mais rápido que o resto. */
  reverbBassMult: number;
  /** ms, 0..200 — atraso antes do sinal entrar no tanque de reverb ("Predelay"); separa o ataque seco da cauda. */
  reverbPredelayMs: number;
  /** 0.4..1.8 — escala o comprimento de todas as linhas de delay internas do tanque ("Shape: Size"); maior = sala/espaço percebido maior. */
  reverbSize: number;
  /** 0..1 — mistura entre a cauda cheia (ataque suave, "swell") e um tap mais cedo/direto da difusão de entrada (ataque mais rápido/denso) — "Shape: Attack". */
  reverbAttack: number;
  /** 0..0.95 — coeficiente dos allpasses de difusão de ENTRADA (antes do tanque) — "Diffusion: Early". Mais alto = transiente de entrada mais borrado/suave. */
  reverbDiffusionEarly: number;
  /** 0..0.95 — coeficiente dos allpasses de difusão dentro do TANQUE (a cauda em si) — "Diffusion: Late". Mais alto = cauda mais densa e menos "eco"/metálica. */
  reverbDiffusionLate: number;
  /** Hz, 0.05..2 — taxa do LFO que modula os allpasses do tanque ("Mod: Rate"), evita colorações metálicas e dá vida à cauda. */
  reverbModRateHz: number;
  /** 0..1 — profundidade da modulação dos allpasses do tanque ("Mod: Depth"). */
  reverbModDepth: number;
  /** Hz, 10..500 — passa-alta no retorno final do reverb (depois do tanque) — "EQ: LowCut", tira lama/zumbido grave da cauda. */
  reverbEqLowCutHz: number;
  /** Hz, 1000..18000 — passa-baixa no retorno final do reverb — "EQ: HighCut", controla o brilho geral sem afetar o Damping interno do tanque. */
  reverbEqHighCutHz: number;
  /**
   * "Color" do reverb compartilhado — 'vintage' acrescenta uma saturação bem
   * sutil (WaveShaper) dentro do loop do tanque, simulando o leve "warmth"
   * de reverbs de hardware/plates antigos (ex. "1970s" das referências);
   * 'modern' deixa o loop limpo/linear.
   */
  reverbColor: RackReverbColor;
  /** BPM de referência do rack, usado pelos delays por camada quando "Sync" está ligado (ver RackLayer.delaySync). */
  bpm: number;
}

/** Tipo de sala/algoritmo do reverb compartilhado do Rack — ver InstrumentRackState.reverbRoom. */
export type RackReverbRoom = 'room' | 'hall' | 'plate' | 'spring' | 'stage' | 'booth';
/** Ver InstrumentRackState.reverbColor. */
export type RackReverbColor = 'vintage' | 'modern';
/** Ver RackLayer.shimmerReverbMode. */
export type RackShimmerReverbMode = 'mono' | 'stereo';
/** Ver RackLayer.shimmerPitchMode. */
export type RackShimmerPitchMode = 'single' | 'dual';
/** Ver RackLayer.shimmerColor. */
export type RackShimmerColor = 'dark' | 'bright';

export interface AppSettings {
  outputDeviceId: string | null;
  outputChannelCount: number;
  sampleRate: number;
  bufferSize: number;
  click: ClickSettings;
  pad: PadSettings;
  remote: RemoteSettings;
  osc: OscSettings;
  sync: SyncSettings;
  midiBindings: MidiBinding[];
  guideVoice: {
    track: string | null;
    outOfOrderBehavior: 'keep' | 'mute' | 'mute-and-announce';
  };
  /** tema de alto contraste / fontes maiores, pensado para telas de palco com pouca luz */
  stageMode: boolean;
  rack: InstrumentRackState;
  /**
   * Reconhecimento de partes por voz (beta, desligado por padrão): ouve a
   * locução da faixa guia anunciando cada parte (ex.: "Estrofe", "Refrão")
   * via um modelo de voz local (whisper.cpp) baixado sob demanda — ver
   * src/audio/SpeechPartRecognition.ts, src-tauri/src/speech.rs e a seção
   * "reconhecimento de partes" do HelpPanel. Desligado por padrão porque o
   * modelo é um download grande (~148MB) opcional, só baixado quando o
   * usuário liga essa opção de propósito.
   */
  speech: {
    enabled: boolean;
  };
}

export function emptyRackLayer(id: string, color: string): RackLayer {
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
export const RACK_LAYER_COUNT = 8;

/**
 * Índice (0-based) da última camada do Rack — ela é especial: em vez do
 * cartão compacto normal, a interface mostra a "Camada PAD" (ver
 * InstrumentRack.tsx/RackPadLayer.tsx), uma grade de 12 pads coloridos (uma
 * oitava cromática) pra tocar sem precisar de teclado MIDI físico nem abrir
 * o Teclado Virtual compartilhado — pensada pra quem quer disparar uma única
 * camada isoladamente com o mouse/touch. Aceita qualquer formato de
 * instrumento, igual as outras 7 — só a interface muda.
 */
export const RACK_PAD_LAYER_INDEX = RACK_LAYER_COUNT - 1;

export const DEFAULT_RACK_STATE: InstrumentRackState = {
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
export function migrateRackLayers(layers: RackLayer[]): RackLayer[] {
  const trimmed = layers.slice(0, RACK_LAYER_COUNT);
  const merged = trimmed.map((layer, i) => ({
    ...emptyRackLayer(layer?.id ?? `camada-${i + 1}`, layer?.color ?? '#888888'),
    ...layer,
  }));
  for (let i = merged.length; i < RACK_LAYER_COUNT; i++) {
    merged.push(DEFAULT_RACK_STATE.layers[i] ?? emptyRackLayer(`camada-${i + 1}`, '#888888'));
  }
  return merged;
}

export const DEFAULT_SETTINGS: AppSettings = {
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
  rack: DEFAULT_RACK_STATE,
  speech: {
    enabled: false,
  },
};

export const PART_COLORS: Record<PartType, string> = {
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

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Paleta vibrante pra grade de pads da Camada PAD (um tom por semitom da
// oitava, repetindo um conjunto de cores vivas) — usada só na UI da camada
// especial de pads, não tem relação com PART_COLORS (que é pra partes de
// música, tons mais discretos).
export const RACK_PAD_NOTE_COLORS = [
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

export function semitoneDistance(fromKey: string, toKey: string): number {
  const from = NOTE_NAMES.indexOf(normalizeNote(fromKey));
  const to = NOTE_NAMES.indexOf(normalizeNote(toKey));
  if (from < 0 || to < 0) return 0;
  let diff = to - from;
  if (diff > 6) diff -= 12;
  if (diff < -6) diff += 12;
  return diff;
}

export function normalizeNote(note: string): string {
  const map: Record<string, string> = {
    Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#',
    'C♭': 'B', 'E♯': 'F', 'B♯': 'C', 'F♭': 'E',
  };
  return map[note] ?? note;
}

// Mensagens trocadas entre a UI principal, o processo main e a página remota do celular.
export interface RemoteStateSnapshot {
  songTitle: string | null;
  isPlaying: boolean;
  currentKey: string;
  currentBpm: number;
  parts: { id: string; name: string; index: number }[];
  activePartId: string | null;
  positionSec: number;
  durationSec: number;
  /** acorde detectado agora no Rack (ver ChordIndicator.tsx), pra broadcast ao vivo pros celulares da banda; null = nenhuma nota soando/Rack não usado */
  currentChord: string | null;
}

export type RemoteCommand =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'stop' }
  | { type: 'jumpToPart'; partId: string }
  | { type: 'setKey'; key: string }
  | { type: 'setBpm'; bpm: number }
  | { type: 'toggleLoop' };
