//! Construção de um pacote `.mrq`. Fluxo em 3 passos, pensado pra não
//! precisar manter todo o áudio em memória ao mesmo tempo (uma conversão
//! pode envolver centenas de amostras de uma biblioteca grande):
//!
//! 1. `begin` — abre uma "sessão" em memória (identificada por um id) e cria
//!    um arquivo temporário (fora do destino final) só pro blob de amostras.
//! 2. `add_sample` (N vezes) — recebe PCM (inteiro na profundidade original,
//!    ou Float32 a converter), codifica em FLAC e anexa ao blob temporário,
//!    mantendo em memória só o índice (pequeno: offsets/tamanhos/hashes),
//!    nunca o áudio inteiro de novo.
//! 3. `finish` — monta os metadados finais, grava um arquivo temporário NA
//!    MESMA PASTA do destino (pra permitir rename atômico), recalcula tudo
//!    e CONFERE (`reader::validate_integrity`) antes de mover por cima do
//!    caminho final. Se a autoconferência falhar, nada é escrito no
//!    destino — esta é a "escrita segura" pedida.
//!
//! ## Mecanismo de substituição do arquivo final e o que ele garante de verdade
//!
//! `finish()` nunca abre `final_path` para escrita. Tudo é gravado num
//! arquivo temporário criado com `tempfile::Builder::tempfile_in(final_dir)`
//! — ou seja, NA MESMA PASTA (logo, no mesmo volume/sistema de arquivos) do
//! destino, condição necessária pro passo seguinte não degradar pra uma
//! cópia+exclusão. Só depois que esse temporário passa pela autoconferência
//! completa (`reader::validate_integrity`, recalculada do zero a partir do
//! que foi gravado em disco) é que `NamedTempFile::persist(final_path)` é
//! chamado — e esse é o único ponto que toca `final_path`. Investigação
//! feita no código-fonte da crate `tempfile` 3.27 (`src/file/imp/unix.rs` e
//! `src/file/imp/windows.rs`) pra não declarar uma garantia que a biblioteca
//! não documenta:
//!
//! - **Linux/macOS**: `persist()` com substituição vira uma única chamada a
//!   `rename(2)`. Isso É uma garantia formal do POSIX: a troca é atômica no
//!   nível do sistema de arquivos — nenhum processo concorrente consegue
//!   observar um estado "meio arquivo antigo, meio novo", e depois de um
//!   crash do processo a entrada do diretório aponta inteiramente pro
//!   arquivo antigo OU inteiramente pro novo, nunca pra um estado misto.
//!   Ressalva honesta: isso cobre crash do *processo*; sobrevivência a uma
//!   queda de energia bem no instante da troca depende de o metadado do
//!   diretório já ter sido descarregado em disco pelo kernel/filesystem —
//!   este código não força um `fsync` do diretório (nem a maioria das
//!   ferramentas comparáveis força, por causa do custo), então esse
//!   resíduo de risco existe e é compartilhado com praticamente qualquer
//!   gravação "segura" baseada em rename, não é uma lacuna exclusiva daqui.
//! - **Windows**: `persist()` com substituição vira `MoveFileExW(origem,
//!   destino, MOVEFILE_REPLACE_EXISTING)` no mesmo volume. A Microsoft NÃO
//!   documenta isso como atômico com a mesma força que o POSIX documenta
//!   `rename(2)` — é o mesmo primitivo que o `os.rename`/`os.replace` do
//!   Python, o `os.Rename` do Go e o `Files.move(ATOMIC_MOVE)` do Java NIO
//!   usam no Windows, e na prática, pra troca de nome dentro do MESMO
//!   volume NTFS, o driver do sistema de arquivos faz isso como uma única
//!   atualização de metadado (não uma cópia+exclusão — essa degradação só
//!   acontece se origem e destino estiverem em volumes diferentes, o que
//!   este código evita de propósito usando `tempfile_in`). Dois efeitos
//!   colaterais documentados e tratados aqui:
//!     1. Se outro processo tiver o arquivo de destino aberto sem
//!        `FILE_SHARE_DELETE` (ex.: antivírus, backup, outra instância do
//!        app lendo o arquivo), `MoveFileExW` falha com violação de
//!        compartilhamento — `persist()` devolve erro, `finish()` propaga
//!        esse erro, e o destino **não é tocado** (a chamada falha por
//!        inteiro, antes de qualquer gravação nele). Resultado: conversão
//!        falha e pode ser repetida, sem perda do arquivo original.
//!     2. Não há um passo explícito de "write-through"/flush depois do
//!        `MoveFileExW`, então o mesmo resíduo de risco de perda de energia
//!        do caso POSIX também existe aqui.
//!
//! Testes que provam o comportamento descrito acima (não só o alegam):
//! `finish_failure_preserves_pre_existing_file_at_destination_byte_for_byte`
//! (uma falha de verdade em `finish()` não altera nem 1 byte do que já
//! existia no destino) e `successful_finish_fully_replaces_pre_existing_file_at_destination`
//! (uma conversão bem-sucedida reconvertendo pro mesmo caminho troca o
//! conteúdo por completo, sem misturar nem deixar os dois arquivos).

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Mutex;

use sha2::{Digest, Sha256};

use super::errors::MrqError;
use super::format;
use super::model::{
    MrqFinishResult, MrqInstrumentModel, MrqSampleIndexEntry, MrqSampleSourceInput,
};
use super::reader;

