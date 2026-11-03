/**
 * Parser puro (sem nenhuma API de navegador) do contêiner binário do Logic
 * EXS24 (.exs) — formato do antigo sampler "EXS24" do Logic Pro (hoje
 * renomeado "Sampler", mas que ainda lê/grava `.exs` pra compatibilidade).
 *
 * Ao contrário do `.nki` (Kontakt), o `.exs` NUNCA foi criptografado pela
 * Apple — é um formato binário aberto (embora nunca oficialmente
 * documentado), só com endereçamento/alinhamento pouco óbvio. A referência
 * usada aqui é o código-fonte do ConvertWithMoss (Jürgen Moßgraber,
 * https://github.com/git-moss/ConvertWithMoss, LGPLv3), projeto open-source
 * ativo e mantido especificamente dedicado a converter formatos de
 * multi-sample — é, até onde se pôde confirmar, a implementação pública
 * mais completa e testada contra arquivos `.exs` reais (Logic Factory
 * Content, Auto Sampler etc.) disponível hoje. Os campos e offsets abaixo
 * replicam deliberadamente `EXS24Block.java`/`EXS24Zone.java`/
 * `EXS24Group.java`/`EXS24Sample.java` desse projeto, byte a byte — nenhum
 * campo aqui é um "chute" novo.
 *
 * Por ser puro binário (sem XML, sem zlib), este módulo não depende de
 * `DOMParser`/`DecompressionStream`/navegador nenhum — testável 100% em
 * Node puro (ver scripts/test-exs-import.mjs), diferente do `.nki`
 * (NkiLayerVoice.ts), cujo parsing real só roda dentro de um WebView.
 */

// ---------------------------------------------------------------------------
// Tipos de bloco (ver EXS24Block.TYPE_* em EXS24Block.java)
// ---------------------------------------------------------------------------

export const EXS_BLOCK_TYPE = {
  INSTRUMENT: 0x00,
  ZONE: 0x01,
  GROUP: 0x02,
  SAMPLE: 0x03,
  PARAMS: 0x04,
  TAGGED_RECORDS: 0x05,
  UNKNOWN_1: 0x07,
  UNKNOWN_2: 0x08,
  BPLIST_SAMPLER_LAYOUT: 0x0a,
  BPLIST_MACOS_PLIST: 0x0b,
} as const;

const BIG_ENDIAN_MAGIC = new Set(['SOBT', 'SOBJ']);
const LITTLE_ENDIAN_MAGIC = new Set(['TBOS', 'JBOS']);

export interface ExsZone {
  id: number;
  name: string;
  /** Tecla raiz (nota MIDI 0-127) que reproduz a amostra sem transposição. */
  key: number;
  keyLow: number;
  keyHigh: number;
  velocityRangeOn: boolean;
  velocityLow: number;
  velocityHigh: number;
  /** Afinação fina em cents (já somada: coarseTuning*100 + fineTuning — ver
   *  `zone.setTuning` em EXS24Detector.java, que soma coarseTuning (semitons)
   *  + fineTuning/100 (fração de semitom); aqui mantemos tudo em cents, que
   *  é a unidade que o resto do projeto usa (ver NkiZone.tuneCents). */
  tuneCents: number;
  /** `false` quando o switch "Pitch" da zona está desligado no Logic — a
   *  amostra toca na mesma altura em qualquer tecla (comum em kits de
   *  bateria/one-shots). O Rack deste app sempre aplica rastreamento de
   *  pitch por nota (não existe um modo "sem pitch" no motor), então quando
   *  isto é `false` limitamos key/keyLow/keyHigh à própria tecla raiz — a
   *  zona só dispara na nota exata, nunca transposta — em vez de fingir que
   *  o rastreamento está ativo (ver compatibilidade "aproximado" no
   *  relatório de exsImport.ts). */
  pitch: boolean;
  /** Ganho em dB já combinando o ajuste da zona com o do grupo (quando
   *  houver) — ver `zone.setGain`/`limitByGroupAttributes` em
   *  EXS24Detector.java. */
  gainDb: number;
  /** Pan normalizado -1 (esquerda) a 1 (direita), já combinando zona + grupo. */
  pan: number;
  groupIndex: number;
  sampleIndex: number;
  /** `true` quando a amostra referenciada por esta zona não é um arquivo
   *  avulso comum (começa no meio de um áudio consolidado de várias zonas,
   *  ou está marcada como comprimida internamente) — ver `ExsSample.
   *  waveDataStart`/`isCompressed`. Replicar a extração correta desses
   *  casos (formato CAF/ACE consolidado da Apple) está fora do escopo
   *  atual; zonas assim NUNCA são silenciosamente ignoradas — aparecem no
   *  relatório de compatibilidade como `unsupported-codec`, igual ao `.ncw`
   *  do Kontakt. */
  unsupportedAudio: boolean;
}

