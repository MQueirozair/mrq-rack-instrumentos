//! Importador NPNO/NSMP → `MrqInstrumentModel` (Fase 4 do MRQ Instrument
//! Converter — ver docs/mrq-converter-architecture.md). Depende só de
//! `crate::mrq::model`/`crate::mrq::writer` — nunca de UI — mesmo padrão de
//! `sf2.rs`.
//!
//! Usa o crate `nord-format` (BSD-3-Clause, projeto comunitário não afiliado
//! à Clavia) como dependência NATIVA independente da que já existe em
//! `native/npno-wasm` (wasm, usada só pela reprodução ao vivo no Rack via
//! `NpnoLayerVoice.ts`) — mesmo crate, mesma versão, dois alvos de build
//! separados, de propósito: importadores vivem só no backend Rust.
//!
//! Dois formatos, um único módulo/comando (a arquitetura do próprio
//! `nord-format` já os trata como uma família: `nord_format::from_stream`
//! devolve um `Entity` único, e só despachamos aqui conforme a variante):
//!
//! - **`.npno`** (biblioteca de piano): um `Piano` inteiro vira UM
//!   `MrqPreset` com UM `MrqGroup`; cada "stroke" (nota gravada) do banco
//!   `Attack` vira uma `MrqZone`. Faixa de tecla: todas as teclas do
//!   `key_map` (128 entradas) que apontam pra essa raiz gravada. Faixa de
//!   velocidade: calculada pela fórmula documentada e confirmada em
//!   hardware de `Stroke::layer` (`docs.rs` — não é uma aproximação nossa,
//!   é o algoritmo real do teclado: `t(v) = (127-v)·31/127`, toca a maior
//!   camada ≤ `t(v)`), com os dois extremos (camada mais alta/mais baixa de
//!   cada raiz) esticados até 127/0 pra não deixar lacuna muda nos extremos
//!   de velocidade.
//!
//! - **`.nsmp`/`.nsmp3`/`.nsmp4`** (amostra): cada zona de `Sample::zones`
//!   vira uma `MrqZone` com faixa de tecla `[low_note ou topo da zona
//!   anterior + 1, top_note]` — a API não expõe camada de velocidade por
//!   zona, então cada zona cobre 0..127 de velocidade inteira.
//!
//! ## O que fica de fora (documentado com honestidade no relatório de
//! compatibilidade, nunca inventado)
//!
//! - `Bank::Resonance` (toca no lugar do ataque com o pedal de sustain
//!   pressionado) e `Bank::Release` (toca ao soltar a tecla): o modelo de
//!   zona do MRQ não tem o conceito de amostra alternativa condicionada ao
//!   pedal nem de disparo em note-off — esses strokes são reportados como
//!   `Unsupported`, nunca misturados numa zona de ataque comum.
//! - Camadas de velocidade acima do limite documentado em que nunca tocam
//!   (`encode::HIGHEST_PLAYED_LAYER`) e camadas duplicadas pra uma mesma
//!   raiz (ambíguo, sem como resolver com os dados disponíveis).
//! - Nem `.npno` nem `.nsmp` expõem afinação fina, ganho ou pan por
//!   stroke/zona nesta API — `tune_cents`/`volume_db`/`pan` ficam em `0.0`
//!   (ponto neutro, não um valor "chutado": não há dado nenhum a perder).
//!
//! ## Robustez contra panics internos (lição da Fase 3)
//!
//! `nord-format` é um crate jovem (0.8, ainda pré-1.0) como o `soundfont`
//! que causou um panic em produção na Fase 3 com entrada inválida. O ponto
//! de entrada (`nord_format::from_stream`, que faz o "sniff" do contêiner)
//! é isolado com `catch_unwind` por precaução, igual `load_soundfont` fez
//! pro SF2 — ver `load_entity` abaixo.

use std::collections::{BTreeMap, HashSet};
use std::fs::File;
use std::io::{Seek, SeekFrom};
use std::path::{Path, PathBuf};