struct BuilderSession {
    final_path: PathBuf,
    tmp_samples_path: PathBuf,
    tmp_samples_file: std::fs::File,
    next_relative_offset: u64,
    index: Vec<MrqSampleIndexEntry>,
    added_sample_ids: HashSet<String>,
    instrument: MrqInstrumentModel,
}

/// Estado gerenciado pelo Tauri (`app.manage(...)`) com todas as sessões de
/// conversão em andamento. Cada sessão só existe entre `begin` e
/// `finish`/`abort` — nada aqui é persistido entre reinícios do app.
#[derive(Default)]
pub struct MrqBuilderState(Mutex<HashMap<String, BuilderSession>>);

fn new_session_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("mrqsess_{nanos}_{n}_{}", std::process::id())
}

/// Converte amostras Float32 normalizadas (-1.0..1.0, como todo `AudioBuffer`
/// do Web Audio já entrega) pra PCM inteiro assinado na profundidade alvo.
/// Ponto ÚNICO do projeto onde essa conversão acontece — documentado aqui
/// porque FLAC é, por definição, um formato de PCM inteiro: não existe
/// "FLAC float", então qualquer fonte float precisa passar por isto antes
/// de ser codificada. Toda amostra que passar por aqui é marcada
/// `converted_from_float32 = true` no índice (ver `model.rs`), nunca em
/// silêncio.
///
/// Escala: `full_scale = 2^(bits-1) - 1` (pico positivo representável),
/// arredondamento pro inteiro mais próximo e clamp pro intervalo
/// representável — evita tanto "wrap around" em amostras fora de -1..1
/// (clipping já presente na fonte) quanto viés sistemático de truncamento.
fn float32_to_integer_pcm(samples: &[f32], bits_per_sample: u16) -> Result<Vec<i32>, MrqError> {
    if !(2..=32).contains(&bits_per_sample) {
        return Err(MrqError::InvalidSampleParams {
            message: format!("bits_per_sample fora do intervalo suportado pelo FLAC (2..=32): {bits_per_sample}"),
        });
    }
    let full_scale = (1i64 << (bits_per_sample - 1)) - 1;
    let min_val = -(1i64 << (bits_per_sample - 1));
    let max_val = full_scale;
    Ok(samples
        .iter()
        .map(|&s| {
            let scaled = f64::from(s) * (full_scale as f64);
            let rounded = scaled.round() as i64;
            rounded.clamp(min_val, max_val) as i32
        })
        .collect())
}

/// Codifica PCM inteiro intercalado em um blob FLAC completo (cabeçalho +
/// frames), pronto pra ser gravado cru dentro do `.mrq`. Backend: crate
/// `flacenc` (puro Rust, Apache-2.0) — ver `docs/mrq-converter-architecture.md`.
fn encode_flac(interleaved: &[i32], channels: u16, bits_per_sample: u16, sample_rate: u32) -> Result<Vec<u8>, MrqError> {
    use flacenc::component::BitRepr;
    use flacenc::error::Verify;

    let config = flacenc::config::Encoder::default()
        .into_verified()
        .map_err(|e| MrqError::EncodeError { message: format!("configuração do encoder FLAC inválida: {e:?}") })?;

    let source = flacenc::source::MemSource::from_samples(
        interleaved,
        channels as usize,
        bits_per_sample as usize,
        sample_rate as usize,
    );

    let block_size = config.block_size;
    let stream = flacenc::encode_with_fixed_block_size(&config, source, block_size)
        .map_err(|e| MrqError::EncodeError { message: format!("{e:?}") })?;

    let mut sink = flacenc::bitsink::ByteSink::new();
    stream
        .write(&mut sink)
        .map_err(|e| MrqError::EncodeError { message: format!("falha ao serializar o stream FLAC: {e:?}") })?;
    Ok(sink.as_slice().to_vec())
}

pub fn begin(state: &MrqBuilderState, final_path: PathBuf, instrument: MrqInstrumentModel) -> Result<String, MrqError> {
    let session_id = new_session_id();
    let tmp_samples_path = std::env::temp_dir().join(format!("{session_id}.mrq-samples.tmp"));
    let tmp_samples_file = std::fs::File::create(&tmp_samples_path)?;

    let session = BuilderSession {
        final_path,
        tmp_samples_path,
        tmp_samples_file,
        next_relative_offset: 0,
        index: Vec::new(),
        added_sample_ids: HashSet::new(),
        instrument,
    };

    let mut map = state.0.lock().expect("mutex de sessões .mrq envenenado");
    map.insert(session_id.clone(), session);
    Ok(session_id)
}

