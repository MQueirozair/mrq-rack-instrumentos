//! Importador de arquivo de áudio avulso (WAV/AIFF/FLAC/MP3/OGG) →
//! `MrqInstrumentModel` (Fase 7 do MRQ Instrument Converter — ver
//! docs/mrq-converter-architecture.md). Depende só de
//! `crate::mrq::model`/`crate::mrq::writer` — nunca de UI — mesmo padrão de
//! `sf2.rs`/`npno.rs`.
//!
//! Usa o crate `symphonia` (MPL-2.0, ver comentário de licença no
//! `Cargo.toml`) uniformemente pros 5 formatos, por orientação explícita do
//! documento de arquitetura ("usa symphonia no backend") — em vez de
//! decidir caso a caso entre `claxon`/`lewton`/um decoder de MP3 à parte
//! (esses dois primeiros continuam em uso, sem relação com este módulo, só
//! no contexto original deles: amostras comprimidas embutidas em SF2/SF3,
//! Fase 3).
//!
//! ## Modelo de instrumento gerado
//!
//! Um arquivo de áudio avulso não tem o conceito de "instrumento
//! multi-amostra" — é só uma gravação. O modelo gerado reflete isso com
//! honestidade: UM preset, UM grupo, UMA zona cobrindo o teclado (0-127) e a
//! velocidade (0-127) inteiros, raiz fixa em C4 (nota MIDI 60, convenção
//! comum de "pitch original" quando a fonte não traz essa informação — o
//! que é sempre o caso pra um arquivo de áudio genérico, que não tem
//! conceito de nota). Isso é reportado como `Approximated` (nunca
//! `Preserved`) no relatório de compatibilidade, já que a raiz é uma
//! convenção nossa, não um dado do arquivo de origem.
//!
//! ## O que fica de fora (documentado com honestidade, nunca inventado)
//!
//! - Nenhum dos 5 formatos tem o conceito de mapeamento de tecla/
//!   velocidade, múltiplas zonas, loop points, envelope ou qualquer outro
//!   dado de instrumento — só os metadados de stream decodificados pelo
//!   `symphonia` (taxa de amostragem, canais, bits por amostra quando o
//!   codec expõe) são usados.
//! - Faixas de metadados textuais (ID3/Vorbis comment/etc.) não são lidas
//!   — fora de escopo deste importador (gera só o `MrqInstrumentModel` +
//!   áudio, não uma cópia de tags).
//!
//! ## Robustez contra panics internos
//!
//! `symphonia` é um projeto maduro (usado em produção por vários players),
//! mas, por precaução e consistência com a lição da Fase 3 (`soundfont`) e
//! Fase 4 (`nord-format`), a decodificação inteira (probe + decode loop) é
//! isolada com `catch_unwind`.

use std::ffi::OsStr;
use std::fs::File;
use std::path::{Path, PathBuf};

use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, FormatReader, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

use crate::mrq::model::{
    MrqCompatibilityReport, MrqFinishResult, MrqGroup, MrqInstrumentModel, MrqPreset,
    MrqSampleSourceInput, MrqSourceFormat, MrqStereoMode, MrqZone,
};
use crate::mrq::writer::{self, MrqBuilderState};

use super::errors::ImportError;

/// Nota MIDI usada como raiz quando o arquivo de origem não traz nenhuma
/// informação de pitch (sempre o caso pra WAV/AIFF/FLAC/MP3/OGG avulsos) —
/// convenção comum (C4/"nota do meio") documentada como `Approximated`.
const DEFAULT_ROOT_NOTE: u8 = 60;