export interface ExsSample {
  /** Nome do bloco (cabeçalho de 64 bytes) — usado como nome de arquivo de
   *  fallback quando `fileName` não está presente (ver EXS24Sample.read:
   *  "If not present the name from the header is used!"). */
  blockName: string;
  fileName: string;
  filePath: string;
  sampleRate: number;
  bitDepth: number;
  channels: number;
  waveDataStart: number;
  isCompressed: boolean;
}

export interface ExsGroup {
  name: string;
  /** Ganho em dB (-96 a +24), raw já decodificado como complemento de dois. */
  volume: number;
  /** Pan raw (-64 a +63 teórico, mas o Logic usa só -50..50 — ver
   *  EXS24Detector.java) — normalizado pra -1..1 é feito em `buildZones`. */
  pan: number;
}

export interface ExsInstrument {
  name: string;
}

export interface ParsedExsFile {
  instrument: ExsInstrument | null;
  zones: ExsZone[];
  groups: Map<number, ExsGroup>;
  samples: ExsSample[];
}

// ---------------------------------------------------------------------------
// Cursor de leitura — nunca lança por acabar o buffer (um bloco com menos
// dados do que o campo mais recente documentado só gera zeros pros campos
// que faltaram, em vez de abortar o arquivo inteiro; ver comentário de
// EXS24Zone.read: "There are files with more data ... which is currently
// not used" — ou seja, o inverso (menos dados que o esperado) também
// acontece na prática e merece a mesma tolerância).
// ---------------------------------------------------------------------------

class Cursor {
  pos = 0;
  constructor(
    private view: DataView,
    private bigEndian: boolean
  ) {}

  get remaining(): number {
    return Math.max(0, this.view.byteLength - this.pos);
  }

  u8(): number {
    if (this.remaining < 1) return 0;
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }

  i8(): number {
    const raw = this.u8();
    return raw > 127 ? raw - 256 : raw;
  }

  u16(): number {
    if (this.remaining < 2) {
      this.pos = this.view.byteLength;
      return 0;
    }
    const v = this.view.getUint16(this.pos, !this.bigEndian);
    this.pos += 2;
    return v;
  }

  u32(): number {
    if (this.remaining < 4) {
      this.pos = this.view.byteLength;
      return 0;
    }
    const v = this.view.getUint32(this.pos, !this.bigEndian);
    this.pos += 4;
    return v;
  }

  i32(): number {
    if (this.remaining < 4) {
      this.pos = this.view.byteLength;
      return 0;
    }
    const v = this.view.getInt32(this.pos, !this.bigEndian);
    this.pos += 4;
    return v;
  }

  skip(n: number): void {
    this.pos = Math.min(this.view.byteLength, this.pos + n);
  }

  ascii(len: number): string {
    const end = Math.min(this.view.byteLength, this.pos + len);
    const bytes: number[] = [];
    for (let i = this.pos; i < end; i++) bytes.push(this.view.getUint8(i));
    this.pos = end;
    // corta no primeiro \0 (StringUtils.removeCharactersAfterZero) e ignora
    // bytes não-ASCII-imprimíveis que sobrarem de lixo/padding.
    const zeroIdx = bytes.indexOf(0);
    const usable = zeroIdx >= 0 ? bytes.slice(0, zeroIdx) : bytes;
    return usable.map((b) => String.fromCharCode(b)).join('');
  }
}

interface RawBlock {
  type: number;
  bigEndian: boolean;
  name: string;
  content: DataView;
}

/** Lê todos os blocos do arquivo sequencialmente — réplica de
 *  `EXS24Block.read` (84 bytes de cabeçalho fixo + `size` bytes de
 *  conteúdo, repetido até o fim do arquivo). Lança um erro específico e
 *  claro assim que o PRIMEIRO bloco não bate com o formato esperado (magic
 *  bytes desconhecido) — isso cobre o caso comum de alguém apontar um
 *  arquivo que não é um `.exs` de verdade (ex.: um `.exs` do Elixir, ou
 *  lixo renomeado). Blocos depois do primeiro que vierem com magic
 *  desconhecido são só ignorados (mesmo comportamento de "default" do
 *  switch em EXS24File.read — a Apple adicionou tipos de bloco novos ao
 *  longo dos anos, ex. BPLIST, que não afetam o mapeamento de
 *  instrumento/zona/grupo/amostra que este app precisa). */