use nord_format::formats::npno::{codec as npno_codec, encode as npno_encode, Bank};
use nord_format::formats::nsmp::codec as nsmp_codec;
use nord_format::{from_stream as nord_from_stream, Entity};

use crate::mrq::model::{
    MrqCompatibilityReport, MrqFinishResult, MrqGroup, MrqInstrumentModel, MrqPreset,
    MrqSampleSourceInput, MrqSourceFormat, MrqStereoMode, MrqZone,
};
use crate::mrq::writer::{self, MrqBuilderState};

use super::errors::ImportError;

/// Resultado do parsing estrutural — mesma ideia de `sf2::Sf2Inspection`:
/// alimenta tanto a inspeção/preview quanto a conversão completa, sem
/// decodificar nenhum áudio ainda (exceto pra `.nsmp`, onde decodificamos
/// uma vez já aqui só pra descobrir `stereo`/canais de cada zona — arquivos
/// `.nsmp` são tipicamente muito menores que uma biblioteca `.npno`
/// inteira, então o custo é aceitável; `.npno` continua 100% preguiçoso).
pub struct NordInspection {
    pub instrument: MrqInstrumentModel,
    pub compatibility: MrqCompatibilityReport,
    pub(crate) pending_samples: Vec<PendingSample>,
}

pub(crate) enum PendingSample {
    /// `index` é a posição do stroke em `library.strokes()` — reaberto e
    /// relocalizado em `convert_to_mrq` (o diretório de strokes é lido
    /// sempre na mesma ordem a partir dos mesmos bytes, então o índice é
    /// estável entre duas análises do mesmo arquivo).
    NpnoStroke { sample_id: String, index: usize, channels: u16 },
    /// `index` é a posição da zona em `sample.zones()`.
    NsmpZone { sample_id: String, index: usize },
}

fn entity_kind_name(entity: &Entity) -> &'static str {
    match entity {
        Entity::Cne3(_) => "biblioteca de amostra Electro 2 (.cne3)",
        Entity::Live(_) => "slot ao vivo",
        Entity::Midi(_) => "banco SysEx em MIDI",
        Entity::OrganPreset(_) => "preset de órgão",
        Entity::Piano(_) => "biblioteca de piano (.npno)",
        Entity::PianoLibrary(_) => "biblioteca de piano Stage Classic (.nsp)",
        Entity::PianoPreset(_) => "preset de piano",
        Entity::PipeLibrary(_) => "biblioteca de órgão de tubo (.npip)",
        Entity::Performance(_) => "performance",
        Entity::Program(_) => "programa/patch",
        Entity::Sample(_) => "amostra (.nsmp)",
        Entity::SampleProject(_) => "projeto do Nord Sample Editor (.nsmpproj)",
        Entity::Settings(_) => "configurações do instrumento",
        Entity::Song(_) => "música",
        Entity::Synth(_) => "patch de sintetizador",
        Entity::Sysex(_) => "SysEx",
        // Não há braço pra `Entity::Bundle` (nem um `_` de fallback): essa
        // variante só existe com a feature `bundle` do crate (ZIP de vários
        // arquivos), que não habilitamos (não precisamos de bancos em ZIP
        // pra NPNO/NSMP avulsos) — com a feature desligada, as 16 variantes
        // acima já são exaustivas, e um `_` sobrando viraria warning de
        // "unreachable pattern" (confirmado em CI). Se um dia habilitarmos
        // a feature `bundle`, a compilação vai apontar exatamente aqui pra
        // adicionar o braço que faltar.
    }
}

/// Faz o "sniff" + parsing de alto nível do contêiner, isolado com
/// `catch_unwind` — ver nota de robustez no cabeçalho do módulo.
fn load_entity(file: &mut File) -> Result<Entity, ImportError> {
    file.seek(SeekFrom::Start(0))?;
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| nord_from_stream(file)));
    match result {
        Err(_) => Err(ImportError::InvalidNordFile {
            message: "o parser do nord-format encontrou dados malformados (falha interna irrecuperável na dependência) — arquivo provavelmente corrompido".to_string(),
        }),
        Ok(Err(e)) => Err(ImportError::InvalidNordFile { message: format!("{e}") }),
        Ok(Ok(entity)) => Ok(entity),
    }
}