/// Resultado de uma decodificação completa: PCM Float32 intercalado +
/// metadados de stream — o bastante pra alimentar tanto a inspeção
/// (precisa só dos metadados) quanto a conversão (precisa também do PCM).
///
/// Campos `pub(crate)` (não `pub` totalmente) de propósito: dá pra outros
/// módulos do MESMO crate reaproveitarem a decodificação (ex.:
/// `kontakt_capture.rs`, que monta UM instrumento MRQ a partir de VÁRIOS
/// arquivos WAV renderizados pelo Kontakt — reaproveita este decoder em vez
/// de duplicar a lógica do `symphonia`), mas nunca expõe isso fora do crate
/// nem muda o contrato público deste importador (`inspect`/`convert_to_mrq`
/// continuam exatamente como eram).
pub(crate) struct DecodedAudio {
    pub(crate) interleaved: Vec<f32>,
    pub(crate) sample_rate_hz: u32,
    pub(crate) channels: u16,
    pub(crate) bits_per_sample_original: Option<u16>,
}

fn source_format_for_extension(ext: &str) -> Result<MrqSourceFormat, ImportError> {
    match ext.to_ascii_lowercase().as_str() {
        "wav" | "wave" => Ok(MrqSourceFormat::Wav),
        "aif" | "aiff" | "aifc" => Ok(MrqSourceFormat::Aiff),
        "flac" => Ok(MrqSourceFormat::Flac),
        "mp3" => Ok(MrqSourceFormat::Mp3),
        "ogg" | "oga" => Ok(MrqSourceFormat::Ogg),
        other => Err(ImportError::InvalidAudioFile {
            message: format!(
                "extensão de arquivo não reconhecida por este importador: \".{other}\" (esperado: .wav, .aiff/.aif, .flac, .mp3 ou .ogg)."
            ),
        }),
    }
}

/// Faz o probe + decodificação completa do arquivo, isolado com
/// `catch_unwind` — ver nota de robustez no cabeçalho do módulo. Decodifica
/// TODOS os pacotes de áudio do arquivo (não só o primeiro), concatenando
/// num único buffer PCM — é assim que um arquivo de áudio avulso vira UMA
/// amostra completa, não só o primeiro pacote decodificado.
fn decode_entire_file(path: &Path) -> Result<DecodedAudio, ImportError> {
    let ext = path
        .extension()
        .and_then(OsStr::to_str)
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| decode_entire_file_inner(path, &ext)));
    match result {
        Err(_) => Err(ImportError::InvalidAudioFile {
            message: "o decodificador symphonia encontrou dados malformados (falha interna irrecuperável na dependência) — arquivo provavelmente corrompido".to_string(),
        }),
        Ok(inner) => inner,
    }
}