export function readExsBlocks(buffer: ArrayBuffer): RawBlock[] {
  const blocks: RawBlock[] = [];
  const fullView = new DataView(buffer);
  let offset = 0;
  let first = true;
  while (offset < buffer.byteLength) {
    if (buffer.byteLength - offset < 84) break; // sobra de padding/lixo no fim, não um bloco de verdade
    const endianByte = fullView.getUint8(offset);
    const bigEndian = endianByte === 0;
    // version1/version2 — ver comentário em EXS24Block.read: a checagem
    // original só falha quando os DOIS valores fogem do esperado ao mesmo
    // tempo (condição propositalmente frouxa, replicada aqui de propósito
    // pra manter compatibilidade bit-a-bit com arquivos reais que o
    // ConvertWithMoss já comprovou conseguir ler).
    const version1 = fullView.getUint8(offset + 1);
    const version2 = fullView.getUint8(offset + 2);
    const typeAndFlags = fullView.getUint8(offset + 3);
    const type = typeAndFlags & 0x0f;
    let size = fullView.getUint32(offset + 4, !bigEndian);
    if ((typeAndFlags & 0x80) !== 0) size &= 0x7fff;
    // Layout do cabeçalho de 84 bytes (ver EXS24Block.read): byte 0 = flag de
    // endianness, byte 1-2 = versão, byte 3 = tipo+flags, bytes 4-7 = size
    // (u32), bytes 8-11 = index (u32, não usado aqui), bytes 12-15 = flags
    // reservadas (u32, não usadas), bytes 16-19 = magic (4 ascii), bytes
    // 20-83 = nome (64 ascii) — total 84 bytes antes do conteúdo do bloco.
    const magicBytes = [
      fullView.getUint8(offset + 16),
      fullView.getUint8(offset + 17),
      fullView.getUint8(offset + 18),
      fullView.getUint8(offset + 19),
    ];
    const magic = magicBytes.map((b) => String.fromCharCode(b)).join('');
    const validMagic = bigEndian ? BIG_ENDIAN_MAGIC.has(magic) : LITTLE_ENDIAN_MAGIC.has(magic);
    if (!validMagic) {
      if (first) {
        throw new Error(
          `Este arquivo não parece ser um .exs do Logic/EXS24 (assinatura "${magic || '(vazia)'}" não reconhecida no primeiro bloco).`
        );
      }
      break; // bloco de cauda desconhecido (ex.: dados de metadado extra) — ignora o resto, já temos tudo que precisamos
    }
    if (first && version1 !== 1 && version2 !== 0) {
      throw new Error(`Versão de bloco .exs não reconhecida (${version1}.${version2}).`);
    }
    first = false;
    const nameStart = offset + 20;
    const nameBytes: number[] = [];
    for (let i = 0; i < 64; i++) nameBytes.push(fullView.getUint8(nameStart + i));
    const zeroIdx = nameBytes.indexOf(0);
    const name = (zeroIdx >= 0 ? nameBytes.slice(0, zeroIdx) : nameBytes).map((b) => String.fromCharCode(b)).join('');
    const contentStart = offset + 84;
    const contentEnd = Math.min(buffer.byteLength, contentStart + size);
    const content = new DataView(buffer, contentStart, contentEnd - contentStart);
    blocks.push({ type, bigEndian, name, content });
    offset = contentEnd;
    if (contentEnd <= contentStart && size > 0) break; // segurança: nunca travar em loop infinito com um size inconsistente
  }
  return blocks;
}

function parseZone(block: RawBlock, id: number): ExsZone {
  const c = new Cursor(block.content, block.bigEndian);
  const zoneOpts = c.u8();
  const oneshot = (zoneOpts & 0x01) !== 0;
  const pitch = (zoneOpts & 0x02) === 0; // bit invertido — ver EXS24Zone.read
  // reverse (bit 2) e oneshot não afetam o mapeamento básico que este app usa hoje.
  void oneshot;
  const key = c.u8();
  const fineTuning = c.i8();
  const pan = c.i8();
  const volumeAdjust = c.i8();
  c.u8(); // volumeScale — não usado
  const keyLow = c.u8();
  const keyHigh = c.u8();
  c.skip(1);
  const velocityLow = c.u8();
  const velocityHigh = c.u8();
  c.skip(1);
  c.u32(); // sampleStart — não aplicado na reprodução (ver nota de escopo do módulo)
  c.u32(); // sampleEnd
  c.u32(); // loopStart
  c.u32(); // loopEnd
  c.u32(); // loopCrossfade
  c.u8(); // loopTune
  c.u8(); // loopOptions
  c.u8(); // loopDirection
  c.skip(42);
  c.u8(); // flexOptions
  c.u8(); // flexSpeed
  c.u8(); // tailTune
  const coarseTuning = c.i8();
  c.skip(1);
  c.u8(); // output
  c.skip(5);
  const groupIndex = c.i32();
  const sampleIndex = c.i32();

  const velocityRangeOn = (zoneOpts & 0x08) !== 0;
  return {
    id,
    name: block.name,
    key,
    keyLow,
    keyHigh,
    velocityRangeOn,
    velocityLow,
    velocityHigh,
    tuneCents: pitch ? coarseTuning * 100 + fineTuning : 0,
    pitch,
    gainDb: volumeAdjust,
    pan: Math.max(-1, Math.min(1, pan / 50)),
    groupIndex,
    sampleIndex,
    unsupportedAudio: false, // preenchido depois, em buildZones, quando a amostra referenciada é conhecida
  };
}