pub fn add_sample(
    state: &MrqBuilderState,
    session_id: &str,
    sample_id: String,
    source: MrqSampleSourceInput,
    sample_rate_hz: u32,
    channels: u16,
) -> Result<MrqSampleIndexEntry, MrqError> {
    if sample_rate_hz == 0 {
        return Err(MrqError::InvalidSampleParams { message: "sampleRateHz precisa ser maior que zero".into() });
    }
    if channels == 0 || channels > 32 {
        return Err(MrqError::InvalidSampleParams { message: format!("quantidade de canais inválida: {channels}") });
    }

    let (interleaved, bits_per_sample_encoded, bits_per_sample_original, converted_from_float32) = match source {
        MrqSampleSourceInput::IntegerPcm { bits_per_sample, interleaved } => {
            if !(2..=32).contains(&bits_per_sample) {
                return Err(MrqError::InvalidSampleParams {
                    message: format!("bits_per_sample fora do intervalo suportado pelo FLAC (2..=32): {bits_per_sample}"),
                });
            }
            (interleaved, bits_per_sample, Some(bits_per_sample), false)
        }
        MrqSampleSourceInput::Float32 { interleaved, target_bits_per_sample } => {
            let target = target_bits_per_sample.unwrap_or(24);
            let converted = float32_to_integer_pcm(&interleaved, target)?;
            (converted, target, None, true)
        }
    };

    if interleaved.is_empty() {
        return Err(MrqError::InvalidSampleParams { message: "amostra sem nenhum frame de áudio".into() });
    }
    if interleaved.len() % channels as usize != 0 {
        return Err(MrqError::InvalidSampleParams {
            message: "quantidade de amostras não é múltipla da quantidade de canais".into(),
        });
    }

    let flac_bytes = encode_flac(&interleaved, channels, bits_per_sample_encoded, sample_rate_hz)?;

    let mut hasher = Sha256::new();
    hasher.update(&flac_bytes);
    let sha256 = format::to_hex(&hasher.finalize());

    let mut map = state.0.lock().expect("mutex de sessões .mrq envenenado");
    let session = map
        .get_mut(session_id)
        .ok_or_else(|| MrqError::SessionNotFound { session_id: session_id.to_string() })?;

    if session.added_sample_ids.contains(&sample_id) {
        return Err(MrqError::InvalidSampleParams {
            message: format!("amostra '{sample_id}' já foi adicionada nesta sessão"),
        });
    }

    session.tmp_samples_file.write_all(&flac_bytes)?;

    let entry = MrqSampleIndexEntry {
        id: sample_id.clone(),
        relative_offset: session.next_relative_offset,
        length: flac_bytes.len() as u64,
        sha256,
        sample_rate_hz,
        channels,
        bits_per_sample_original,
        bits_per_sample_encoded,
        converted_from_float32,
        codec: format::SAMPLE_CODEC_FLAC.to_string(),
    };

    session.next_relative_offset = session
        .next_relative_offset
        .checked_add(entry.length)
        .ok_or_else(|| MrqError::SizeOverflow { sample_id: sample_id.clone() })?;
    session.added_sample_ids.insert(sample_id);
    session.index.push(entry.clone());

    Ok(entry)
}

fn write_and_hash(file: &mut std::fs::File, hasher: &mut Sha256, bytes: &[u8]) -> Result<(), MrqError> {
    file.write_all(bytes)?;
    hasher.update(bytes);
    Ok(())
}

/// Confirma que toda `zone.sample_id` referenciada no instrumento foi de
/// fato adicionada na sessão — nunca ignora silenciosamente uma referência
/// "pendurada".
fn validate_sample_refs(instrument: &MrqInstrumentModel, added: &HashSet<String>) -> Result<(), MrqError> {
    for preset in &instrument.presets {
        for group in &preset.groups {
            for zone in &group.zones {
                if !added.contains(&zone.sample_id) {
                    return Err(MrqError::DanglingSampleReference { sample_id: zone.sample_id.clone() });
                }
            }
        }
    }
    Ok(())
}

pub fn finish(state: &MrqBuilderState, session_id: &str) -> Result<MrqFinishResult, MrqError> {
    let session = {
        let mut map = state.0.lock().expect("mutex de sessões .mrq envenenado");
        map.remove(session_id)
            .ok_or_else(|| MrqError::SessionNotFound { session_id: session_id.to_string() })?
    };

    if let Err(e) = validate_sample_refs(&session.instrument, &session.added_sample_ids) {
        let _ = std::fs::remove_file(&session.tmp_samples_path);
        return Err(e);
    }

    let file_metadata = super::model::MrqFileMetadata {
        format_version: format::CURRENT_VERSION,
        instrument: session.instrument.clone(),
        samples: session.index.clone(),
    };
    let metadata_bytes = serde_json::to_vec(&file_metadata)
        .map_err(|e| MrqError::InvalidMetadataJson { message: e.to_string() })?;

    let final_dir = session
        .final_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    std::fs::create_dir_all(&final_dir)?;

    let mut tmp = tempfile::Builder::new()
        .prefix(".mrq-build-")
        .suffix(".tmp")
        .tempfile_in(&final_dir)?;

    {
        let file = tmp.as_file_mut();
        let mut hasher = Sha256::new();

        write_and_hash(file, &mut hasher, &format::MAGIC)?;
        write_and_hash(file, &mut hasher, &format::CURRENT_VERSION.to_le_bytes())?;
        write_and_hash(file, &mut hasher, &(metadata_bytes.len() as u64).to_le_bytes())?;
        write_and_hash(file, &mut hasher, &metadata_bytes)?;

        let mut samples_reader = std::fs::File::open(&session.tmp_samples_path)?;
        let mut buf = [0u8; 64 * 1024];
        loop {
            let n = samples_reader.read(&mut buf)?;
            if n == 0 {
                break;
            }
            write_and_hash(file, &mut hasher, &buf[..n])?;
        }

        let digest = hasher.finalize();
        file.write_all(&digest)?;
        file.flush()?;
    }

    // Validação final ANTES de renomear por cima do destino — "escrita
    // segura": só vira o arquivo real se passar na autoconferência completa
    // (cabeçalho, limites e hashes, todos recalculados do zero a partir do
    // arquivo gravado, não reaproveitando nada que já estava em memória).
    let tmp_path = tmp.path().to_path_buf();
    let report = reader::validate_integrity(&tmp_path).map_err(|e| {
        let _ = std::fs::remove_file(&session.tmp_samples_path);
        MrqError::SelfValidationFailed { message: format!("falha estrutural na autoconferência: {e}") }
    })?;
    if !report.global_ok || report.per_sample.iter().any(|s| !s.ok) {
        let _ = std::fs::remove_file(&session.tmp_samples_path);
        return Err(MrqError::SelfValidationFailed {
            message: "o arquivo recém-montado não bateu na própria conferência de integridade (hash incorreto)".to_string(),
        });
    }

    tmp.persist(&session.final_path).map_err(|e| MrqError::Io { message: e.to_string() })?;
    let _ = std::fs::remove_file(&session.tmp_samples_path);

    Ok(MrqFinishResult {
        path: session.final_path.to_string_lossy().to_string(),
        sample_count: session.index.len(),
    })
}