fn decode_entire_file_inner(path: &Path, ext: &str) -> Result<DecodedAudio, ImportError> {
    let file = File::open(path)?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if !ext.is_empty() {
        hint.with_extension(ext);
    }

    let meta_opts: MetadataOptions = Default::default();
    let fmt_opts: FormatOptions = Default::default();

    let mut format: Box<dyn FormatReader> = symphonia::default::get_probe()
        .probe(&hint, mss, fmt_opts, meta_opts)
        .map_err(|e| ImportError::InvalidAudioFile { message: format!("formato de áudio não reconhecido/suportado: {e}") })?;

    let track = format
        .default_track(TrackType::Audio)
        .ok_or_else(|| ImportError::InvalidAudioFile { message: "nenhuma faixa de áudio encontrada no arquivo.".to_string() })?
        .clone();

    let audio_codec_params = track
        .codec_params
        .as_ref()
        .and_then(|p| p.audio())
        .ok_or_else(|| ImportError::InvalidAudioFile { message: "faixa de áudio sem parâmetros de codec reconhecíveis.".to_string() })?;

    let bits_per_sample_original = audio_codec_params.bits_per_sample.and_then(|b| u16::try_from(b).ok());
    let codec_params_sample_rate = audio_codec_params.sample_rate;
    let codec_params_channels = audio_codec_params.channels.as_ref().map(|c| c.count());

    let dec_opts: AudioDecoderOptions = Default::default();
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(audio_codec_params, &dec_opts)
        .map_err(|e| ImportError::InvalidAudioFile { message: format!("codec de áudio não suportado: {e}") })?;

    let track_id = track.id;
    let mut interleaved: Vec<f32> = Vec::new();
    let mut sample_rate_hz: Option<u32> = None;
    let mut channels: Option<u16> = None;

    // Proteção contra loop infinito: um contêiner truncado/corrompido pode
    // fazer `next_packet()`/`decode()` retornar erro "pular este pacote"
    // indefinidamente SEM nunca sinalizar `Ok(None)` (fim de stream) nem
    // avançar de posição real (ex.: um chunk RIFF que declara um tamanho
    // maior que os bytes de fato disponíveis no arquivo truncado) — sem
    // esse limite, um arquivo malformado trava a importação pra sempre em
    // vez de falhar de forma estruturada. Reiniciado a cada pacote útil
    // obtido com sucesso (progresso real feito).
    const MAX_CONSECUTIVE_PACKET_ERRORS: u32 = 64;
    let mut consecutive_packet_errors: u32 = 0;

    loop {
        if consecutive_packet_errors > MAX_CONSECUTIVE_PACKET_ERRORS {
            return Err(ImportError::InvalidAudioFile {
                message: format!(
                    "o arquivo parece truncado/corrompido: {MAX_CONSECUTIVE_PACKET_ERRORS} pacotes consecutivos ilegíveis sem atingir o fim do stream."
                ),
            });
        }

        let packet = match format.next_packet() {
            Ok(Some(packet)) => {
                consecutive_packet_errors = 0;
                packet
            }
            Ok(None) => break,
            Err(SymphoniaError::ResetRequired) => {
                // Streams Ogg encadeados (vários arquivos lógicos concatenados
                // num único stream físico) mudam a faixa no meio do arquivo.
                // Não é o caso comum de um arquivo de áudio avulso, mas pra
                // não abortar a importação no meio, simplesmente paramos de
                // ler mais pacotes — o que já foi decodificado até aqui é
                // preservado (equivalente a tratar o arquivo como só o
                // primeiro stream lógico).
                break;
            }
            Err(SymphoniaError::IoError(_)) | Err(SymphoniaError::DecodeError(_)) => {
                // Pacote ilegível isolado: pula, não aborta o arquivo inteiro
                // de cara — mas conta pro limite acima.
                consecutive_packet_errors += 1;
                continue;
            }
            Err(e) => {
                return Err(ImportError::InvalidAudioFile { message: format!("erro irrecuperável ao ler o arquivo: {e}") });
            }
        };

        if packet.track_id != track_id {
            continue;
        }

        match decoder.decode(&packet) {
            Ok(decoded) => {
                let spec = decoded.spec();
                if sample_rate_hz.is_none() {
                    sample_rate_hz = Some(spec.rate());
                }
                if channels.is_none() {
                    let count = spec.channels().count();
                    if count == 0 || count > u16::MAX as usize {
                        return Err(ImportError::InvalidAudioFile {
                            message: format!("contagem de canais inválida reportada pelo decodificador: {count}"),
                        });
                    }
                    channels = Some(count as u16);
                }

                // Vai pra um buffer temporário primeiro (em vez de direto no
                // acumulador) de propósito: evita qualquer suposição sobre
                // se `copy_to_vec_interleaved` limpa ou só acrescenta ao
                // vetor de destino — sempre correto de qualquer forma.
                let mut chunk: Vec<f32> = Vec::new();
                decoded.copy_to_vec_interleaved(&mut chunk);
                interleaved.extend_from_slice(&chunk);
            }
            Err(SymphoniaError::IoError(_)) | Err(SymphoniaError::DecodeError(_)) => {
                consecutive_packet_errors += 1;
                continue;
            }
            Err(e) => {
                return Err(ImportError::InvalidAudioFile { message: format!("erro irrecuperável ao decodificar: {e}") });
            }
        }
    }

    let sample_rate_hz = sample_rate_hz
        .or(codec_params_sample_rate)
        .ok_or_else(|| ImportError::InvalidAudioFile { message: "não foi possível determinar a taxa de amostragem.".to_string() })?;
    let channels = channels
        .or_else(|| codec_params_channels.map(|c| c as u16))
        .ok_or_else(|| ImportError::InvalidAudioFile { message: "não foi possível determinar a quantidade de canais.".to_string() })?;

    if interleaved.is_empty() {
        return Err(ImportError::InvalidAudioFile { message: "nenhum quadro de áudio pôde ser decodificado do arquivo.".to_string() });
    }

    Ok(DecodedAudio { interleaved, sample_rate_hz, channels, bits_per_sample_original })
}