function parseGroup(block: RawBlock): ExsGroup {
  const c = new Cursor(block.content, block.bigEndian);
  const volume = c.i8();
  const pan = c.i8();
  return { name: block.name, volume, pan };
}

function parseSample(block: RawBlock): ExsSample {
  const c = new Cursor(block.content, block.bigEndian);
  const waveDataStart = c.u32();
  c.u32(); // length (frames) — redundante com o que decodeAudioData já devolve
  const sampleRate = c.u32();
  const bitDepth = c.u32();
  const channels = c.u32();
  c.u32(); // channels2
  c.skip(4);
  c.ascii(4); // type ("WAVE"/"AIFF"/...) — não precisamos, a extensão do fileName já basta
  c.u32(); // size
  const isCompressed = c.u32() > 0;
  c.skip(40);
  const filePath = c.ascii(256);
  const fileName = c.remaining > 0 ? c.ascii(256) : block.name;
  return {
    blockName: block.name,
    fileName: fileName || block.name,
    filePath,
    sampleRate,
    bitDepth,
    channels,
    waveDataStart,
    isCompressed,
  };
}

/** Parse completo de um `.exs` já carregado em memória — devolve a lista de
 *  zonas já com ganho/pan combinados do grupo (quando houver) e a flag
 *  `unsupportedAudio` resolvida contra a amostra referenciada. Não resolve
 *  nenhum arquivo em disco nem decodifica áudio — isso é trabalho de
 *  `ExsLayerVoice` (a única parte que de fato precisa rodar num navegador). */
export function parseExsFile(buffer: ArrayBuffer): ParsedExsFile {
  const blocks = readExsBlocks(buffer);
  let instrument: ExsInstrument | null = null;
  const zones: ExsZone[] = [];
  const groups = new Map<number, ExsGroup>();
  const samples: ExsSample[] = [];
  let zoneCounter = 0;
  let groupCounter = 0;
  for (const block of blocks) {
    switch (block.type) {
      case EXS_BLOCK_TYPE.INSTRUMENT:
        instrument = { name: block.name };
        break;
      case EXS_BLOCK_TYPE.ZONE:
        zones.push(parseZone(block, zoneCounter++));
        break;
      case EXS_BLOCK_TYPE.GROUP:
        groups.set(groupCounter++, parseGroup(block));
        break;
      case EXS_BLOCK_TYPE.SAMPLE:
        samples.push(parseSample(block));
        break;
      default:
        // Parameters/TaggedRecords/BPLIST/etc. — filtro de efeitos/matriz de
        // modulação do EXS24, fora do escopo deste conversor (mesmo
        // princípio já aplicado ao KSP do Kontakt, ver nkiImport.ts).
        break;
    }
  }

  // "Uma zona referencia sua amostra pelo índice dela. Uma zona sem amostra
  // é gravada com índice -1 [...]. Só quando NENHUMA zona referencia uma
  // amostra é que se assume que elas tocam as amostras na própria ordem" —
  // réplica exata da heurística de EXS24Detector.readEXSFile (arquivos
  // antigos/exportados por outras ferramentas às vezes omitem o índice).
  if (zones.length > 0 && zones.every((z) => z.sampleIndex < 0)) {
    zones.forEach((z, i) => {
      z.sampleIndex = i;
    });
  }

  // Combina ganho/pan do grupo na própria zona (ver limitByGroupAttributes +
  // getOrCreateGroup em EXS24Detector.java) e resolve unsupportedAudio
  // contra a amostra referenciada.
  for (const zone of zones) {
    const group = groups.get(zone.groupIndex);
    if (group) {
      zone.gainDb = Math.max(-96, Math.min(24, zone.gainDb + group.volume));
      zone.pan = Math.max(-1, Math.min(1, zone.pan + Math.max(-50, Math.min(50, group.pan)) / 50));
    }
    const sample = zone.sampleIndex >= 0 ? samples[zone.sampleIndex] : undefined;
    zone.unsupportedAudio = !sample || sample.waveDataStart !== 0 || sample.isCompressed;
    if (!zone.pitch) {
      // Zona sem rastreamento de pitch — ver comentário do campo na
      // interface ExsZone acima: trava a zona na própria tecla raiz.
      zone.keyLow = zone.key;
      zone.keyHigh = zone.key;
    }
  }

  return { instrument, zones, groups, samples };
}
