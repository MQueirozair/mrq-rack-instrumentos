//! Leitura e validação de um pacote `.mrq` já existente. Regra central deste
//! módulo: **nenhum offset/tamanho vindo do arquivo é confiado sem antes
//! checar limites e possíveis estouros de inteiro** contra o tamanho real do
//! arquivo em disco — um `.mrq` corrompido ou adulterado nunca deve
//! conseguir fazer o leitor alocar memória absurda, ler fora do arquivo, ou
//! sofrer overflow em aritmética de offset.

use std::io::{Read, Seek, SeekFrom};

use sha2::{Digest, Sha256};

use super::errors::MrqError;
use super::format;
use super::model::{MrqDecodedSample, MrqFileMetadata, MrqIntegrityReport, MrqSampleIndexEntry, MrqSampleIntegrity};

struct ValidatedHeader {
    total_len: u64,
    metadata_len: u64,
}

/// Lê e valida só o cabeçalho fixo (16 bytes): assinatura, versão, e que o
/// `metadata_len` declarado cabe no arquivo (com uma folga mínima pro
/// rodapé de 32 bytes) — tudo ANTES de alocar o buffer de metadados.
fn open_and_validate_header(path: &std::path::Path) -> Result<(std::fs::File, ValidatedHeader), MrqError> {
    let mut file = std::fs::File::open(path)?;
    let total_len = file.metadata()?.len();

    if total_len < format::MIN_FILE_LEN {
        return Err(MrqError::Truncated { needed_at_least: format::MIN_FILE_LEN, available: total_len });
    }

    let mut header = [0u8; format::HEADER_FIXED_LEN as usize];
    file.read_exact(&mut header)?;

    if header[0..4] != format::MAGIC {
        return Err(MrqError::InvalidMagic);
    }

    let version = u32::from_le_bytes(header[4..8].try_into().expect("slice de 4 bytes"));
    if version != format::CURRENT_VERSION {
        return Err(MrqError::UnsupportedVersion { found: version, expected: format::CURRENT_VERSION });
    }

    let metadata_len = u64::from_le_bytes(header[8..16].try_into().expect("slice de 8 bytes"));
    let max_allowed_by_file = total_len.saturating_sub(format::HEADER_FIXED_LEN + format::TRAILER_LEN);
    if metadata_len > format::MAX_REASONABLE_METADATA_LEN || metadata_len > max_allowed_by_file {
        return Err(MrqError::MetadataLenExceedsFile {
            declared: metadata_len,
            max_allowed: max_allowed_by_file.min(format::MAX_REASONABLE_METADATA_LEN),
        });
    }

    Ok((file, ValidatedHeader { total_len, metadata_len }))
}

/// Lê e valida COMPLETAMENTE os metadados — inclusive os offsets/tamanhos de
/// TODAS as amostras do índice, contra limites e estouro de inteiro — antes
/// de qualquer amostra ser de fato lida por qualquer outra função deste
/// módulo. Nenhuma outra função pula essa validação (todas chamam esta
/// primeiro).
pub fn read_file_metadata(path: &std::path::Path) -> Result<MrqFileMetadata, MrqError> {
    let (mut file, header) = open_and_validate_header(path)?;

    let mut metadata_bytes = vec![0u8; header.metadata_len as usize];
    file.read_exact(&mut metadata_bytes)?;

    let file_metadata: MrqFileMetadata = serde_json::from_slice(&metadata_bytes)
        .map_err(|e| MrqError::InvalidMetadataJson { message: e.to_string() })?;

    let sample_block_start = format::HEADER_FIXED_LEN + header.metadata_len;
    let sample_block_end = header.total_len - format::TRAILER_LEN;

    for entry in &file_metadata.samples {
        let abs_offset = sample_block_start
            .checked_add(entry.relative_offset)
            .ok_or_else(|| MrqError::SizeOverflow { sample_id: entry.id.clone() })?;
        let abs_end = abs_offset
            .checked_add(entry.length)
            .ok_or_else(|| MrqError::SizeOverflow { sample_id: entry.id.clone() })?;
        if abs_offset < sample_block_start || abs_end > sample_block_end {
            return Err(MrqError::OffsetOutOfBounds { sample_id: entry.id.clone() });
        }
    }

    Ok(file_metadata)
}

pub fn read_sample_index(path: &std::path::Path) -> Result<Vec<MrqSampleIndexEntry>, MrqError> {
    Ok(read_file_metadata(path)?.samples)
}