/// Resultado do parsing/decodificação — mesma ideia de `Sf2Inspection`/
/// `NordInspection`: alimenta tanto a inspeção quanto a conversão completa.
/// Ao contrário dos outros importadores, aqui a inspeção JÁ decodifica todo
/// o áudio (não tem como separar "estrutura" de "áudio" num arquivo que É
/// só áudio) — arquivos de áudio avulso tendem a ser bem menores que uma
/// biblioteca SF2/NPNO inteira, então o custo é aceitável.
pub struct AudioFileInspection {
    pub instrument: MrqInstrumentModel,
    pub compatibility: MrqCompatibilityReport,
    pub(crate) decoded: DecodedAudio,
}

pub fn inspect(path: &Path) -> Result<AudioFileInspection, ImportError> {
    let ext = path
        .extension()
        .and_then(OsStr::to_str)
        .ok_or_else(|| ImportError::InvalidAudioFile { message: "arquivo sem extensão — não é possível determinar o formato.".to_string() })?;
    let source_format = source_format_for_extension(ext)?;

    let decoded = decode_entire_file(path)?;

    let mut report = MrqCompatibilityReport::default();
    report.add_preserved(
        "Áudio",
        "todo o conteúdo de áudio do arquivo decodificado via symphonia e recodificado em FLAC lossless dentro do .mrq gerado (sample rate, contagem de canais e profundidade de bits originais preservados quando o codec de origem expõe essa informação).",
    );
    report.add_approximated(
        "Nota raiz / mapeamento de teclado",
        format!(
            "um arquivo de áudio avulso não contém informação de pitch/nota — a zona única gerada usa a nota MIDI {DEFAULT_ROOT_NOTE} (C4, convenção comum de \"nota central\") como raiz e cobre o teclado e a velocidade inteiros (0-127); isso é uma convenção da importação, não um dado do arquivo de origem."
        ),
    );
    if decoded.bits_per_sample_original.is_none() {
        report.add_unsupported(
            "Profundidade de bits original",
            "o codec de origem não expõe a profundidade de bits original da fonte (comum em codecs com perdas como MP3/Vorbis, que decodificam direto pra amostras de ponto flutuante) — a amostra é gravada no .mrq usando o perfil padrão de conversão Float32→inteiro do writer.".to_string(),
        );
    }

    let file_stem = path.file_stem().and_then(OsStr::to_str).unwrap_or("Áudio importado").to_string();

    let stereo = if decoded.channels >= 2 { MrqStereoMode::Stereo } else { MrqStereoMode::Mono };
    let zone = MrqZone {
        sample_id: "audio-file-0".to_string(),
        root_note: DEFAULT_ROOT_NOTE,
        lo_key: 0,
        hi_key: 127,
        lo_vel: 0,
        hi_vel: 127,
        round_robin_group: None,
        round_robin_index: None,
        tune_cents: 0.0,
        volume_db: 0.0,
        pan: 0.0,
        stereo: Some(stereo),
        loop_enabled: None,
        loop_start: None,
        loop_end: None,
        envelope: None,
        filter: None,
        exclusive_group: None,
    };

    let instrument = MrqInstrumentModel {
        name: file_stem.clone(),
        source_format,
        imported_at: super::sf2::now_iso8601(),
        presets: vec![MrqPreset {
            id: "audio-file".to_string(),
            name: file_stem,
            groups: vec![MrqGroup { id: "sample".to_string(), name: "Amostra".to_string(), zones: vec![zone], envelope: None, filter: None, modulation: None }],
        }],
        midi: None,
    };

    Ok(AudioFileInspection { instrument, compatibility: report, decoded })
}

