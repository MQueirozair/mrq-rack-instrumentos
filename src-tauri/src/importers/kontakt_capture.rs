//! "Kontakt Audio Capture" — fluxo OPCIONAL do MRQ Instrument Converter pra
//! transformar instrumentos Kontakt que não podem ser abertos diretamente
//! (`.nki` criptografado/biblioteca comercial — ver `nkiImport.ts` e o erro
//! que ele já reporta) num instrumento `.mrq` a partir de arquivos WAV
//! RENDERIZADOS pelo próprio Kontakt pelo usuário.
//!
//! Importante (regras explícitas do pedido que criou este módulo):
//!
//! - **Isto não é um segundo conversor.** O mapeamento (nota/grupo/
//!   velocidade) é montado inteiramente no frontend
//!   (`src/audio/rack/kontaktCapture.ts`) a partir da interação do usuário;
//!   este módulo só expõe duas operações finas que REAPROVEITAM peças já
//!   existentes:
//!     1. `probe` — metadados de UM arquivo de áudio (duração/taxa de
//!        amostragem/canais/bits/hash), reaproveitando o decodificador de
//!        `audio_file.rs` (o mesmo usado pelo importador de WAV/AIFF/FLAC/
//!        MP3/OGG avulso) — nenhuma lógica de decodificação nova.
//!     2. `add_sample_to_session` — decodifica (de novo, mesmo padrão
//!        "inspect decodifica pra prévia, convert decodifica de novo pra
//!        gravar" que `sf2.rs`/`npno.rs`/`audio_file.rs` já usam) e grava a
//!        amostra numa sessão `.mrq` JÁ ABERTA por `mrq_builder_begin`
//!        (Fase 2, writer.rs) — o builder genérico que todo importador já
//!        usa por baixo. Begin/add/finish continuam orquestrados pelo
//!        frontend, exatamente como o comentário de `mrq::commands` já
//!        documentava ser possível desde a Fase 2.
//! - **Não descriptografa nem contorna proteção nenhuma.** Só lê arquivos
//!   de áudio avulsos comuns (WAV/AIFF/FLAC/etc., o que `audio_file.rs` já
//!   sabe ler) — o `.nki` original nunca é tocado por este fluxo.
//! - **Não inventa dado nenhum.** Nota raiz/key range/velocity
//!   range/grupos são decisão do usuário (auto-sugeridos por heurística de
//!   nome de arquivo no frontend) — nunca extraídos do Kontakt original,
//!   que este módulo nem abre.

use std::path::Path;

use serde::Serialize;

use crate::mrq::model::{MrqSampleIndexEntry, MrqSampleSourceInput};
use crate::mrq::writer::{self, MrqBuilderState};

use super::audio_file;
use super::errors::ImportError;

/// Metadados de UM arquivo de áudio candidato a virar uma amostra do
/// instrumento capturado — o bastante pra alimentar a grade de mapeamento
/// visual (duração/taxa de amostragem/canais/profundidade de bits) e a
/// detecção de duplicados (hash do PCM decodificado, não do arquivo em
/// disco — dois arquivos com bytes de contêiner diferentes mas o mesmo
/// áudio real, ex.: um WAV e um "mesmo WAV com metadados extras", ainda
/// contam como duplicados de verdade).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureFileProbe {
    pub duration_seconds: f64,
    pub sample_rate_hz: u32,
    pub channels: u16,
    pub bits_per_sample_original: Option<u16>,
    /// SHA-256 do PCM Float32 intercalado decodificado (hex minúsculo) —
    /// usado só pra detecção de duplicados na UI, nunca gravado no `.mrq`
    /// (o índice de amostras do `.mrq` já tem seu próprio SHA-256 do bloco
    /// FLAC, calculado por `writer.rs`; este aqui é um hash DIFERENTE, de
    /// mais alto nível, com um propósito diferente).
    pub content_sha256: String,
}

/// Decodifica um arquivo de áudio avulso (reaproveitando
/// `audio_file::inspect`, que já faz todo o trabalho de probe+decodificação
/// via `symphonia`) e resume os metadados úteis pra grade de mapeamento,
/// sem gravar nada em disco ainda.
pub fn probe(path: &Path) -> Result<CaptureFileProbe, ImportError> {
    let inspection = audio_file::inspect(path)?;
    let decoded = inspection.decoded;

    let channels = decoded.channels.max(1);
    let frames = decoded.interleaved.len() as u64 / channels as u64;
    let duration_seconds = if decoded.sample_rate_hz > 0 { frames as f64 / decoded.sample_rate_hz as f64 } else { 0.0 };

    let mut hasher = <sha2::Sha256 as sha2::Digest>::new();
    for sample in &decoded.interleaved {
        sha2::Digest::update(&mut hasher, sample.to_le_bytes());
    }
    let content_sha256 = crate::mrq::format::to_hex(&sha2::Digest::finalize(hasher));

    Ok(CaptureFileProbe {
        duration_seconds,
        sample_rate_hz: decoded.sample_rate_hz,
        channels: decoded.channels,
        bits_per_sample_original: decoded.bits_per_sample_original,
        content_sha256,
    })
}