/// Extrai e decodifica UMA amostra, identificada por `sample_id`. Depois de
/// ler o índice (que cobre o arquivo inteiro, é pequeno), lê e decodifica
/// só os bytes exatos daquela amostra — nenhuma outra amostra é tocada,
/// nem em disco nem em CPU (ver teste
/// `extracting_one_sample_still_works_even_if_another_sample_is_corrupted`
/// em `writer.rs`, que prova isso indiretamente).
pub fn extract_sample(path: &std::path::Path, sample_id: &str) -> Result<MrqDecodedSample, MrqError> {
    let file_metadata = read_file_metadata(path)?;
    let entry = file_metadata
        .samples
        .iter()
        .find(|s| s.id == sample_id)
        .ok_or_else(|| MrqError::SampleNotFound { sample_id: sample_id.to_string() })?;

    let (mut file, header) = open_and_validate_header(path)?;
    let sample_block_start = format::HEADER_FIXED_LEN + header.metadata_len;
    let abs_offset = sample_block_start
        .checked_add(entry.relative_offset)
        .ok_or_else(|| MrqError::SizeOverflow { sample_id: entry.id.clone() })?;

    file.seek(SeekFrom::Start(abs_offset))?;
    let mut flac_bytes = vec![0u8; entry.length as usize];
    file.read_exact(&mut flac_bytes)?;

    let mut hasher = Sha256::new();
    hasher.update(&flac_bytes);
    let actual_sha256 = format::to_hex(&hasher.finalize());
    if actual_sha256 != entry.sha256 {
        return Err(MrqError::HashMismatchSample { sample_id: entry.id.clone() });
    }

    let mut flac_reader = claxon::FlacReader::new(std::io::Cursor::new(flac_bytes))
        .map_err(|e| MrqError::DecodeError { message: e.to_string() })?;

    // "Metadados inconsistentes" (revisão técnica pós-Fase 10): o SHA-256
    // acima só prova que os BYTES do FLAC não foram adulterados — não prova
    // que o `channels`/`sampleRateHz` do índice JSON bate com o que o
    // próprio cabeçalho STREAMINFO do FLAC de fato contém. Um `.mrq` com
    // metadados corrompidos/editados à mão (ou um bug futuro de escrita)
    // poderia ter um índice que descreve uma amostra estéreo de 44.1kHz
    // apontando pra um FLAC mono de 48kHz de verdade — sem esta checagem,
    // isso seria devolvido como `MrqDecodedSample` rotulado errado pro
    // chamador (JS), que confia nesses campos pra calcular duração/offsets
    // de loop. Falha explícita aqui é melhor que um resultado sutilmente
    // incorreto mais adiante.
    let info = flac_reader.streaminfo();
    if info.channels as u16 != entry.channels {
        return Err(MrqError::MetadataStreamMismatch {
            sample_id: entry.id.clone(),
            field: "channels".to_string(),
            declared: entry.channels.to_string(),
            actual: info.channels.to_string(),
        });
    }
    if info.sample_rate != entry.sample_rate_hz {
        return Err(MrqError::MetadataStreamMismatch {
            sample_id: entry.id.clone(),
            field: "sampleRateHz".to_string(),
            declared: entry.sample_rate_hz.to_string(),
            actual: info.sample_rate.to_string(),
        });
    }

    let bits = flac_reader.streaminfo().bits_per_sample;
    let full_scale = if bits >= 1 { (1i64 << (bits - 1)) as f32 } else { 1.0 };

    let mut interleaved = Vec::new();
    for sample in flac_reader.samples() {
        let s = sample.map_err(|e| MrqError::DecodeError { message: e.to_string() })?;
        interleaved.push((s as f32) / full_scale);
    }

    Ok(MrqDecodedSample {
        sample_id: entry.id.clone(),
        interleaved,
        sample_rate_hz: entry.sample_rate_hz,
        channels: entry.channels,
        bits_per_sample_encoded: entry.bits_per_sample_encoded,
    })
}

/// Confere a integridade do arquivo: SHA-256 de cada amostra contra o
/// índice, e SHA-256 global (tudo exceto o próprio rodapé de 32 bytes)
/// contra o valor gravado no final do arquivo. Só devolve `Err` por
/// problema ESTRUTURAL (cabeçalho/versão/limites/JSON) — um hash que não
/// bate vira dado no relatório (`ok: false`), não uma exceção.
pub fn validate_integrity(path: &std::path::Path) -> Result<MrqIntegrityReport, MrqError> {
    let file_metadata = read_file_metadata(path)?;
    let (mut file, header) = open_and_validate_header(path)?;
    let sample_block_start = format::HEADER_FIXED_LEN + header.metadata_len;

    let mut per_sample = Vec::with_capacity(file_metadata.samples.len());
    for entry in &file_metadata.samples {
        let abs_offset = sample_block_start
            .checked_add(entry.relative_offset)
            .ok_or_else(|| MrqError::SizeOverflow { sample_id: entry.id.clone() })?;
        file.seek(SeekFrom::Start(abs_offset))?;
        let mut bytes = vec![0u8; entry.length as usize];
        file.read_exact(&mut bytes)?;
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let actual = format::to_hex(&hasher.finalize());
        per_sample.push(MrqSampleIntegrity { sample_id: entry.id.clone(), ok: actual == entry.sha256 });
    }

    file.seek(SeekFrom::Start(0))?;
    let mut hasher = Sha256::new();
    let to_hash_len = header.total_len - format::TRAILER_LEN;
    let mut remaining = to_hash_len;
    let mut buf = [0u8; 64 * 1024];
    while remaining > 0 {
        let chunk = remaining.min(buf.len() as u64) as usize;
        file.read_exact(&mut buf[..chunk])?;
        hasher.update(&buf[..chunk]);
        remaining -= chunk as u64;
    }
    let computed_global = format::to_hex(&hasher.finalize());

    let mut trailer = [0u8; format::TRAILER_LEN as usize];
    file.read_exact(&mut trailer)?;
    let stored_global = format::to_hex(&trailer);

    Ok(MrqIntegrityReport { global_ok: computed_global == stored_global, per_sample })
}
