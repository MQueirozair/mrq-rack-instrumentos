import type { RackPresetOption } from '../../../shared/types';
import { unzlibSync } from 'fflate';

const ATTACK_SEC = 0.003;
const RELEASE_SEC = 0.12;

/**
 * Tamanho fixo do cabeçalho binário na frente de todo .nki do Kontakt 1 a 4
 * (antes de começar o fluxo zlib com o XML do instrumento). Esse número (170)
 * não é um chute: vem do código-fonte público do nkitool (domínio público,
 * Christian Schoenebeck / projeto LinuxSampler — ver comentário da classe
 * abaixo), a única ferramenta que já documentou esse formato de verdade.
 * A partir do Kontakt 4.2.2 a NI mudou o formato pra um binário criptografado
 * — esse cabeçalho de 170 bytes some e o fluxo deixa de ser zlib válido, o
 * que detectamos abaixo e reportamos como erro claro, sem fingir que abriu.
 */
const NKI_HEADER_SIZE = 170;

/** Por que uma amostra referenciada pelo .nki não virou áudio tocável —
 *  exposto via `NkiLayerVoice.unresolvedSamples` pra quem converte/inspeciona
 *  o instrumento (ver nkiImport.ts, Fase 6 do MRQ Instrument Converter)
 *  poder relatar o motivo de verdade, em vez de só "não encontrada" (ver §6
 *  do documento de arquitetura: nunca fingir sucesso parcial sem dizer por
 *  quê). `unsupported-codec` é o caso de uma zona referenciar `.ncw`
 *  (NI Compressed Wave, formato proprietário sem decoder nativo no
 *  navegador/WebView) — isso NÃO é "arquivo não encontrado", é uma
 *  limitação de formato que nenhuma quantidade de busca em disco resolve. */
export interface NkiUnresolvedSample {
  samplePath: string;
  reason: 'not-found' | 'unsupported-codec';
}

interface NkiZone {
  samplePath: string;
  rootNote: number;
  loNote: number;
  hiNote: number;
  loVel: number;
  hiVel: number;
  tuneCents: number;
  volume: number;
  pan: number;
}

/** Nomes de propriedade (minúsculos) aceitos pra cada campo de uma zona — o
 *  schema exato do XML do Kontakt nunca foi publicado pela NI, então em vez
 *  de arriscar um único nome de atributo "chutado", aceitamos várias
 *  variações plausíveis (inglês, abreviações comuns de sampler) e casamos
 *  por substring, não por igualdade exata. */
const FIELD_ALIASES = {
  sample: ['sample', 'samplefile', 'filename', 'file'],
  root: ['rootnote', 'root', 'originalkey', 'unitynote', 'pitchkeycenter'],
  loNote: ['lownote', 'lonote', 'minnote', 'keyrangemin', 'lokey', 'lowkey'],
  hiNote: ['highnote', 'hinote', 'maxnote', 'keyrangemax', 'hikey', 'highkey'],
  loVel: ['lowvelocity', 'lovel', 'minvelocity', 'velocityrangemin'],
  hiVel: ['highvelocity', 'hivel', 'maxvelocity', 'velocityrangemax'],
  tune: ['finetune', 'tune', 'detune', 'tuning'],
  volume: ['volume', 'gain', 'level'],
  pan: ['pan', 'panning'],
} as const;

function matchAlias(name: string, aliases: readonly string[]): boolean {
  const n = name.toLowerCase();
  return aliases.some((a) => n === a || n.endsWith(a) || n.includes(a));
}

/** Extrai o nome da nota a partir do nome do arquivo (ex.: "Piano_C3.wav",
 *  "Strings-060.wav") quando a zona não trouxe uma nota raiz explícita —
 *  convenção comum em bibliotecas de amostra multi-zona. */
