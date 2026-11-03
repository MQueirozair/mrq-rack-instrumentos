//! Constantes de baixo nível do contêiner binário `.mrq` ("MRQ Instrument").
//! Ver `docs/mrq-converter-architecture.md` (seção 4) pro desenho completo.
//!
//! Este módulo só define o layout — nenhuma lógica de leitura/escrita mora
//! aqui (isso fica em `reader.rs`/`writer.rs`). Mantém as constantes num
//! único lugar pra reader e writer nunca divergirem sobre offsets.
//!
//! Layout do arquivo:
//! ```text
//! offset 0                  [4 bytes]  magic = "MRQ1"
//! offset 4                  [4 bytes]  versão do formato (u32 LE)
//! offset 8                  [8 bytes]  tamanho do bloco de metadados (u64 LE)
//! offset 16                 [N bytes]  metadados: JSON UTF-8 (FileMetadata)
//! offset 16+N               [...]      bloco de amostras FLAC concatenadas,
//!                                       nos offsets RELATIVOS a este ponto
//!                                       gravados no índice dentro do JSON
//! EOF - 32                  [32 bytes] SHA-256 de tudo antes deste bloco
//! ```

/// Assinatura de 4 bytes no início de todo `.mrq` válido.
pub const MAGIC: [u8; 4] = *b"MRQ1";

/// Versão atual do formato. Um arquivo com versão diferente é rejeitado
/// explicitamente (`MrqError::UnsupportedVersion`) — nunca lido "na marra"
/// supondo compatibilidade que não foi verificada.
pub const CURRENT_VERSION: u32 = 1;

/// magic(4) + version(4) + metadata_len(8).
pub const HEADER_FIXED_LEN: u64 = 16;

/// SHA-256 (32 bytes crus, não hex) do arquivo inteiro exceto este bloco.
pub const TRAILER_LEN: u64 = 32;

/// Todo `.mrq` válido — mesmo sem nenhuma amostra — tem pelo menos isso.
pub const MIN_FILE_LEN: u64 = HEADER_FIXED_LEN + TRAILER_LEN;

/// Limite de sanidade pro `metadata_len` declarado no cabeçalho. Não é um
/// limite do formato em si — é só uma proteção contra um valor absurdo
/// (arquivo corrompido ou adulterado) fazer o leitor tentar alocar um
/// buffer gigante antes mesmo de validar o resto do arquivo.
pub const MAX_REASONABLE_METADATA_LEN: u64 = 256 * 1024 * 1024; // 256 MiB

/// Codec usado no bloco de amostras. Único valor suportado na v1 — campo
/// próprio no índice (em vez de assumir) pra permitir, numa versão futura,
/// coexistência de codecs sem quebrar leitores antigos (que simplesmente
/// rejeitariam um valor desconhecido).
pub const SAMPLE_CODEC_FLAC: &str = "flac";

/// Hex minúsculo de um digest (ex.: SHA-256) — usado tanto pelo writer
/// (gravar o índice) quanto pelo reader (conferir), compartilhado aqui pra
/// nunca divergir em maiúsculas/minúsculas entre os dois lados.
pub fn to_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}
