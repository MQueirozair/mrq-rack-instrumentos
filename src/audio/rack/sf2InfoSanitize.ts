/**
 * Sanitização defensiva de SoundFont (.sf2) ANTES de entregar o buffer pro
 * FluidSynth compilado em WebAssembly (ver LIBFLUIDSYNTH_URL em
 * Sf2LayerVoice.ts). Extraído como módulo isolado (sem nenhum import de
 * js-synthesizer/soundfont2/AudioContext) de propósito, exatamente como
 * selectRoundRobinZones/effectiveStereoPan em MrqLayerVoice.ts — pra dar pra
 * testar com Node puro via scripts/test-sf2-info-sanitize.mjs.
 *
 * ## Por que isso existe
 *
 * O FluidSynth 2.4.6 (a versão vendorizada em public/vendor/js-synthesizer/
 * libfluidsynth-2.4.6-with-libsndfile.js — e, até onde foi possível checar,
 * a versão mais nova que o pacote js-synthesizer distribui como WASM
 * pré-compilado, mesmo na release mais recente dele, 1.13.0) tem um bug
 * documentado: ao encontrar QUALQUER sub-chunk dentro da LIST "INFO" de um
 * .sf2 que não reconheça, ele rejeita o arquivo INTEIRO com um erro fatal
 * ("Invalid chunk id in INFO chunk") — https://github.com/FluidSynth/fluidsynth/issues/1580.
 * Isso é uma violação do próprio spec SF2 2.04 (seção 10.2: chunks
 * desconhecidos dentro da INFO-list "should simply be ignored"), só
 * corrigida no FluidSynth 2.4.7 em diante. SoundFonts exportados por
 * editores modernos (ex.: Polyphone, ou extensões como a proposta DMOD)
 * costumam gravar metadados extras exatamente nesse formato — um arquivo
 * 100% válido pelo spec, mas que o FluidSynth 2.4.6 recusa.
 *
 * Na build desktop normal do FluidSynth isso vira só uma mensagem de erro e
 * o programa segue (ou sai, mas de forma limpa). Já dentro do
 * AudioWorklet/WASM usado por este app, a hipótese líder pra explicar os
 * relatos de "a janela do MRQ fecha sem aviso nenhum" ao carregar certos
 * SoundFonts (sem absolutamente nenhum rastro em mrq-debug.log, mesmo o
 * pipeline de log estando comprovadamente funcional) é que esse caminho de
 * erro específico do parser nativo do FluidSynth não está sendo tratado de
 * forma segura nesse ambiente — gerando uma falha nativa (não uma exceção
 * JS capturável) em vez de só rejeitar a Promise de loadSFont().
 *
 * Como não foi possível confirmar isso diretamente no arquivo .sf2 real do
 * usuário (arquivo grande demais pra anexar), e como não existe build WASM
 * mais nova do FluidSynth disponível pra vendorizar no lugar (nem via
 * upgrade do pacote js-synthesizer — checado até a versão 1.13.0, que só
 * inclui WASM do FluidSynth 2.3.0 e 2.4.6), a mitigação adotada aqui é:
 * antes de entregar QUALQUER SoundFont pro FluidSynth-WASM, remover do
 * buffer (numa cópia — o arquivo original em disco nunca é alterado)
 * qualquer sub-chunk da LIST INFO que não esteja na lista de IDs
 * padronizados pelo spec SF2 2.04. Isso é exatamente o que um leitor em
 * conformidade com o spec deveria fazer de qualquer forma, então não tem
 * risco de quebrar SoundFonts bem-formados — só evita que o FluidSynth
 * 2.4.6 trave ao ver algo que não reconhece.
 *
 * Isso não é uma prova definitiva da causa raiz (não foi possível testar
 * contra o .sf2 real do usuário), mas é uma correção segura, sem efeito
 * colateral, e que ataca exatamente um bug real e documentado nesta versão
 * exata do FluidSynth vendorizada neste app.
 */

// IDs de sub-chunk padronizados pela especificação SF2 2.04 (seção 5.3,
// "The INFO-list Chunk") — qualquer outro ID dentro da LIST INFO é, pelo
// spec, pra ser ignorado por um leitor em conformidade.
const KNOWN_SF2_INFO_CHUNK_IDS: ReadonlySet<string> = new Set([
  'ifil', // versão do formato SF2 (obrigatório)
  'isng', // engine de som alvo (obrigatório)
  'INAM', // nome do banco (obrigatório)
  'irom', // ROM de hardware associada
  'iver', // versão da ROM
  'ICRD', // data de criação
  'IENG', // engenheiro(s)
  'IPRD', // produto pretendido
  'ICOP', // copyright
  'ICMT', // comentários
  'ISFT', // ferramenta usada pra criar o arquivo
]);