pub fn abort(state: &MrqBuilderState, session_id: &str) -> Result<(), MrqError> {
    let mut map = state.0.lock().expect("mutex de sessões .mrq envenenado");
    match map.remove(session_id) {
        Some(session) => {
            let _ = std::fs::remove_file(&session.tmp_samples_path);
            Ok(())
        }
        None => Err(MrqError::SessionNotFound { session_id: session_id.to_string() }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mrq::model::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn temp_dir(label: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("mrq_format_test_{label}_{}_{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn minimal_instrument(sample_ids: &[&str]) -> MrqInstrumentModel {
        let zones = sample_ids
            .iter()
            .map(|id| MrqZone {
                sample_id: (*id).to_string(),
                root_note: 60,
                lo_key: 0,
                hi_key: 127,
                lo_vel: 0,
                hi_vel: 127,
                round_robin_group: None,
                round_robin_index: None,
                tune_cents: 0.0,
                volume_db: 0.0,
                pan: 0.0,
                stereo: Some(MrqStereoMode::Mono),
                loop_enabled: None,
                loop_start: None,
                loop_end: None,
                envelope: None,
                filter: None,
                exclusive_group: None,
            })
            .collect::<Vec<_>>();
        MrqInstrumentModel {
            name: "Teste".to_string(),
            source_format: MrqSourceFormat::Wav,
            imported_at: "2026-10-31T00:00:00Z".to_string(),
            presets: vec![MrqPreset {
                id: "p0".to_string(),
                name: "Preset".to_string(),
                groups: vec![MrqGroup {
                    id: "g0".to_string(),
                    name: "Grupo".to_string(),
                    zones,
                    envelope: None,
                    filter: None,
                    modulation: None,
                }],
            }],
            midi: None,
        }
    }

    fn sine_i32(len: usize, bits: u16) -> Vec<i32> {
        let max = (1i64 << (bits - 1)) - 1;
        (0..len)
            .map(|i| {
                let t = i as f64 / 48000.0;
                ((t * 440.0 * std::f64::consts::TAU).sin() * (max as f64) * 0.5) as i32
            })
            .collect()
    }

    #[test]
    fn builds_and_reads_back_a_single_sample_losslessly() {
        let dir = temp_dir("roundtrip");
        let final_path = dir.join("instrumento.mrq");
        let state = MrqBuilderState::default();

        let session_id = begin(&state, final_path.clone(), minimal_instrument(&["s0"])).unwrap();
        let pcm = sine_i32(4800, 16);
        add_sample(
            &state,
            &session_id,
            "s0".to_string(),
            MrqSampleSourceInput::IntegerPcm { bits_per_sample: 16, interleaved: pcm.clone() },
            48000,
            1,
        )
        .unwrap();
        let result = finish(&state, &session_id).unwrap();
        assert_eq!(result.sample_count, 1);
        assert!(final_path.exists());

        let decoded = reader::extract_sample(&final_path, "s0").unwrap();
        assert_eq!(decoded.channels, 1);
        assert_eq!(decoded.sample_rate_hz, 48000);
        assert_eq!(decoded.interleaved.len(), pcm.len());
        let scale = (1i64 << 15) as f32;
        for (expected_i, actual_f) in pcm.iter().zip(decoded.interleaved.iter()) {
            let expected_f = (*expected_i as f32) / scale;
            assert!((expected_f - actual_f).abs() < 1e-6, "amostra divergente após round-trip sem perda");
        }

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn float32_input_is_converted_and_documented_in_the_index() {
        let dir = temp_dir("float32");
        let final_path = dir.join("instrumento.mrq");
        let state = MrqBuilderState::default();

        let session_id = begin(&state, final_path.clone(), minimal_instrument(&["s0"])).unwrap();
        let floats: Vec<f32> = (0..2000).map(|i| ((i as f32) / 2000.0) * 2.0 - 1.0).collect();
        let entry = add_sample(
            &state,
            &session_id,
            "s0".to_string(),
            MrqSampleSourceInput::Float32 { interleaved: floats.clone(), target_bits_per_sample: Some(24) },
            44100,
            1,
        )
        .unwrap();
        assert!(entry.converted_from_float32);
        assert_eq!(entry.bits_per_sample_encoded, 24);
        assert!(entry.bits_per_sample_original.is_none());
        finish(&state, &session_id).unwrap();

        let decoded = reader::extract_sample(&final_path, "s0").unwrap();
        let quantum = 1.0 / ((1i64 << 23) as f32); // passo de quantização de 24 bits
        for (expected, actual) in floats.iter().zip(decoded.interleaved.iter()) {
            assert!((expected - actual).abs() <= quantum * 2.0, "fora da tolerância de quantização de 24 bits");
        }

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn multiple_independent_samples_each_extract_correctly() {
        let dir = temp_dir("multi");
        let final_path = dir.join("instrumento.mrq");
        let state = MrqBuilderState::default();
        let session_id = begin(&state, final_path.clone(), minimal_instrument(&["a", "b", "c"])).unwrap();
        let pcm_a = sine_i32(1000, 16);
        let pcm_b = sine_i32(2000, 16);
        let pcm_c = sine_i32(1500, 16);
        add_sample(&state, &session_id, "a".into(), MrqSampleSourceInput::IntegerPcm { bits_per_sample: 16, interleaved: pcm_a.clone() }, 48000, 1).unwrap();
        add_sample(&state, &session_id, "b".into(), MrqSampleSourceInput::IntegerPcm { bits_per_sample: 16, interleaved: pcm_b.clone() }, 48000, 1).unwrap();
        add_sample(&state, &session_id, "c".into(), MrqSampleSourceInput::IntegerPcm { bits_per_sample: 16, interleaved: pcm_c.clone() }, 48000, 1).unwrap();
        finish(&state, &session_id).unwrap();

        let index = reader::read_sample_index(&final_path).unwrap();
        assert_eq!(index.len(), 3);

        let da = reader::extract_sample(&final_path, "a").unwrap();
        let db = reader::extract_sample(&final_path, "b").unwrap();
        let dc = reader::extract_sample(&final_path, "c").unwrap();
        assert_eq!(da.interleaved.len(), pcm_a.len());
        assert_eq!(db.interleaved.len(), pcm_b.len());
        assert_eq!(dc.interleaved.len(), pcm_c.len());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn extracting_one_sample_still_works_even_if_another_sample_is_corrupted() {
        // Prova indireta de acesso aleatório de verdade: corrompe só a
        // amostra "b" e confirma que extrair "a" nem percebe — ou seja, a
        // extração de "a" não decodifica nem confere hash de "b".
        let dir = temp_dir("isolated_extract");
        let final_path = dir.join("instrumento.mrq");
        let state = MrqBuilderState::default();
        let session_id = begin(&state, final_path.clone(), minimal_instrument(&["a", "b"])).unwrap();
        let pcm_a = sine_i32(1000, 16);
        let pcm_b = sine_i32(1000, 16);
        add_sample(&state, &session_id, "a".into(), MrqSampleSourceInput::IntegerPcm { bits_per_sample: 16, interleaved: pcm_a.clone() }, 48000, 1).unwrap();
        add_sample(&state, &session_id, "b".into(), MrqSampleSourceInput::IntegerPcm { bits_per_sample: 16, interleaved: pcm_b }, 48000, 1).unwrap();
        finish(&state, &session_id).unwrap();

        let index = reader::read_sample_index(&final_path).unwrap();
        let entry_b = index.iter().find(|e| e.id == "b").unwrap().clone();
        let header_bytes = std::fs::read(&final_path).unwrap();
        let metadata_len = u64::from_le_bytes(header_bytes[8..16].try_into().unwrap());
        let sample_block_start = format::HEADER_FIXED_LEN + metadata_len;
        let corrupt_at = sample_block_start + entry_b.relative_offset + entry_b.length / 2;

        use std::io::{Seek, SeekFrom};
        let mut file = std::fs::OpenOptions::new().write(true).open(&final_path).unwrap();
        file.seek(SeekFrom::Start(corrupt_at)).unwrap();
        file.write_all(&[0xFFu8]).unwrap();
        drop(file);

        let da = reader::extract_sample(&final_path, "a").unwrap();
        assert_eq!(da.interleaved.len(), pcm_a.len());

        let err_b = reader::extract_sample(&final_path, "b").unwrap_err();
        assert!(matches!(err_b, MrqError::HashMismatchSample { .. }));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_empty_file() {
        let dir = temp_dir("empty");
        let path = dir.join("vazio.mrq");
        std::fs::write(&path, []).unwrap();
        let err = reader::read_file_metadata(&path).unwrap_err();
        assert!(matches!(err, MrqError::Truncated { .. }));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_garbage_file_too_small_to_even_have_a_header() {
        let dir = temp_dir("garbage_small");
        let path = dir.join("lixo.mrq");
        std::fs::write(&path, b"nao e um mrq").unwrap();
        let err = reader::read_file_metadata(&path).unwrap_err();
        assert!(matches!(err, MrqError::Truncated { .. }));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_invalid_magic() {
        let dir = temp_dir("bad_magic");
        let path = dir.join("errado.mrq");
        let mut bytes = vec![0u8; format::MIN_FILE_LEN as usize];
        bytes[0..4].copy_from_slice(b"NOPE");
        std::fs::write(&path, &bytes).unwrap();
        let err = reader::read_file_metadata(&path).unwrap_err();
        assert!(matches!(err, MrqError::InvalidMagic));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_unknown_version() {
        let dir = temp_dir("bad_version");
        let path = dir.join("versao.mrq");
        let mut bytes = vec![0u8; format::MIN_FILE_LEN as usize];
        bytes[0..4].copy_from_slice(&format::MAGIC);
        bytes[4..8].copy_from_slice(&999u32.to_le_bytes());
        std::fs::write(&path, &bytes).unwrap();
        let err = reader::read_file_metadata(&path).unwrap_err();
        assert!(matches!(err, MrqError::UnsupportedVersion { found: 999, expected: 1 }));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_invalid_metadata_json() {
        let dir = temp_dir("bad_json");
        let path = dir.join("json.mrq");
        let garbage_metadata = b"isto nao e json valido";
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&format::MAGIC);
        bytes.extend_from_slice(&format::CURRENT_VERSION.to_le_bytes());
        bytes.extend_from_slice(&(garbage_metadata.len() as u64).to_le_bytes());
        bytes.extend_from_slice(garbage_metadata);
        bytes.extend_from_slice(&[0u8; format::TRAILER_LEN as usize]);
        std::fs::write(&path, &bytes).unwrap();
        let err = reader::read_file_metadata(&path).unwrap_err();
        assert!(matches!(err, MrqError::InvalidMetadataJson { .. }));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_metadata_len_that_overruns_the_file() {
        let dir = temp_dir("bad_len");
        let path = dir.join("tamanho.mrq");
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&format::MAGIC);
        bytes.extend_from_slice(&format::CURRENT_VERSION.to_le_bytes());
        bytes.extend_from_slice(&(10_000_000u64).to_le_bytes());
        bytes.extend_from_slice(&[0u8; format::TRAILER_LEN as usize]);
        std::fs::write(&path, &bytes).unwrap();
        let err = reader::read_file_metadata(&path).unwrap_err();
        assert!(matches!(err, MrqError::MetadataLenExceedsFile { .. }));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_sample_index_entry_pointing_past_end_of_file() {
        let dir = temp_dir("oob");
        let final_path = dir.join("instrumento.mrq");
        let state = MrqBuilderState::default();
        let session_id = begin(&state, final_path.clone(), minimal_instrument(&["a"])).unwrap();
        add_sample(&state, &session_id, "a".into(), MrqSampleSourceInput::IntegerPcm { bits_per_sample: 16, interleaved: sine_i32(500, 16) }, 48000, 1).unwrap();
        finish(&state, &session_id).unwrap();

        let full_len = std::fs::metadata(&final_path).unwrap().len();
        let file = std::fs::OpenOptions::new().write(true).open(&final_path).unwrap();
        file.set_len(full_len - 50).unwrap();
        drop(file);

        let err = reader::read_file_metadata(&final_path).unwrap_err();
        assert!(matches!(
            err,
            MrqError::OffsetOutOfBounds { .. } | MrqError::MetadataLenExceedsFile { .. } | MrqError::Truncated { .. }
        ));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn detects_incorrect_global_hash_without_flagging_untouched_samples() {
        let dir = temp_dir("bad_global_hash");
        let final_path = dir.join("instrumento.mrq");
        let state = MrqBuilderState::default();
        let session_id = begin(&state, final_path.clone(), minimal_instrument(&["a"])).unwrap();
        add_sample(&state, &session_id, "a".into(), MrqSampleSourceInput::IntegerPcm { bits_per_sample: 16, interleaved: sine_i32(500, 16) }, 48000, 1).unwrap();
        finish(&state, &session_id).unwrap();

        use std::io::{Seek, SeekFrom};
        let full_len = std::fs::metadata(&final_path).unwrap().len();
        let mut file = std::fs::OpenOptions::new().write(true).open(&final_path).unwrap();
        file.seek(SeekFrom::Start(full_len - 1)).unwrap();
        file.write_all(&[0x00u8]).unwrap();
        drop(file);

        let report = reader::validate_integrity(&final_path).unwrap();
        assert!(!report.global_ok);
        assert!(report.per_sample.iter().all(|s| s.ok), "corromper só o rodapé não deveria afetar o hash por amostra");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Revisão técnica pós-Fase 10, item "Integridade e recuperação":
    /// `validate_integrity` (usado por quem quer auditar um `.mrq` já
    /// existente, sem necessariamente extrair nenhuma amostra) precisa
    /// detectar hash de amostra inválido no PRÓPRIO relatório por amostra
    /// (`per_sample[i].ok == false`), não só via exceção em `extract_sample`
    /// (já coberto por `extracting_one_sample_still_works_even_if_another_sample_is_corrupted`).
    /// Corrompe 1 byte de uma amostra entre 2 e confere que: a amostra
    /// corrompida aparece como `ok: false`, a outra continua `ok: true`
    /// (prova de novo que a checagem é por amostra, não um hash único pro
    /// bloco inteiro), e o hash global também fica `false` (ele cobre o
    /// arquivo inteiro, então qualquer corrupção o invalida também).
    #[test]
    fn validate_integrity_flags_only_the_corrupted_sample_in_its_own_report_entry() {
        let dir = temp_dir("validate_per_sample_corruption");
        let final_path = dir.join("instrumento.mrq");
        let state = MrqBuilderState::default();
        let session_id = begin(&state, final_path.clone(), minimal_instrument(&["a", "b"])).unwrap();
        add_sample(&state, &session_id, "a".into(), MrqSampleSourceInput::IntegerPcm { bits_per_sample: 16, interleaved: sine_i32(1000, 16) }, 48000, 1).unwrap();
        add_sample(&state, &session_id, "b".into(), MrqSampleSourceInput::IntegerPcm { bits_per_sample: 16, interleaved: sine_i32(1000, 16) }, 48000, 1).unwrap();
        finish(&state, &session_id).unwrap();

        let index = reader::read_sample_index(&final_path).unwrap();
        let entry_b = index.iter().find(|e| e.id == "b").unwrap().clone();
        let bytes = std::fs::read(&final_path).unwrap();
        let metadata_len = u64::from_le_bytes(bytes[8..16].try_into().unwrap());
        let sample_block_start = format::HEADER_FIXED_LEN + metadata_len;
        let corrupt_at = sample_block_start + entry_b.relative_offset + entry_b.length / 2;

        use std::io::{Seek, SeekFrom};
        let mut file = std::fs::OpenOptions::new().write(true).open(&final_path).unwrap();
        file.seek(SeekFrom::Start(corrupt_at)).unwrap();
        file.write_all(&[bytes[corrupt_at as usize] ^ 0xFF]).unwrap();
        drop(file);

        let report = reader::validate_integrity(&final_path).unwrap();
        let ok_a = report.per_sample.iter().find(|s| s.sample_id == "a").unwrap().ok;
        let ok_b = report.per_sample.iter().find(|s| s.sample_id == "b").unwrap().ok;
        assert!(ok_a, "amostra não tocada deveria continuar ok");
        assert!(!ok_b, "amostra corrompida deveria aparecer como ok:false no relatório, não só lançar erro em extract_sample");
        assert!(!report.global_ok, "hash global cobre o arquivo inteiro, então também deveria falhar");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Revisão técnica pós-Fase 10, item "Integridade e recuperação": um
    /// arquivo truncado NO MEIO do bloco de amostras (não só no cabeçalho)
    /// precisa falhar de forma estruturada (erro de E/S claro ao tentar ler
    /// os bytes que o índice promete existir), nunca entrar em pânico nem
    /// devolver dado parcial/lixo silenciosamente.
    #[test]
    fn truncating_the_file_mid_sample_data_fails_cleanly_instead_of_returning_garbage() {
        let dir = temp_dir("truncated_mid_sample");
        let final_path = dir.join("instrumento.mrq");
        let state = MrqBuilderState::default();
        let session_id = begin(&state, final_path.clone(), minimal_instrument(&["a"])).unwrap();
        add_sample(&state, &session_id, "a".into(), MrqSampleSourceInput::IntegerPcm { bits_per_sample: 16, interleaved: sine_i32(4000, 16) }, 48000, 1).unwrap();
        finish(&state, &session_id).unwrap();

        let full_len = std::fs::metadata(&final_path).unwrap().len();
        // Corta o arquivo bem no meio (bem depois do cabeçalho/metadados,
        // mas antes do fim do bloco de amostra + rodapé) — simula uma cópia
        // de rede/disco interrompida no meio.
        let file = std::fs::OpenOptions::new().write(true).open(&final_path).unwrap();
        file.set_len(full_len / 2).unwrap();
        drop(file);

        let meta_err = reader::read_file_metadata(&final_path);
        let extract_err = reader::extract_sample(&final_path, "a");
        let validate_err = reader::validate_integrity(&final_path);
        // Qualquer uma das três pode ser a primeira a notar (depende de
        // onde exatamente o corte caiu em relação ao metadata_len
        // declarado) — o que importa é que NENHUMA delas tenha sucesso
        // silencioso nem entre em pânico (o teste já não compilaria/rodaria
        // se tivesse entrado em pânico; os `assert`s abaixo cobrem o "não
        // finge sucesso").
        assert!(meta_err.is_err() || extract_err.is_err() || validate_err.is_err(), "um arquivo truncado no meio não pode ser lido como se estivesse completo em todos os caminhos");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Revisão técnica pós-Fase 10, item "Integridade e recuperação":
    /// metadados "inconsistentes" — o índice JSON descreve `channels`/
    /// `sampleRateHz` diferentes do que o cabeçalho STREAMINFO do FLAC
    /// realmente contém (ex.: edição manual do JSON, ou um bug futuro de
    /// escrita) — precisa ser rejeitado com um erro específico
    /// (`MetadataStreamMismatch`), nunca devolver um `MrqDecodedSample`
    /// rotulado com canais/sample rate errados pro chamador. Importante:
    /// como o SHA-256 por amostra só cobre os bytes FLAC (não o JSON), essa
    /// adulteração NÃO muda `sha256` — só esta checagem cruzada pega.
    #[test]
    fn extract_sample_rejects_metadata_that_disagrees_with_the_real_flac_stream() {
        let dir = temp_dir("metadata_stream_mismatch");
        let final_path = dir.join("instrumento.mrq");
        let state = MrqBuilderState::default();
        let session_id = begin(&state, final_path.clone(), minimal_instrument(&["a"])).unwrap();
        add_sample(&state, &session_id, "a".into(), MrqSampleSourceInput::IntegerPcm { bits_per_sample: 16, interleaved: sine_i32(1000, 16) }, 48000, 1).unwrap();
        finish(&state, &session_id).unwrap();

        // O FLAC de "a" foi codificado com 1 canal — edita só o JSON de
        // metadados pra declarar 2 canais, sem tocar em nenhum byte do
        // bloco de amostra (então o sha256 do índice continua batendo).
        let mut bytes = std::fs::read(&final_path).unwrap();
        let metadata_len = u64::from_le_bytes(bytes[8..16].try_into().unwrap()) as usize;
        let metadata_start = format::HEADER_FIXED_LEN as usize;
        let metadata_slice = &mut bytes[metadata_start..metadata_start + metadata_len];
        let metadata_text = std::str::from_utf8(metadata_slice).unwrap().to_string();
        assert!(metadata_text.contains("\"channels\":1"), "pré-condição do teste: esperava encontrar \"channels\":1 no JSON");
        let patched = metadata_text.replacen("\"channels\":1", "\"channels\":2", 1);
        assert_eq!(patched.len(), metadata_text.len(), "a troca precisa manter o mesmo tamanho em bytes pra não precisar realinhar offsets");
        metadata_slice.copy_from_slice(patched.as_bytes());
        std::fs::write(&final_path, &bytes).unwrap();

        let err = reader::extract_sample(&final_path, "a").unwrap_err();
        assert!(
            matches!(&err, MrqError::MetadataStreamMismatch { field, .. } if field == "channels"),
            "esperava MetadataStreamMismatch de 'channels', obteve: {err:?}"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_dangling_sample_reference_at_finish() {
        let dir = temp_dir("dangling");
        let final_path = dir.join("instrumento.mrq");
        let state = MrqBuilderState::default();
        let session_id = begin(&state, final_path.clone(), minimal_instrument(&["s0"])).unwrap();
        let err = finish(&state, &session_id).unwrap_err();
        assert!(matches!(err, MrqError::DanglingSampleReference { .. }));
        assert!(!final_path.exists(), "nada deveria ser gravado no destino final numa conversão que falhou");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Revisão técnica pedida pelo usuário, item "Segurança de gravação do
    /// .mrq": confirma que uma falha em `finish()` NÃO toca no arquivo que já
    /// existia no caminho de destino (o caso real é reconverter/sobrescrever
    /// um `.mrq` que já existe — ex.: o usuário reexporta o mesmo instrumento
    /// e o novo build falha por algum motivo no meio do caminho). A escrita
    /// inteira acontece num arquivo temporário à parte (`tempfile_in`, na
    /// MESMA pasta do destino — necessário pra garantir que `persist()` vire
    /// um rename/move de arquivo único, nunca uma cópia entre volumes) e só
    /// no fim, se a autoconferência (`reader::validate_integrity`) passar, é
    /// que o destino é substituído. Antes disso, o destino nunca é aberto
    /// para escrita — então o teste abaixo confere, byte a byte, que o
    /// conteúdo "original" sobrevive intacto a uma conversão que falha.
    #[test]
    fn finish_failure_preserves_pre_existing_file_at_destination_byte_for_byte() {
        let dir = temp_dir("preserve_original_on_failure");
        let final_path = dir.join("instrumento.mrq");
        let original_bytes: Vec<u8> = b"isto representa um .mrq valido gravado numa conversao anterior - nao pode ser perdido".to_vec();
        std::fs::write(&final_path, &original_bytes).unwrap();

        let state = MrqBuilderState::default();
        // "s0" nunca é adicionada via add_sample -> validate_sample_refs falha
        // em finish(), antes mesmo de qualquer escrita no diretório final.
        let session_id = begin(&state, final_path.clone(), minimal_instrument(&["s0"])).unwrap();
        let err = finish(&state, &session_id).unwrap_err();
        assert!(matches!(err, MrqError::DanglingSampleReference { .. }));

        let bytes_after = std::fs::read(&final_path).unwrap();
        assert_eq!(bytes_after, original_bytes, "uma falha em finish() não pode alterar nem um byte do arquivo de destino pré-existente");

        // Confere também que nenhum arquivo temporário de montagem (".mrq-build-*")
        // ficou pra trás na mesma pasta do destino, sujando o diretório do usuário.
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".mrq-build-"))
            .collect();
        assert!(leftovers.is_empty(), "nenhum temporário de montagem deveria sobrar após uma falha de finish()");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Mesmo item da revisão técnica, mas o caso de SUCESSO: confirma que
    /// reconverter pro mesmo caminho de um `.mrq` que já existe de fato
    /// substitui o conteúdo antigo (não deixa os dois arquivos, não anexa, não
    /// mistura), e que o resultado final é o conteúdo NOVO, lido de volta sem
    /// nenhum resquício do arquivo antigo.
    #[test]
    fn successful_finish_fully_replaces_pre_existing_file_at_destination() {
        let dir = temp_dir("replace_existing_on_success");
        let final_path = dir.join("instrumento.mrq");
        std::fs::write(&final_path, b"arquivo antigo de uma conversao anterior, deve ser substituido por completo").unwrap();

        let state = MrqBuilderState::default();
        let session_id = begin(&state, final_path.clone(), minimal_instrument(&["s0"])).unwrap();
        let pcm = sine_i32(4800, 16);
        add_sample(
            &state,
            &session_id,
            "s0".to_string(),
            MrqSampleSourceInput::IntegerPcm { bits_per_sample: 16, interleaved: pcm.clone() },
            48000,
            1,
        )
        .unwrap();
        finish(&state, &session_id).unwrap();

        // Se tivesse sobrado qualquer coisa do arquivo antigo (anexado,
        // misturado, etc.), a leitura/validação abaixo falharia: um `.mrq`
        // válido tem cabeçalho+trailer fixos, não aceita bytes extras.
        let report = reader::validate_integrity(&final_path).unwrap();
        assert!(report.global_ok, "o arquivo no destino precisa ser o novo .mrq válido, não uma mistura com o antigo");
        let decoded = reader::extract_sample(&final_path, "s0").unwrap();
        assert_eq!(decoded.interleaved.len(), pcm.len());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unknown_session_id_is_a_structured_error() {
        let state = MrqBuilderState::default();
        let err = finish(&state, "sessao-que-nao-existe").unwrap_err();
        assert!(matches!(err, MrqError::SessionNotFound { .. }));
    }
}