/// Faz o parsing+decodificação completa (reaproveitando `inspect`) e grava
/// o `.mrq` final via `mrq::writer` (Fase 2). Roda inteiramente no processo
/// Rust.
pub fn convert_to_mrq(
    builder_state: &MrqBuilderState,
    source_path: &Path,
    dest_path: PathBuf,
) -> Result<(MrqFinishResult, MrqCompatibilityReport), ImportError> {
    let inspection = inspect(source_path)?;
    let mut report = inspection.compatibility;
    let decoded = inspection.decoded;

    let session_id = writer::begin(builder_state, dest_path, inspection.instrument)?;

    let target_bits = decoded.bits_per_sample_original.filter(|&b| (2..=32).contains(&b));

    if let Err(e) = writer::add_sample(
        builder_state,
        &session_id,
        "audio-file-0".to_string(),
        MrqSampleSourceInput::Float32 { interleaved: decoded.interleaved, target_bits_per_sample: target_bits },
        decoded.sample_rate_hz,
        decoded.channels,
    ) {
        let _ = writer::abort(builder_state, &session_id);
        return Err(e.into());
    }

    let result = writer::finish(builder_state, &session_id)?;
    report.add_preserved("Sample rate / canais", "taxa de amostragem e contagem de canais preservadas exatamente como decodificadas pelo symphonia.");
    Ok((result, report))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
    }

    fn assert_single_zone_instrument(instrument: &MrqInstrumentModel, expected_format: MrqSourceFormat) {
        assert_eq!(instrument.source_format, expected_format);
        assert_eq!(instrument.presets.len(), 1);
        let zones = &instrument.presets[0].groups[0].zones;
        assert_eq!(zones.len(), 1, "um arquivo de áudio avulso deve gerar exatamente uma zona");
        assert_eq!(zones[0].root_note, DEFAULT_ROOT_NOTE);
        assert_eq!(zones[0].lo_key, 0);
        assert_eq!(zones[0].hi_key, 127);
        assert_eq!(zones[0].lo_vel, 0);
        assert_eq!(zones[0].hi_vel, 127);
    }

    #[test]
    fn inspects_a_wav_file_stereo_16bit() {
        let inspection = inspect(&fixture("test-tone.wav")).expect("deveria ser um .wav válido");
        assert_single_zone_instrument(&inspection.instrument, MrqSourceFormat::Wav);
        assert_eq!(inspection.decoded.sample_rate_hz, 44100);
        assert_eq!(inspection.decoded.channels, 2);
        assert_eq!(inspection.decoded.bits_per_sample_original, Some(16));
        assert!(!inspection.decoded.interleaved.is_empty());
        assert_eq!(inspection.instrument.presets[0].groups[0].zones[0].stereo, Some(MrqStereoMode::Stereo));
    }

    #[test]
    fn inspects_an_aiff_file_mono_24bit() {
        let inspection = inspect(&fixture("test-tone.aiff")).expect("deveria ser um .aiff válido");
        assert_single_zone_instrument(&inspection.instrument, MrqSourceFormat::Aiff);
        assert_eq!(inspection.decoded.sample_rate_hz, 44100);
        assert_eq!(inspection.decoded.channels, 1);
        assert_eq!(inspection.decoded.bits_per_sample_original, Some(24));
        assert!(!inspection.decoded.interleaved.is_empty());
        assert_eq!(inspection.instrument.presets[0].groups[0].zones[0].stereo, Some(MrqStereoMode::Mono));
    }

    #[test]
    fn inspects_a_flac_file() {
        let inspection = inspect(&fixture("test-tone.flac")).expect("deveria ser um .flac válido");
        assert_single_zone_instrument(&inspection.instrument, MrqSourceFormat::Flac);
        assert_eq!(inspection.decoded.sample_rate_hz, 44100);
        assert_eq!(inspection.decoded.channels, 2);
        assert!(!inspection.decoded.interleaved.is_empty());
    }

    #[test]
    fn inspects_an_mp3_file() {
        let inspection = inspect(&fixture("test-tone.mp3")).expect("deveria ser um .mp3 válido");
        assert_single_zone_instrument(&inspection.instrument, MrqSourceFormat::Mp3);
        assert_eq!(inspection.decoded.sample_rate_hz, 44100);
        assert_eq!(inspection.decoded.channels, 2);
        assert!(!inspection.decoded.interleaved.is_empty());
        // MP3 é um codec com perdas decodificado direto em float — não
        // expõe profundidade de bits original.
        assert_eq!(inspection.decoded.bits_per_sample_original, None);
        assert!(
            inspection.compatibility.unsupported.iter().any(|i| i.field == "Profundidade de bits original"),
            "deveria reportar a ausência de bit depth original pro MP3"
        );
    }

    #[test]
    fn inspects_an_ogg_vorbis_file() {
        let inspection = inspect(&fixture("test-tone.ogg")).expect("deveria ser um .ogg válido");
        assert_single_zone_instrument(&inspection.instrument, MrqSourceFormat::Ogg);
        assert_eq!(inspection.decoded.sample_rate_hz, 44100);
        assert_eq!(inspection.decoded.channels, 2);
        assert!(!inspection.decoded.interleaved.is_empty());
    }

    #[test]
    fn converts_a_wav_file_to_mrq_and_reads_it_back_losslessly() {
        let state = MrqBuilderState::default();
        let dir = std::env::temp_dir().join(format!("mrq_audiofile_import_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("tone.mrq");

        let (result, report) = convert_to_mrq(&state, &fixture("test-tone.wav"), dest.clone()).expect("conversão deveria funcionar");
        assert_eq!(result.sample_count, 1);
        assert!(!report.preserved.is_empty());

        let metadata = crate::mrq::reader::read_file_metadata(&dest).expect("deveria ler o .mrq de volta");
        assert_eq!(metadata.samples.len(), 1);
        assert_eq!(metadata.samples[0].sample_rate_hz, 44100);
        assert_eq!(metadata.samples[0].channels, 2);

        let integrity = crate::mrq::reader::validate_integrity(&dest).expect("validate_integrity não deveria falhar estruturalmente");
        assert!(integrity.global_ok);
        assert!(integrity.per_sample.iter().all(|s| s.ok));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn converts_an_mp3_file_to_mrq_and_reads_it_back_losslessly() {
        let state = MrqBuilderState::default();
        let dir = std::env::temp_dir().join(format!("mrq_audiofile_mp3_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("tone.mrq");

        let (result, _report) = convert_to_mrq(&state, &fixture("test-tone.mp3"), dest.clone()).expect("conversão deveria funcionar");
        assert_eq!(result.sample_count, 1);

        let integrity = crate::mrq::reader::validate_integrity(&dest).expect("validate_integrity não deveria falhar estruturalmente");
        assert!(integrity.global_ok);
        assert!(integrity.per_sample.iter().all(|s| s.ok));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_an_unrecognized_extension() {
        let dir = std::env::temp_dir().join(format!("mrq_audiofile_badext_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("not-audio.xyz");
        std::fs::write(&path, b"nao importa o conteudo, a extensao ja rejeita").unwrap();

        let result = inspect(&path);
        assert!(matches!(result, Err(ImportError::InvalidAudioFile { .. })));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_a_corrupt_wav_fixture_without_panicking() {
        let result = inspect(&fixture("corrupt-audio.wav"));
        assert!(result.is_err(), "um .wav corrompido deveria falhar de forma estruturada, nunca entrar em panic sem controle");
    }
}