/// Faz só o parsing estrutural, sem decodificar o áudio pesado do `.npno`
/// (ver nota no topo sobre a exceção do `.nsmp`) — pensado pra
/// inspeção/preview antes de converter.
pub fn inspect(path: &Path) -> Result<NordInspection, ImportError> {
    let mut file = File::open(path)?;
    let entity = load_entity(&mut file)?;
    match entity {
        Entity::Piano(piano) => inspect_piano(&piano),
        Entity::Sample(sample) => inspect_sample(&sample),
        other => Err(ImportError::InvalidNordFile {
            message: format!(
                "o arquivo é um arquivo Nord válido, mas de um tipo fora do escopo deste importador (esperado: biblioteca de piano .npno ou amostra .nsmp/.nsmp3/.nsmp4; encontrado: {}).",
                entity_kind_name(&other)
            ),
        }),
    }
}

fn inspect_piano(piano: &nord_format::formats::npno::Piano) -> Result<NordInspection, ImportError> {
    let library = piano
        .library()
        .map_err(|e| ImportError::InvalidNordFile { message: format!("{e}") })?;

    let (name, variant) = library.name();
    let channels = library.channels();
    let key_map = library.key_map();
    let strokes = library.strokes();

    let mut report = MrqCompatibilityReport::default();
    let mut by_root: BTreeMap<u8, Vec<usize>> = BTreeMap::new();

    for (index, stroke) in strokes.iter().enumerate() {
        match stroke.bank() {
            Some(Bank::Attack) => {
                by_root.entry(stroke.root).or_default().push(index);
            }
            Some(Bank::Resonance) => {
                report.add_unsupported(
                    "Bank::Resonance",
                    format!(
                        "raiz {}: stroke do banco \"resonance\" (toca no lugar do ataque quando o pedal de sustain está pressionado ao tocar a tecla) — o motor de reprodução MRQ não tem o conceito de amostra alternativa condicionada ao estado do pedal; não incluído em nenhuma zona.",
                        stroke.root
                    ),
                );
            }
            Some(Bank::Release) => {
                report.add_unsupported(
                    "Bank::Release",
                    format!(
                        "raiz {}: stroke de \"release\" (toca ao soltar a tecla) — o modelo de zona MRQ não tem um disparo separado em note-off; não incluído em nenhuma zona.",
                        stroke.root
                    ),
                );
            }
            None => {
                report.add_unsupported(
                    "banco desconhecido",
                    format!("raiz {}: stroke com código de banco não reconhecido ({}) — ignorado.", stroke.root, stroke.bank_code()),
                );
            }
        }
    }

    let highest_played = npno_encode::HIGHEST_PLAYED_LAYER;
    let mut zones_out = Vec::new();
    let mut pending_samples = Vec::new();
    let mut zone_counter: u64 = 0;

    for (&root, indices) in &by_root {
        let matching_keys: Vec<u8> = (0u8..=127).filter(|&k| key_map.get(k as usize).copied() == Some(root)).collect();
        if matching_keys.is_empty() {
            report.add_unsupported(
                "key_map",
                format!("raiz {root}: nenhuma tecla do mapa aponta pra essa raiz gravada — stroke(s) nunca tocariam no teclado original; ignorados."),
            );
            continue;
        }
        let lo_key = *matching_keys.first().expect("checado acima: não vazio");
        let hi_key = *matching_keys.last().expect("checado acima: não vazio");
        let contiguous = matching_keys.windows(2).all(|w| w[1] == w[0] + 1);
        if !contiguous {
            report.add_approximated(
                "key_map",
                format!(
                    "raiz {root}: as {} teclas mapeadas pra essa raiz não formam um intervalo contínuo — a zona cobre o intervalo [{lo_key}, {hi_key}] inteiro, que pode incluir teclas que no original tocavam outra raiz.",
                    matching_keys.len()
                ),
            );
        }

        // Ordena por camada ascendente (0 = mais forte/alta velocidade),
        // descarta camadas que nunca tocam e camadas duplicadas (ambíguo).
        let mut candidates: Vec<usize> = indices.clone();
        candidates.sort_by_key(|&idx| strokes[idx].layer());

        let mut seen_layers: HashSet<u8> = HashSet::new();
        let mut playable: Vec<usize> = Vec::new();
        for idx in candidates {
            let layer = strokes[idx].layer();
            if layer > highest_played {
                report.add_unsupported(
                    "Stroke::layer",
                    format!("raiz {root}: stroke com camada de velocidade {layer} nunca toca (acima do limite documentado de {highest_played}) — ignorado."),
                );
                continue;
            }
            if !seen_layers.insert(layer) {
                report.add_unsupported(
                    "Stroke::layer",
                    format!("raiz {root}: mais de um stroke com a mesma camada de velocidade ({layer}) — ambíguo com os dados disponíveis, mantido só o primeiro encontrado."),
                );
                continue;
            }
            playable.push(idx);
        }

        if playable.is_empty() {
            continue;
        }

        let n = playable.len();
        for (i, &idx) in playable.iter().enumerate() {
            let layer = f64::from(strokes[idx].layer());

            // Fórmula confirmada em hardware (ver `Stroke::layer`): uma
            // tecla toca a maior camada ≤ t(v) = (127-v)·31/127. Os dois
            // extremos (camada mais forte/mais fraca de cada raiz) são
            // esticados até 127/0 pra nunca deixar uma lacuna muda nas
            // pontas da faixa de velocidade.
            let hi_vel: u8 = if i == 0 {
                127
            } else {
                (127.0 - layer * 127.0 / 31.0).floor().clamp(0.0, 127.0) as u8
            };
            let lo_vel: u8 = if i == n - 1 {
                0
            } else {
                let next_layer = f64::from(strokes[playable[i + 1]].layer());
                ((127.0 - next_layer * 127.0 / 31.0).floor() + 1.0).clamp(0.0, 127.0) as u8
            };

            let sample_id = format!("npno-{zone_counter}");
            zone_counter += 1;

            zones_out.push(MrqZone {
                sample_id: sample_id.clone(),
                root_note: root,
                lo_key,
                hi_key,
                lo_vel,
                hi_vel,
                round_robin_group: None,
                round_robin_index: None,
                tune_cents: 0.0,
                volume_db: 0.0,
                pan: 0.0,
                stereo: Some(if channels >= 2 { MrqStereoMode::Stereo } else { MrqStereoMode::Mono }),
                loop_enabled: None,
                loop_start: None,
                loop_end: None,
                envelope: None,
                filter: None,
                exclusive_group: None,
            });

            pending_samples.push(PendingSample::NpnoStroke { sample_id, index: idx, channels });
        }
    }

    report.add_preserved(
        "key_map + Bank::Attack + Stroke::layer",
        "mapeamento de tecla→raiz gravada e seleção de camada de velocidade por ataque preservados usando o algoritmo documentado/confirmado em hardware do próprio formato (não uma aproximação nossa).",
    );

    let display_name = if variant.trim().is_empty() { name.clone() } else { format!("{name} ({variant})") };

    let instrument = MrqInstrumentModel {
        name: display_name,
        source_format: MrqSourceFormat::Npno,
        imported_at: super::sf2::now_iso8601(),
        presets: vec![MrqPreset {
            id: "npno".to_string(),
            name,
            groups: vec![MrqGroup { id: "piano".to_string(), name: "Piano".to_string(), zones: zones_out, envelope: None, filter: None, modulation: None }],
        }],
        midi: None,
    };

    Ok(NordInspection { instrument, compatibility: report, pending_samples })
}