/// Decodifica (de novo — ver nota do módulo sobre o padrão já
/// estabelecido de "inspect decodifica pra prévia, convert decodifica de
/// novo pra gravar") e adiciona UMA amostra a uma sessão `.mrq` JÁ aberta
/// via `mrq_builder_begin`. Não chama `begin`/`finish` — isso é
/// responsabilidade de quem orquestra a captura inteira (o frontend, que
/// abre a sessão uma vez, chama isto uma vez por arquivo WAV selecionado, e
/// fecha a sessão no final), exatamente como os comandos genéricos
/// `mrq_builder_*` já foram desenhados pra permitir desde a Fase 2.
pub fn add_sample_to_session(
    state: &MrqBuilderState,
    session_id: &str,
    sample_id: String,
    path: &Path,
) -> Result<MrqSampleIndexEntry, ImportError> {
    let inspection = audio_file::inspect(path)?;
    let decoded = inspection.decoded;
    let target_bits = decoded.bits_per_sample_original.filter(|&b| (2..=32).contains(&b));

    let entry = writer::add_sample(
        state,
        session_id,
        sample_id,
        MrqSampleSourceInput::Float32 { interleaved: decoded.interleaved, target_bits_per_sample: target_bits },
        decoded.sample_rate_hz,
        decoded.channels,
    )?;
    Ok(entry)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mrq::model::{
        MrqGroup, MrqInstrumentModel, MrqPreset, MrqSourceFormat, MrqStereoMode, MrqZone,
    };
    use std::path::PathBuf;

    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
    }

    #[test]
    fn probes_duration_sample_rate_channels_and_hash() {
        let p = probe(&fixture("test-tone.wav")).expect("deveria sondar um .wav válido");
        assert_eq!(p.sample_rate_hz, 44100);
        assert_eq!(p.channels, 2);
        assert_eq!(p.bits_per_sample_original, Some(16));
        assert!(p.duration_seconds > 0.0);
        assert_eq!(p.content_sha256.len(), 64, "sha256 em hex deve ter 64 chars");
    }

    #[test]
    fn probing_the_same_file_twice_yields_the_same_hash() {
        let a = probe(&fixture("test-tone.wav")).unwrap();
        let b = probe(&fixture("test-tone.wav")).unwrap();
        assert_eq!(a.content_sha256, b.content_sha256, "o hash de conteúdo precisa ser determinístico");
    }

    #[test]
    fn probing_different_audio_yields_a_different_hash() {
        let wav = probe(&fixture("test-tone.wav")).unwrap();
        let aiff = probe(&fixture("test-tone.aiff")).unwrap();
        assert_ne!(wav.content_sha256, aiff.content_sha256);
    }

    #[test]
    fn probe_rejects_a_corrupt_wav_without_panicking() {
        let result = probe(&fixture("corrupt-audio.wav"));
        assert!(result.is_err(), "um arquivo corrompido deve falhar de forma estruturada, nunca em panic");
    }

    fn two_zone_instrument() -> MrqInstrumentModel {
        MrqInstrumentModel {
            name: "Captura de teste".to_string(),
            source_format: MrqSourceFormat::KontaktCapture,
            imported_at: "2026-01-01T00:00:00Z".to_string(),
            presets: vec![MrqPreset {
                id: "preset-0".to_string(),
                name: "Captura de teste".to_string(),
                groups: vec![MrqGroup {
                    id: "group-0".to_string(),
                    name: "Camada única".to_string(),
                    zones: vec![
                        MrqZone {
                            sample_id: "wav-0".to_string(),
                            root_note: 60,
                            lo_key: 48,
                            hi_key: 60,
                            lo_vel: 0,
                            hi_vel: 127,
                            round_robin_group: None,
                            round_robin_index: None,
                            tune_cents: 0.0,
                            volume_db: 0.0,
                            pan: 0.0,
                            stereo: Some(MrqStereoMode::Stereo),
                            loop_enabled: None,
                            loop_start: None,
                            loop_end: None,
                            envelope: None,
                            filter: None,
                            exclusive_group: None,
                        },
                        MrqZone {
                            sample_id: "aiff-0".to_string(),
                            root_note: 72,
                            lo_key: 61,
                            hi_key: 84,
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
                        },
                    ],
                    envelope: None,
                    filter: None,
                    modulation: None,
                }],
            }],
            midi: None,
        }
    }

    /// Exercita exatamente o jeito que o frontend vai orquestrar a captura:
    /// `begin` uma vez (com um instrumento que já referencia os dois
    /// `sample_id` abaixo), `add_sample_to_session` uma vez por WAV, `finish`
    /// uma vez — e confere que o `.mrq` resultante lê de volta sem perda,
    /// com as DUAS amostras (de DOIS arquivos de origem diferentes)
    /// corretamente indexadas.
    #[test]
    fn assembles_one_instrument_from_two_different_wav_files_via_the_generic_builder() {
        let state = MrqBuilderState::default();
        let dir = std::env::temp_dir().join(format!("mrq_kontakt_capture_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("captured.mrq");

        let session_id = writer::begin(&state, dest.clone(), two_zone_instrument()).expect("begin deveria funcionar");

        add_sample_to_session(&state, &session_id, "wav-0".to_string(), &fixture("test-tone.wav"))
            .expect("adicionar a primeira amostra (wav) deveria funcionar");
        add_sample_to_session(&state, &session_id, "aiff-0".to_string(), &fixture("test-tone.aiff"))
            .expect("adicionar a segunda amostra (aiff) deveria funcionar");

        let result = writer::finish(&state, &session_id).expect("finish deveria funcionar com as duas amostras presentes");
        assert_eq!(result.sample_count, 2);

        let metadata = crate::mrq::reader::read_file_metadata(&dest).expect("deveria ler o .mrq de volta");
        assert_eq!(metadata.samples.len(), 2);
        let by_id = |id: &str| metadata.samples.iter().find(|s| s.id == id).unwrap();
        assert_eq!(by_id("wav-0").sample_rate_hz, 44100);
        assert_eq!(by_id("wav-0").channels, 2);
        assert_eq!(by_id("aiff-0").channels, 1);

        let integrity = crate::mrq::reader::validate_integrity(&dest).expect("validate_integrity não deveria falhar estruturalmente");
        assert!(integrity.global_ok);
        assert!(integrity.per_sample.iter().all(|s| s.ok));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `finish()` já rejeita zonas "penduradas" (regra do `model.rs`) — aqui
    /// só confirmamos que isso continua valendo quando o builder é
    /// orquestrado por ESTE módulo (begin referencia 2 amostras, mas só 1 é
    /// de fato adicionada antes do finish).
    #[test]
    fn finish_fails_if_a_referenced_sample_was_never_added() {
        let state = MrqBuilderState::default();
        let dir = std::env::temp_dir().join(format!("mrq_kontakt_capture_missing_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("captured.mrq");

        let session_id = writer::begin(&state, dest.clone(), two_zone_instrument()).expect("begin deveria funcionar");
        add_sample_to_session(&state, &session_id, "wav-0".to_string(), &fixture("test-tone.wav")).expect("deveria funcionar");
        // "aiff-0" nunca é adicionada.

        let result = writer::finish(&state, &session_id);
        assert!(result.is_err(), "finish deveria rejeitar a referência pendurada a 'aiff-0'");
        assert!(!dest.exists(), "nada deveria ser gravado no destino quando finish falha");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Reaproveita o fixture já usado por `audio_file.rs` e `sf2.rs` pra
    /// confirmar que um WAV corrompido no meio de uma sessão de captura
    /// falha de forma estruturada (nunca panic) e nunca deixa a sessão num
    /// estado parcialmente gravado no destino final.
    #[test]
    fn add_sample_to_session_rejects_a_corrupt_wav_without_panicking_or_leaving_partial_state() {
        let state = MrqBuilderState::default();
        let dir = std::env::temp_dir().join(format!("mrq_kontakt_capture_corrupt_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("captured.mrq");

        let session_id = writer::begin(&state, dest.clone(), two_zone_instrument()).expect("begin deveria funcionar");
        let result = add_sample_to_session(&state, &session_id, "wav-0".to_string(), &fixture("corrupt-audio.wav"));
        assert!(result.is_err(), "um wav corrompido deveria falhar de forma estruturada");
        assert!(!dest.exists(), "nada deveria ser gravado no destino antes do finish");

        let _ = writer::abort(&state, &session_id);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