function readFourCC(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );
}

export interface Sf2SanitizeResult {
  buffer: ArrayBuffer;
  removedChunkIds: string[];
}

/**
 * Lê o buffer de um .sf2/.sf3 (estrutura RIFF 'sfbk') e retorna uma cópia
 * sem os sub-chunks desconhecidos da LIST "INFO" (ver nota acima). Se o
 * buffer não parecer um RIFF/sfbk válido, ou qualquer chunk tiver tamanho
 * inconsistente, ou nada precisar ser removido, retorna o buffer ORIGINAL
 * sem nenhuma cópia/alteração — nunca lança exceção.
 */
export function stripUnknownSf2InfoChunks(buffer: ArrayBuffer): Sf2SanitizeResult {
  const noop: Sf2SanitizeResult = { buffer, removedChunkIds: [] };
  try {
    if (buffer.byteLength < 12) return noop;
    const view = new DataView(buffer);
    if (readFourCC(view, 0) !== 'RIFF' || readFourCC(view, 8) !== 'sfbk') {
      return noop; // não é um .sf2 reconhecível — deixa o FluidSynth lidar com isso.
    }

    const bytes = new Uint8Array(buffer);
    const outChunks: Uint8Array[] = [];
    const removedChunkIds: string[] = [];
    let offset = 12;

    while (offset + 8 <= bytes.length) {
      const id = readFourCC(view, offset);
      const size = view.getUint32(offset + 4, true);
      const paddedSize = size + (size % 2);
      if (offset + 8 + size > bytes.length) {
        // Tamanho inconsistente com o arquivo real — não mexe em mais nada,
        // devolve o buffer original intacto (mais seguro que adivinhar).
        return noop;
      }

      if (id === 'LIST' && size >= 4 && readFourCC(view, offset + 8) === 'INFO') {
        const infoEnd = offset + 8 + size;
        const keptInfoBytes: number[] = [];
        let infoOffset = offset + 12;
        while (infoOffset + 8 <= infoEnd) {
          const subId = readFourCC(view, infoOffset);
          const subSize = view.getUint32(infoOffset + 4, true);
          const subPadded = subSize + (subSize % 2);
          const subTotal = 8 + subPadded;
          if (infoOffset + subTotal > infoEnd) {
            return noop; // sub-chunk mal formado — não arrisca, devolve original.
          }
          if (KNOWN_SF2_INFO_CHUNK_IDS.has(subId)) {
            for (let i = 0; i < subTotal; i++) keptInfoBytes.push(bytes[infoOffset + i]);
          } else {
            removedChunkIds.push(subId);
          }
          infoOffset += subTotal;
        }

        const newInfoSize = 4 + keptInfoBytes.length; // 4 bytes = formtype 'INFO'
        const rebuilt = new Uint8Array(8 + newInfoSize + (newInfoSize % 2));
        const rv = new DataView(rebuilt.buffer);
        rebuilt.set(bytes.subarray(offset, offset + 4), 0); // 'LIST'
        rv.setUint32(4, newInfoSize, true);
        rebuilt.set(bytes.subarray(offset + 8, offset + 12), 8); // 'INFO'
        rebuilt.set(Uint8Array.from(keptInfoBytes), 12);
        outChunks.push(rebuilt);
      } else {
        outChunks.push(bytes.subarray(offset, offset + 8 + paddedSize));
      }
      offset += 8 + paddedSize;
    }

    if (removedChunkIds.length === 0) return noop;

    const totalBodyLength = outChunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(12 + totalBodyLength);
    out.set(bytes.subarray(0, 12), 0); // 'RIFF' + tamanho (reescrito abaixo) + 'sfbk'
    let pos = 12;
    for (const chunk of outChunks) {
      out.set(chunk, pos);
      pos += chunk.length;
    }
    new DataView(out.buffer).setUint32(4, 4 + totalBodyLength, true); // 4 bytes = 'sfbk'
    return { buffer: out.buffer, removedChunkIds };
  } catch {
    return noop;
  }
}