fn inspect_sample(sample: &nord_format::Sample) -> Result<NordInspection, ImportError> {
    let name = sample.name().map_err(|e| ImportError::InvalidNordFile { message: format!("{e}") })?;
    let generation = sample.generation().to_string();
    let layout = sample.layout().map_err(|e| ImportError::InvalidNordFile { message: format!("{e}") })?;
    let zones = sample.zones().map_err(|e| ImportError::InvalidNordFile { message: format!("{e}") })?;

    let mut report = MrqCompatibilityReport::default();
    report.add_unsupported(
        "velocidade por zona",
        "o formato .nsmp não expõe camada de velocidade por zona nesta API — cada zona de tecla cobre a faixa de velocidade inteira (0-127).",
    );

    let mut order: Vec<usize> = (0..zones.len()).collect();
    order.sort_by_key(|&i| zones[i].top_note);

    let mut zones_out = Vec::new();
    let mut pending_samples = Vec::new();
    let mut prev_top: Option<u8> = None;
    let mut zone_counter: u64 = 0;
    let mut gaps_found = false;

    for &i in &order {
        let zone = &zones[i];
        let lo_key = match zone.low_note {
            Some(lo) => lo,
            None => prev_top.map(|t| t.saturating_add(1)).unwrap_or(0),
        };
        if let Some(prev) = prev_top {
            if zone.low_note.is_none() && lo_key > prev.saturating_add(1) {
                gaps_found = true;
            }
        }
        prev_top = Some(zone.top_note);

        let sample_id = format!("nsmp-{zone_counter}");
        zone_counter += 1;

        // Decodifica uma vez já aqui só pra saber a contagem de canais
        // (não exposta pela struct `Zone` — só a `Audio` decodificada tem
        // esse dado). Arquivo de amostra único, tipicamente pequeno; ver
        // nota no topo do módulo.
        let stereo = match nsmp_codec::decode(zone.stream, zone.at, layout) {
            Ok(audio) => Some(if audio.channels >= 2 { MrqStereoMode::Stereo } else { MrqStereoMode::Mono }),
            Err(_) => None,
        };

        zones_out.push(MrqZone {
            sample_id: sample_id.clone(),
            root_note: zone.root_key,
            lo_key,
            hi_key: zone.top_note,
            lo_vel: 0,
            hi_vel: 127,
            round_robin_group: None,
            round_robin_index: None,
            tune_cents: 0.0,
            volume_db: 0.0,
            pan: 0.0,
            stereo,
            loop_enabled: None,
            loop_start: None,
            loop_end: None,
            envelope: None,
            filter: None,
            exclusive_group: None,
        });

        pending_samples.push(PendingSample::NsmpZone { sample_id, index: i });
    }

    if gaps_found {
        report.add_approximated(
            "zone.low_note",
            "uma ou mais zonas não guardam a nota mais grave explicitamente (geração sem esse campo) — o grave foi derivado como \"topo da zona anterior + 1\", que é a convenção do próprio formato pra zonas que se encostam.",
        );
    }

    let instrument = MrqInstrumentModel {
        name: format!("{name} ({generation})"),
        source_format: MrqSourceFormat::Nsmp,
        imported_at: super::sf2::now_iso8601(),
        presets: vec![MrqPreset {
            id: "nsmp".to_string(),
            name,
            groups: vec![MrqGroup { id: "sample".to_string(), name: "Amostra".to_string(), zones: zones_out, envelope: None, filter: None, modulation: None }],
        }],
        midi: None,
    };

    Ok(NordInspection { instrument, compatibility: report, pending_samples })
}