function guessRootNoteFromFileName(fileName: string): number | null {
  const base = fileName.replace(/\.[^.]+$/, '');
  const noteNameMatch = base.match(/(?:^|[^a-zA-Z])([A-Ga-g])(#|s|b)?(-?\d)(?:[^0-9]|$)/);
  if (noteNameMatch) {
    const letters: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
    let semitone = letters[noteNameMatch[1].toLowerCase()];
    if (noteNameMatch[2] === '#' || noteNameMatch[2] === 's') semitone += 1;
    if (noteNameMatch[2] === 'b') semitone -= 1;
    const octave = parseInt(noteNameMatch[3], 10);
    const note = (octave + 1) * 12 + semitone;
    if (note >= 0 && note <= 127) return note;
  }
  const numericMatch = base.match(/(?:^|[^0-9])(\d{2,3})(?:[^0-9]|$)/);
  if (numericMatch) {
    const n = parseInt(numericMatch[1], 10);
    if (n >= 0 && n <= 127) return n;
  }
  return null;
}

/** Junta, pra um elemento do XML, tanto seus atributos "normais"
 *  (`<Zone Sample="..." RootNote="60">`) quanto um possível padrão
 *  genérico de par nome/valor em elementos filhos (`<attribute><name>
 *  Sample</name><value>...</value></attribute>`), já que a NI usa os dois
 *  estilos em partes diferentes de seus formatos — reunir os dois aumenta a
 *  chance de reconhecer o campo certo sem depender de um nome fixo. */
function collectPropertyBag(el: Element): Map<string, string> {
  const bag = new Map<string, string>();
  for (const attr of Array.from(el.attributes)) {
    bag.set(attr.name.toLowerCase(), attr.value);
  }
  for (const child of Array.from(el.children)) {
    const tag = child.tagName.toLowerCase();
    if (tag === 'attribute' || tag === 'property' || tag === 'parameter') {
      const nameEl = child.querySelector(':scope > name, :scope > key');
      const valueEl = child.querySelector(':scope > value');
      if (nameEl?.textContent && valueEl?.textContent) {
        bag.set(nameEl.textContent.trim().toLowerCase(), valueEl.textContent.trim());
      }
    }
  }
  return bag;
}

function readField(bag: Map<string, string>, aliases: readonly string[]): string | null {
  for (const [key, value] of bag) {
    if (matchAlias(key, aliases)) return value;
  }
  return null;
}

function readNumberField(bag: Map<string, string>, aliases: readonly string[], fallback: number): number {
  const raw = readField(bag, aliases);
  if (raw == null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function looksLikeSamplePath(value: string): boolean {
  return /\.(wav|wave|aif|aiff|ncw)$/i.test(value.trim());
}

/** Sobe pela árvore a partir de `el` (sem passar de `stopAt`, exclusive) juntando
 *  a "mala de propriedades" de cada ancestral — zona, grupo e programa costumam
 *  compartilhar campos (faixa de tecla/velocidade, afinação, volume, pan) em
 *  níveis diferentes dependendo de como o patch foi montado, então em vez de
 *  olhar só o pai imediato (que perdia campos definidos no Grupo/Programa),
 *  mesclamos até 5 níveis acima — o nível mais próximo da zona sempre vence. */
function collectAncestryBag(el: Element, stopAt: Element | null): Map<string, string> {
  const chain: Element[] = [];
  let cur: Element | null = el;
  for (let depth = 0; depth < 5 && cur && cur !== stopAt; depth++) {
    chain.push(cur);
    cur = cur.parentElement;
  }
  // do mais distante (Programa) pro mais próximo (Zona), pra que o campo da
  // zona sempre sobrescreva o do grupo/programa quando os dois existirem.
  const merged = new Map<string, string>();
  for (const node of chain.reverse()) {
    for (const [k, v] of collectPropertyBag(node)) merged.set(k, v);
  }
  return merged;
}

/** Varre a subárvore a partir de `root` procurando, em cada elemento, um valor
 *  de propriedade que pareça caminho de amostra — sem depender do nome exato
 *  da tag ("Zone", "Sample" etc. nunca foram confirmados publicamente pela
 *  NI para essa versão do formato). Quando acha, mescla os campos dos
 *  ancestrais mais próximos (zona → grupo → programa) pra montar o
 *  mapeamento de tecla/velocidade/afinação da zona. Se `boundary` for
 *  passado, a varredura não desce dentro de nenhum outro elemento que também
 *  bata com `boundary` (usado pra não misturar zonas de programas/grupos de
 *  timbre diferentes quando o .nki tem mais de um). */
function extractZones(root: Element, opts?: { boundary?: (el: Element) => boolean }): NkiZone[] {
  const zones: NkiZone[] = [];
  const seen = new Set<Element>();
  const walk = (el: Element, isSubroot: boolean) => {
    if (!isSubroot && opts?.boundary?.(el)) return; // outro grupo/programa — não entra
    const bag = collectPropertyBag(el);
    const sampleValue = readField(bag, FIELD_ALIASES.sample);
    if (sampleValue && looksLikeSamplePath(sampleValue) && !seen.has(el)) {
      seen.add(el);
      const merged = collectAncestryBag(el, root.parentElement);
      const fileName = sampleValue.split(/[\\/]/).pop() ?? sampleValue;
      const guessedRoot = guessRootNoteFromFileName(fileName);
      zones.push({
        samplePath: sampleValue,
        rootNote: readNumberField(merged, FIELD_ALIASES.root, guessedRoot ?? 60),
        loNote: readNumberField(merged, FIELD_ALIASES.loNote, 0),
        hiNote: readNumberField(merged, FIELD_ALIASES.hiNote, 127),
        loVel: readNumberField(merged, FIELD_ALIASES.loVel, 0),
        hiVel: readNumberField(merged, FIELD_ALIASES.hiVel, 127),
        tuneCents: readNumberField(merged, FIELD_ALIASES.tune, 0),
        volume: readNumberField(merged, FIELD_ALIASES.volume, 1),
        pan: readNumberField(merged, FIELD_ALIASES.pan, 0),
      });
      return; // já é folha (zona); não precisa descer mais nesse ramo
    }
    for (const child of Array.from(el.children)) walk(child, false);
  };
  walk(root, true);
  return zones;
}

/** Identifica, dentro do XML, possíveis "grupos de timbre" (Programas) — um
 *  .nki pode conter mais de um instrumento/variação dentro do mesmo arquivo
 *  (ex.: "Piano Soft" e "Piano Hard" como programas separados de um mesmo
 *  banco). Isso é detectado de forma tolerante: qualquer elemento cujo nome
 *  da tag contenha "program" (maiúsc./minúsc. não importa) e que tenha pelo
 *  menos uma amostra dentro vira um grupo selecionável. Se só um programa
 *  for encontrado (o caso mais comum, de longe), devolve lista vazia — quem
 *  chama cai de volta pro modo "um timbre só", sem mudar nada do
 *  comportamento de patches simples de uma única camada/instrumento. */
function extractProgramGroups(doc: Document): { name: string; zones: NkiZone[] }[] {
  const programEls: Element[] = [];
  const isProgramTag = (el: Element) => /program/i.test(el.tagName);
  const walk = (el: Element) => {
    if (isProgramTag(el)) {
      programEls.push(el);
      return; // não entra em programas aninhados dentro de programas
    }
    for (const child of Array.from(el.children)) walk(child);
  };
  walk(doc.documentElement);

  if (programEls.length < 2) return [];

  const groups = programEls.map((programEl, i) => {
    const zones = extractZones(programEl, { boundary: isProgramTag });
    const bag = collectPropertyBag(programEl);
    const name = readField(bag, ['name']) ?? `Grupo ${i + 1}`;
    return { name, zones };
  });
  // só vale a pena expor como grupos separados se pelo menos 2 deles
  // realmente trouxeram amostra — senão é mais seguro cair no modo simples.
  return groups.filter((g) => g.zones.length > 0).length >= 2 ? groups : [];
}

/** Tenta achar o nome do instrumento (propriedade "Name" perto da raiz do XML) pra exibir como preset. */
function guessInstrumentName(doc: Document): string | null {
  const root = doc.documentElement;
  const bag = collectPropertyBag(root);
  const direct = readField(bag, ['name']);
  if (direct) return direct;
  for (const child of Array.from(root.children)) {
    const childBag = collectPropertyBag(child);
    const name = readField(childBag, ['name']);
    if (name) return name;
  }
  return null;
}

/**
 * Núcleo puro-JS do fallback de descompressão zlib (RFC 1950) usado por
 * `inflateZlib` abaixo quando `DecompressionStream` não existe. Usa
 * `fflate` — já dependência do projeto (MIT, 100% JavaScript, sem WASM nem
 * APIs de navegador; já usada em mrqiFormat.ts pro contêiner .mrqi) — então
 * roda em qualquer motor JS minimamente moderno, inclusive o WebKit do
 * macOS 10.15/Catalina (Safari ~13), que é o piso mínimo anunciado pelo
 * app (ver `minimumSystemVersion` em src-tauri/tauri.conf.json).
 *
 * Exportada separada de `inflateZlib` de propósito: `DecompressionStream`
 * já existe nativamente no Node usado por `scripts/test-nki-import.mjs` e
 * em qualquer Chromium recente, então o fallback nunca seria de fato
 * exercitado num teste automatizado comum — chamando esta função
 * diretamente, o teste valida o caminho que só importa de verdade em
 * WebKit antigo, sem depender de ter uma instalação de macOS 10.15 à mão.
 */
export function inflateZlibPureJs(body: ArrayBuffer): Uint8Array {
  return unzlibSync(new Uint8Array(body));
}

/**
 * Descompacta um corpo zlib (RFC 1950) com o melhor mecanismo disponível.
 *
 * Preferência: API nativa `DecompressionStream('deflate')` (Chrome/Edge
 * 80+, Safari 16.4+ — ou seja, macOS 13/Ventura em diante —, Node 18+).
 * Problema real encontrado na revisão técnica: o app anuncia suporte a
 * partir do macOS 10.15/Catalina (`minimumSystemVersion` no
 * tauri.conf.json), mas a Apple parou de atualizar o Safari do Catalina na
 * versão 15.6.1 — `DecompressionStream` só chegou no Safari 16.4. Ou seja,
 * em qualquer Mac de 10.15 até 12.x (Monterey) que não tenha feito upgrade
 * de SO, o WKWebView do app NÃO tem essa API, e a importação de .nki
 * falhava sempre com a mensagem de "formato não suportado" mesmo para um
 * .nki legítimo do Kontakt 1-4.
 *
 * Correção: quando `DecompressionStream` não existe (ou lança por qualquer
 * motivo — ex.: implementação nativa parcial/zoada), cai no fallback
 * puro-JS acima, que cobre o piso mínimo anunciado de verdade. A API
 * nativa continua sendo preferida quando disponível (mais rápida, roda
 * fora da thread principal), então isso não piora nada nas plataformas que
 * já funcionavam.
 */
async function inflateZlib(body: ArrayBuffer): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'undefined') {
    try {
      const ds = new DecompressionStream('deflate');
      const stream = new Blob([body]).stream().pipeThrough(ds);
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      /* cai no fallback abaixo — não desiste só porque a via nativa falhou */
    }
  }
  return inflateZlibPureJs(body);
}

/** Descompacta o corpo zlib de um .nki do Kontakt 1-4 (pula o cabeçalho fixo
 *  de 170 bytes) e devolve o texto XML resultante. Lança um erro claro e
 *  específico quando o fluxo não é um zlib válido — o caso mais comum disso
 *  é um .nki do Kontakt 4.2.2 em diante (formato binário criptografado pela
 *  NI, que nunca teve a proteção quebrada por nenhuma ferramenta pública) ou
 *  um arquivo .nkx/.nkc de biblioteca comercial, não um .nki avulso. */
async function extractNkiXml(buffer: ArrayBuffer): Promise<string> {
  if (buffer.byteLength <= NKI_HEADER_SIZE + 2) {
    throw new Error('Arquivo .nki inválido ou corrompido (menor do que o cabeçalho esperado).');
  }
  const body = buffer.slice(NKI_HEADER_SIZE);
  let xmlBytes: Uint8Array;
  try {
    xmlBytes = await inflateZlib(body);
  } catch {
    throw new Error(
      'Não foi possível abrir este .nki. Isso normalmente significa que é um arquivo do Kontakt 4.2.2 ou mais ' +
        'recente (a Native Instruments criptografou o formato a partir dessa versão — nenhuma ferramenta pública ' +
        'conseguiu ler isso de forma legítima até hoje) ou que é um arquivo de biblioteca comercial (.nkx/.nkc), ' +
        'não um .nki avulso. Só patches do Kontakt 1 a 4 (anteriores a 4.2.2), sem criptografia, são suportados.'
    );
  }
  const text = new TextDecoder('utf-8').decode(xmlBytes);
  if (!text.trimStart().startsWith('<')) {
    throw new Error('O conteúdo deste .nki não parece ser o XML de instrumento esperado (formato não reconhecido).');
  }
  return text;
}

/**
 * Camada "Kontakt 1-4 / .nki": carrega de verdade (sem simplificação) os
 * timbres/amostras de um patch legado do Kontakt (versões 1 a 4, anteriores
 * à criptografia introduzida no Kontakt 4.2.2 — ver extractNkiXml acima). O
 * contêiner (cabeçalho de 170 bytes + corpo zlib) é lido conforme o
 * nkitool, ferramenta de domínio público do projeto LinuxSampler
 * (Christian Schoenebeck) — a única documentação pública confiável desse
 * formato. Como a Native Instruments nunca publicou o schema XML interno,
 * os nomes de campo (nota raiz, faixa de tecla/velocidade, etc.) são lidos
 * de forma tolerante por várias variações plausíveis (ver FIELD_ALIASES),
 * em vez de um único nome "chutado" — e cada amostra referenciada é
 * decodificada de verdade (decodeAudioData), nunca substituída por um tom
 * sintético. Isso cobre o pedido do usuário de "carregar só os timbres e
 * amostras" — não reimplementamos o motor de efeitos/scripts do Kontakt
 * (KSP), que não cabe no plano de licenciamento desse app.
 *
 * Importante: isso NÃO lê arquivos "monolito" (amostras embutidas dentro do
 * próprio .nki) nem bibliotecas .nkx/.nkc protegidas — só .nki que
 * referenciam arquivos de amostra externos (.wav/.aiff) ao lado dele no
 * disco, layout muito comum em patches avulsos/gratuitos do Kontakt.
 */
export class NkiLayerVoice {
  private ctx: AudioContext;
  private zones: NkiZone[] = [];
  private buffers = new Map<NkiZone, AudioBuffer>();
  private active = new Map<number, { src: AudioBufferSourceNode; gain: GainNode; baseRate: number }[]>();
  private bendSemitones = 0;
  private instrumentName = '';
  /** Quando o .nki tem mais de um "grupo de timbre" (Programa), guarda cada
   *  um separadamente pra permitir trocar via selectPreset() sem recarregar
   *  o arquivo do disco de novo (todas as amostras já ficam resolvidas). */
  private programGroups: { name: string; zones: NkiZone[] }[] = [];
  private unresolved: NkiUnresolvedSample[] = [];
  /** TODAS as zonas de TODOS os grupos, igual vieram do XML — ao contrário
   *  de `programGroups` (que já filtra só as zonas cujo áudio resolveu),
   *  esta lista preserva as zonas que ficaram "not-found" em `load()`, pra
   *  `resolveFromLibraryRoot` poder tentar resolvê-las de novo depois sem
   *  precisar reabrir o .nki do zero. */
  private rawGroups: { name: string; zones: NkiZone[] }[] = [];
  readonly output: GainNode;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.output = ctx.createGain();
  }

  get name(): string {
    return this.instrumentName;
  }

  /** Amostras referenciadas pelo .nki que NÃO viraram áudio tocável, com o
   *  motivo de cada uma — populado por `load()`, usado pelo relatório de
   *  limites do importador (ver nkiImport.ts). Vazio enquanto nada foi
   *  carregado ou quando tudo resolveu. */
  get unresolvedSamples(): NkiUnresolvedSample[] {
    return this.unresolved;
  }

  /**
   * @param libraryRoot Pasta-raiz de uma biblioteca de amostras, escolhida
   *  manualmente pelo usuário (ver `fs.chooseFolder` em preload.ts/
   *  tauriBridge.ts), usada como fonte ADICIONAL de busca quando as
   *  amostras não estão ao lado do .nki nem numa subpasta Samples/samples
   *  direta — mesmo comportamento de recuperação que o Mixer Pro oferece
   *  pra `.nki`/`.npno` com biblioteca "fora do lugar". Varre `libraryRoot`
   *  recursivamente (ver `fs.findSampleFiles`) procurando pelos nomes de
   *  arquivo que faltaram na resolução normal. Opcional — se omitido, o
   *  comportamento é idêntico ao anterior (só resolve perto do .nki).
   */
  async load(buffer: ArrayBuffer, sourcePath?: string, libraryRoot?: string): Promise<RackPresetOption[]> {
    this.dispose();
    const xmlText = await extractNkiXml(buffer);
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'application/xml');
    if (doc.querySelector('parsererror')) {
      throw new Error('O XML interno deste .nki veio corrompido ou incompleto.');
    }
    this.instrumentName = guessInstrumentName(doc) ?? (sourcePath ? sourcePath.split(/[\\/]/).pop() ?? '' : '');

    // Primeiro tenta achar vários "grupos de timbre" (Programas) dentro do
    // mesmo arquivo; se só houver um (o caso mais comum), cai pro modo
    // simples de sempre (todas as zonas do arquivo inteiro num timbre só).
    const detectedGroups = extractProgramGroups(doc);
    const rawGroups =
      detectedGroups.length > 0
        ? detectedGroups
        : [{ name: this.instrumentName || 'Instrumento Kontakt', zones: extractZones(doc.documentElement) }];

    const totalZones = rawGroups.reduce((n, g) => n + g.zones.length, 0);
    if (totalZones === 0) {
      throw new Error(
        'O .nki foi aberto, mas nenhuma amostra foi reconhecida dentro dele (estrutura interna não reconhecida, ou é um arquivo "monolito" com amostras embutidas — ainda não suportado).'
      );
    }

    const baseDir = sourcePath ? sourcePath.replace(/[\\/][^\\/]*$/, '') : '';
    this.unresolved = [];
    for (const group of rawGroups) {
      for (const zone of group.zones) {
        // .ncw (NI Compressed Wave) e um codec proprietario sem decoder no
        // navegador/WebView - nem vale tentar resolver o arquivo em disco,
        // o problema nao e achar o arquivo, e nao dar pra decodificar ele
        // (ver secao 6 do documento de arquitetura e o comentario de
        // NkiUnresolvedSample acima).
        if (/\.ncw$/i.test(zone.samplePath.trim())) {
          this.unresolved.push({ samplePath: zone.samplePath, reason: 'unsupported-codec' });
          continue;
        }
        const audioBuffer = await this.resolveSample(zone.samplePath, baseDir);
        if (audioBuffer) {
          this.buffers.set(zone, audioBuffer);
        } else {
          this.unresolved.push({ samplePath: zone.samplePath, reason: 'not-found' });
        }
      }
    }

    // Guarda a lista crua (todos os grupos/zonas, inclusive as que não
    // resolveram) ANTES de filtrar — é o que permite `resolveFromLibraryRoot`
    // tentar de novo depois, sem precisar reabrir/reanalisar o .nki.
    this.rawGroups = rawGroups;

    if (libraryRoot) {
      await this.resolveFromLibraryRoot(libraryRoot);
    } else {
      this.rebuildProgramGroupsAndZones();
    }

    if (this.buffers.size === 0) {
      throw new Error(
        'Nenhuma das amostras referenciadas por este .nki foi encontrada ao lado do arquivo no disco ' +
          '(mantenha a pasta de amostras original — geralmente "Samples" — na mesma pasta do .nki, ou escolha a ' +
          'pasta raiz da biblioteca quando solicitado), ou o arquivo é um "monolito" com amostras embutidas ' +
          '(ainda não suportado).'
      );
    }
    if (this.unresolved.length > 0) {
      const names = this.unresolved.map((u) => u.samplePath.split(/[\\/]/).pop() ?? u.samplePath);
      console.warn(`[nki] ${names.length} amostra(s) não encontrada(s) e ficarão mudas: ${names.join(', ')}`);
    }

    if (this.programGroups.length > 1) {
      return this.programGroups.map((g, i) => ({ value: String(i), label: g.name }));
    }
    return [{ value: 'default', label: this.instrumentName || 'Instrumento Kontakt' }];
  }

  /**
   * Devolve TODO o instrumento já resolvido (todos os grupos de timbre e
   * suas zonas, cada uma já com o AudioBuffer real decodificado) — usado
   * pela exportação pra `.mrqi` (ver mrqiExport.ts). Diferente de
   * `this.zones` (só o grupo ATUALMENTE selecionado, usado pra tocar), isso
   * reconstrói o instrumento completo, igual a como ele foi carregado do
   * disco, pra não perder nenhum timbre/variação ao converter.
   */
  exportForMrqi(): {
    instrumentName: string;
    groups: {
      name: string;
      zones: {
        buffer: AudioBuffer;
        samplePath: string;
        rootNote: number;
        loNote: number;
        hiNote: number;
        loVel: number;
        hiVel: number;
        tuneCents: number;
        volume: number;
        pan: number;
      }[];
    }[];
  } {
    return {
      instrumentName: this.instrumentName || 'Instrumento Kontakt',
      groups: this.programGroups.map((g) => ({
        name: g.name,
        zones: g.zones
          .map((z) => {
            const buffer = this.buffers.get(z);
            if (!buffer) return null;
            return {
              buffer,
              samplePath: z.samplePath,
              rootNote: z.rootNote,
              loNote: z.loNote,
              hiNote: z.hiNote,
              loVel: z.loVel,
              hiVel: z.hiVel,
              tuneCents: z.tuneCents,
              volume: z.volume,
              pan: z.pan,
            };
          })
          .filter((z): z is NonNullable<typeof z> => z !== null),
      })),
    };
  }

  /** Reconstrói `programGroups`/`zones` a partir de `rawGroups`, mantendo só
   *  as zonas cujo áudio já está em `buffers` — chamado depois de qualquer
   *  mudança em `buffers` (carga inicial ou uma resolução posterior via
   *  `resolveFromLibraryRoot`), pra manter os dois sempre em sincronia sem
   *  duplicar essa lógica de filtro em mais de um lugar. */
  private rebuildProgramGroupsAndZones() {
    const previousGroupIndex = Math.max(
      0,
      this.programGroups.findIndex((g) => g.zones === this.zones)
    );
    this.programGroups = this.rawGroups
      .map((g) => ({ name: g.name, zones: g.zones.filter((z) => this.buffers.has(z)) }))
      .filter((g) => g.zones.length > 0);
    // Preserva o Programa selecionado quando possível (ex.: usuário já tinha
    // trocado de preset antes de resolver as amostras que faltavam).
    this.zones = this.programGroups[previousGroupIndex]?.zones ?? this.programGroups[0]?.zones ?? [];
  }

  /**
   * Tenta resolver de novo, contra uma pasta-raiz de biblioteca escolhida
   * manualmente pelo usuário, só as amostras que ficaram com
   * `reason: 'not-found'` (nunca as `'unsupported-codec'` — pra essas o
   * problema não é achar o arquivo, é não ter decoder pro formato). Usa
   * `window.api.fs.findSampleFiles` (varredura recursiva, ver preload.ts/
   * tauriBridge.ts/fsops.rs) pra localizar os arquivos pelo nome dentro de
   * `libraryRoot`, decodifica cada um achado e atualiza `buffers`/
   * `unresolved`/`programGroups`/`zones` no lugar. Chamável tanto durante
   * `load()` (quando `libraryRoot` já é conhecido de antemão) quanto depois,
   * num `NkiLayerVoice` já carregado (ver `RackEngine.resolveLayerSamplesFromFolder`
   * e `nkiImport.ts`), reproduzindo a mesma recuperação que o Mixer Pro
   * oferece pra `.nki`/`.npno` com biblioteca "fora do lugar" — sem usar
   * nenhum código dele, só o mesmo padrão de UX (pedir a pasta raiz e
   * procurar os arquivos faltantes dentro dela).
   */
  async resolveFromLibraryRoot(libraryRoot: string): Promise<{ resolved: number; stillUnresolved: number }> {
    const pending = this.unresolved.filter((u) => u.reason === 'not-found');
    if (pending.length === 0 || !libraryRoot) {
      this.rebuildProgramGroupsAndZones();
      return { resolved: 0, stillUnresolved: this.unresolved.length };
    }

    const wantedNames = Array.from(
      new Set(pending.map((u) => (u.samplePath.split(/[\\/]/).pop() ?? u.samplePath).toLowerCase()))
    );

    let matches: Record<string, string> = {};
    try {
      matches = await window.api.fs.findSampleFiles(libraryRoot, wantedNames);
    } catch (err) {
      console.warn('[nki] falha ao varrer a pasta da biblioteca escolhida:', err);
      this.rebuildProgramGroupsAndZones();
      return { resolved: 0, stillUnresolved: this.unresolved.length };
    }

    let resolvedCount = 0;
    const stillUnresolved: NkiUnresolvedSample[] = [];
    for (const group of this.rawGroups) {
      for (const zone of group.zones) {
        if (this.buffers.has(zone)) continue;
        if (/\.ncw$/i.test(zone.samplePath.trim())) continue; // reason:'unsupported-codec', não é caso de busca
        const fileName = (zone.samplePath.split(/[\\/]/).pop() ?? zone.samplePath).toLowerCase();
        const foundPath = matches[fileName];
        if (!foundPath) continue;
        const audio = await this.tryLoadFile(foundPath);
        if (audio) {
          this.buffers.set(zone, audio);
          resolvedCount++;
        }
      }
    }

    // Reconstrói a lista de pendências a partir do estado final de `buffers`
    // (preserva os 'unsupported-codec' intocados, remove os 'not-found' que
    // acabaram de resolver).
    for (const group of this.rawGroups) {
      for (const zone of group.zones) {
        if (this.buffers.has(zone)) continue;
        const reason: NkiUnresolvedSample['reason'] = /\.ncw$/i.test(zone.samplePath.trim())
          ? 'unsupported-codec'
          : 'not-found';
        stillUnresolved.push({ samplePath: zone.samplePath, reason });
      }
    }
    this.unresolved = stillUnresolved;

    this.rebuildProgramGroupsAndZones();

    return { resolved: resolvedCount, stillUnresolved: this.unresolved.length };
  }

  /** Troca o grupo de timbre ativo quando o .nki tem mais de um Programa
   *  (ver extractProgramGroups) — chamado pelo RackEngine quando o usuário
   *  escolhe outro item no seletor de instrumento/preset da camada. */
  selectPreset(value: string) {
    if (this.programGroups.length <= 1) return;
    const idx = Number(value);
    const group = Number.isFinite(idx) ? this.programGroups[idx] : undefined;
    if (group) this.zones = group.zones;
  }

  /** Resolve um caminho de amostra referenciado pelo .nki (geralmente um caminho relativo do Windows, "Samples\\X.wav")
   *  em relação à pasta onde o próprio .nki está, decodificando o áudio de verdade via decodeAudioData. */
  private async resolveSample(samplePath: string, baseDir: string): Promise<AudioBuffer | null> {
    if (!baseDir) return null;
    const relative = samplePath.replace(/\\/g, '/').replace(/^\.?\//, '');
    const fileName = relative.split('/').pop() ?? relative;
    const candidates = [
      `${baseDir}/${relative}`,
      `${baseDir}/${fileName}`,
      `${baseDir}/Samples/${fileName}`,
      `${baseDir}/samples/${fileName}`,
    ];
    for (const candidate of candidates) {
      const audio = await this.tryLoadFile(candidate);
      if (audio) return audio;
    }

    // Nenhum candidato com o nome EXATO funcionou. No Windows e no macOS
    // (sistemas de arquivos padrão case-insensitive) isso já teria dado
    // certo acima — chegar aqui normalmente significa que o app está
    // rodando num sistema de arquivos case-sensitive (Linux) e o .nki
    // "lembra" o nome da amostra com maiúsculas/minúsculas diferentes do
    // arquivo real no disco (comum: biblioteca baixada/reempacotada em SO
    // diferente do original). Resolve nível por nível, sem diferenciar
    // caixa, antes de desistir de vez.
    const relativeSegments = relative.split('/').filter(Boolean);
    const fallbackCandidates = [
      relativeSegments.length > 0 ? { dir: baseDir, segments: relativeSegments } : null,
      { dir: baseDir, segments: [fileName] },
      { dir: `${baseDir}/Samples`, segments: [fileName] },
      { dir: `${baseDir}/samples`, segments: [fileName] },
    ].filter((c): c is { dir: string; segments: string[] } => c !== null);

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

  /** Caminha nível por nível a partir de `startDir` procurando, em cada
   *  pasta, uma entrada cujo nome bata com o segmento esperado sem
   *  diferenciar maiúsculas/minúsculas — devolve o caminho real (com a
   *  capitalização de verdade do disco) se achar todos os segmentos, ou
   *  `null` se qualquer nível não resolver (pasta ausente, sem permissão
   *  de leitura, ou nenhum nome batendo). */
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

  private zonesFor(note: number, velocity: number): NkiZone[] {
    const matches = this.zones.filter(
      (z) => note >= z.loNote && note <= z.hiNote && velocity >= z.loVel && velocity <= z.hiVel
    );
    return matches.length > 0 ? matches : this.zones.filter((z) => note >= z.loNote && note <= z.hiNote);
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
      const baseRate = Math.pow(2, (note - zone.rootNote + zone.tuneCents / 100) / 12);
      src.playbackRate.value = baseRate * Math.pow(2, this.bendSemitones / 12);
      const gain = this.ctx.createGain();
      const target = Math.max(0, Math.min(1, (velocity / 127) * (zone.volume || 1)));
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