/// Faz o parsing completo (reaproveitando `inspect`) e decodifica todo o
/// áudio necessário, gravando o `.mrq` final via `mrq::writer` (Fase 2).
/// Roda inteiramente no processo Rust.
pub fn convert_to_mrq(
    builder_state: &MrqBuilderState,
    source_path: &Path,
    dest_path: PathBuf,
) -> Result<(MrqFinishResult, MrqCompatibilityReport), ImportError> {
    let mut file = File::open(source_path)?;
    let entity = load_entity(&mut file)?;

    let inspection = inspect(source_path)?;
    let mut report = inspection.compatibility;

    let session_id = writer::begin(builder_state, dest_path, inspection.instrument)?;

    match entity {
        Entity::Piano(piano) => {
            let library = piano
                .library()
                .map_err(|e| ImportError::InvalidNordFile { message: format!("{e}") })?;
            let strokes = library.strokes();

            for pending in &inspection.pending_samples {
                let PendingSample::NpnoStroke { sample_id, index, channels } = pending else { continue };
                let Some(stroke) = strokes.get(*index) else {
                    let _ = writer::abort(builder_state, &session_id);
                    return Err(ImportError::InvalidNordFile {
                        message: "índice de stroke inconsistente entre a inspeção e a conversão — arquivo pode ter mudado entre as duas chamadas.".to_string(),
                    });
                };

                let audio = match npno_codec::decode(stroke, *channels) {
                    Ok(a) => a,
                    Err(e) => {
                        let _ = writer::abort(builder_state, &session_id);
                        return Err(ImportError::InvalidNordFile { message: format!("falha ao decodificar o stroke da raiz {}: {e}", stroke.root) });
                    }
                };

                let interleaved: Vec<i32> = audio.interleaved().into_iter().map(i32::from).collect();
                writer::add_sample(
                    builder_state,
                    &session_id,
                    sample_id.clone(),
                    MrqSampleSourceInput::IntegerPcm { bits_per_sample: 16, interleaved },
                    npno_codec::RATE,
                    *channels,
                )?;
            }
        }
        Entity::Sample(sample) => {
            let layout = sample
                .layout()
                .map_err(|e| ImportError::InvalidNordFile { message: format!("{e}") })?;
            let zones = sample
                .zones()
                .map_err(|e| ImportError::InvalidNordFile { message: format!("{e}") })?;

            for pending in &inspection.pending_samples {
                let PendingSample::NsmpZone { sample_id, index } = pending else { continue };
                let Some(zone) = zones.get(*index) else {
                    let _ = writer::abort(builder_state, &session_id);
                    return Err(ImportError::InvalidNordFile {
                        message: "índice de zona inconsistente entre a inspeção e a conversão — arquivo pode ter mudado entre as duas chamadas.".to_string(),
                    });
                };

                let audio = match nsmp_codec::decode(zone.stream, zone.at, layout) {
                    Ok(a) => a,
                    Err(e) => {
                        let _ = writer::abort(builder_state, &session_id);
                        return Err(ImportError::InvalidNordFile { message: format!("falha ao decodificar a zona da raiz {}: {e}", zone.root_key) });
                    }
                };

                let channels = audio.channels;
                let interleaved: Vec<i32> = audio.samples.into_iter().map(i32::from).collect();
                writer::add_sample(
                    builder_state,
                    &session_id,
                    sample_id.clone(),
                    MrqSampleSourceInput::IntegerPcm { bits_per_sample: 16, interleaved },
                    nsmp_codec::FIELD_RATE,
                    channels,
                )?;
            }
        }
        _ => unreachable!("inspect() já teria rejeitado qualquer outro tipo de Entity"),
    }

    let result = writer::finish(builder_state, &session_id)?;
    report.add_preserved(
        "Áudio",
        "todas as amostras decodificadas do codec proprietário da Nord (preditor de diferenças finitas, formato confirmado em hardware) e recodificadas em FLAC lossless dentro do .mrq gerado.",
    );
    Ok((result, report))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
    }

    #[test]
    fn inspects_a_synthetic_npno_piano_library_and_splits_attack_strokes_by_velocity() {
        let inspection = inspect(&fixture("synthetic-test-piano.npno")).expect("deveria ser um .npno válido");
        assert_eq!(inspection.instrument.source_format, MrqSourceFormat::Npno);
        assert_eq!(inspection.instrument.presets.len(), 1);
        let zones = &inspection.instrument.presets[0].groups[0].zones;
        // 3 raízes (48/60/72), 2 camadas de ataque cada = 6 zonas de ataque.
        assert_eq!(zones.len(), 6, "deveria ter 6 zonas de ataque (3 raízes x 2 camadas)");
        assert_eq!(inspection.pending_samples.len(), 6);

        // O stroke de release (raiz 60) deve ter sido reportado como Unsupported, não virar zona.
        assert!(
            inspection.compatibility.unsupported.iter().any(|i| i.field == "Bank::Release"),
            "o stroke de release deveria estar no relatório de compatibilidade como Unsupported"
        );

        // As duas camadas da raiz 60 devem cobrir 0..127 sem sobreposição nem lacuna.
        let mut root60: Vec<&MrqZone> = zones.iter().filter(|z| z.root_note == 60).collect();
        root60.sort_by_key(|z| z.lo_vel);
        assert_eq!(root60.len(), 2);
        assert_eq!(root60[0].lo_vel, 0);
        assert_eq!(root60[1].hi_vel, 127);
        assert_eq!(root60[0].hi_vel + 1, root60[1].lo_vel, "as duas camadas de velocidade deveriam ser contíguas, sem lacuna");
    }

    #[test]
    fn converts_a_synthetic_npno_file_to_mrq_and_reads_it_back_losslessly() {
        let state = MrqBuilderState::default();
        let dir = std::env::temp_dir().join(format!("mrq_npno_import_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("piano.mrq");

        let (result, report) = convert_to_mrq(&state, &fixture("synthetic-test-piano.npno"), dest.clone()).expect("conversão deveria funcionar");
        assert_eq!(result.sample_count, 6);
        assert!(!report.preserved.is_empty());

        let metadata = crate::mrq::reader::read_file_metadata(&dest).expect("deveria ler o .mrq de volta");
        assert_eq!(metadata.samples.len(), result.sample_count);

        let integrity = crate::mrq::reader::validate_integrity(&dest).expect("validate_integrity não deveria falhar estruturalmente");
        assert!(integrity.global_ok);
        assert!(integrity.per_sample.iter().all(|s| s.ok));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn inspects_a_synthetic_nsmp_sample_file() {
        let inspection = inspect(&fixture("synthetic-test-nsmp.nsmp")).expect("deveria ser um .nsmp válido");
        assert_eq!(inspection.instrument.source_format, MrqSourceFormat::Nsmp);
        let zones = &inspection.instrument.presets[0].groups[0].zones;
        assert!(!zones.is_empty(), "deveria ter pelo menos 1 zona");
        assert_eq!(inspection.pending_samples.len(), zones.len());
        assert!(zones.iter().all(|z| z.lo_vel == 0 && z.hi_vel == 127), "zonas .nsmp cobrem a faixa de velocidade inteira");
    }

    #[test]
    fn converts_a_synthetic_nsmp_file_to_mrq_and_reads_it_back_losslessly() {
        let state = MrqBuilderState::default();
        let dir = std::env::temp_dir().join(format!("mrq_nsmp_import_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("sample.mrq");

        let (result, _report) = convert_to_mrq(&state, &fixture("synthetic-test-nsmp.nsmp"), dest.clone()).expect("conversão deveria funcionar");
        assert!(result.sample_count > 0);

        let integrity = crate::mrq::reader::validate_integrity(&dest).expect("validate_integrity não deveria falhar estruturalmente");
        assert!(integrity.global_ok);
        assert!(integrity.per_sample.iter().all(|s| s.ok));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_a_file_that_is_not_a_nord_file() {
        let dir = std::env::temp_dir().join(format!("mrq_npno_garbage_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("not-a-nord-file.npno");
        std::fs::write(&path, b"isto nao e um arquivo Nord valido, nem de longe").unwrap();

        let result = inspect(&path);
        assert!(matches!(result, Err(ImportError::InvalidNordFile { .. })));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_a_corrupt_npno_fixture_without_panicking() {
        let result = inspect(&fixture("corrupt.npno"));
        assert!(result.is_err(), "um .npno corrompido deveria falhar de forma estruturada, nunca entrar em panic sem controle");
    }
}
