//! Importador SF2/SF3 → `MrqInstrumentModel` (Fase 3 do MRQ Instrument
//! Converter — ver docs/mrq-converter-architecture.md). Depende só de
//! `crate::mrq::model`/`crate::mrq::writer` — nunca de UI — pra essa lógica
//! poder um dia ser extraída pra um app "MRQ Instrument Converter" separado.
//!
//! ## Fidelidade
//!
//! Interpreta os generators reais do spec SF2.01 (todos os 61 de
//! `GeneratorType`), incluindo:
//! - merge entre a "zona global" (instrumento/preset) e cada zona
//!   específica, como o spec manda (zona específica sobrescreve o valor
//!   global, generator a generator);
//! - o "offset aditivo" de generators no nível do preset sobre os do nível
//!   do instrumento (seção 9.4 do spec) — só aplicado quando o instrumento
//!   TAMBÉM define o mesmo generator explicitamente (ver
//!   `ADDITIVE_AT_PRESET_LEVEL` abaixo pra detalhe e justificativa);
//! - offsets de endereço de amostra/loop (`StartAddrsOffset` e primos) —
//!   cada zona pode usar só uma fatia da amostra compartilhada, então cada
//!   zona vira uma amostra MRQ independente (ver `convert_to_mrq`);
//! - SF3 (amostras comprimidas Vorbis) via `SampleLink::is_vorbis()` +
//!   decodificação com `lewton` — sempre no backend Rust, nunca no WebView.
//!
//! O que este importador **não** interpreta ainda (documentado com
//! honestidade no relatório de compatibilidade, nunca inventado): a tabela
//! de modulators explícitos (`mod_list`, roteamento via controlador MIDI
//! "bit-packed") — só os generators `ModXxxToYyy`/`VibLfoToPitch` (que já
//! cobrem vibrato/tremolo/sweep de filtro via LFO e envelope, o caso mais
//! comum na prática) viram `MrqModulation`, sempre no nível do grupo
//! (`MrqGroup.modulation` — `MrqZone` não tem campo de modulação própria).

use std::collections::HashMap;
use std::fs::File;
use std::io::{Cursor, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use soundfont::raw::{Generator, GeneratorAmount, GeneratorType, SampleHeader, SampleLink};
use soundfont::{Instrument, SoundFont2, Zone};

use crate::mrq::model::{
    MrqCompatibilityReport, MrqEnvelope, MrqFilter, MrqFilterType, MrqFinishResult, MrqGroup,
    MrqInstrumentModel, MrqModulation, MrqModulationDestination, MrqModulationSource, MrqPreset,
    MrqSampleSourceInput, MrqSourceFormat, MrqStereoMode, MrqZone,
};
use crate::mrq::writer::{self, MrqBuilderState};

use super::errors::ImportError;

/// Generators que o spec SF2.01 (seção 9.4) trata como "relativos": o valor
/// no nível do preset é SOMADO ao valor no nível do instrumento/zona, nunca
/// o substitui. Fora desta lista estão os generators "estruturais" (faixa
/// de tecla/velocity, referências a amostra/instrumento, endereçamento de
/// amostra/loop, SampleModes, ExclusiveClass) — esses só fazem sentido no
/// nível do instrumento e são ignorados se aparecerem no nível do preset.
const ADDITIVE_AT_PRESET_LEVEL: &[GeneratorType] = &[
    GeneratorType::ModLfoToPitch,
    GeneratorType::VibLfoToPitch,
    GeneratorType::ModEnvToPitch,
    GeneratorType::InitialFilterFc,
    GeneratorType::InitialFilterQ,
    GeneratorType::ModLfoToFilterFc,
    GeneratorType::ModEnvToFilterFc,
    GeneratorType::ModLfoToVolume,
    GeneratorType::ChorusEffectsSend,
    GeneratorType::ReverbEffectsSend,
    GeneratorType::Pan,
    GeneratorType::DelayModLFO,
    GeneratorType::FreqModLFO,
    GeneratorType::DelayVibLFO,
    GeneratorType::FreqVibLFO,
    GeneratorType::DelayModEnv,
    GeneratorType::AttackModEnv,
    GeneratorType::HoldModEnv,
    GeneratorType::DecayModEnv,
    GeneratorType::SustainModEnv,
    GeneratorType::ReleaseModEnv,
    GeneratorType::KeynumToModEnvHold,
    GeneratorType::KeynumToModEnvDecay,
    GeneratorType::DelayVolEnv,
    GeneratorType::AttackVolEnv,
    GeneratorType::HoldVolEnv,
    GeneratorType::DecayVolEnv,
    GeneratorType::SustainVolEnv,
    GeneratorType::ReleaseVolEnv,
    GeneratorType::KeynumToVolEnvHold,
    GeneratorType::KeynumToVolEnvDecay,
    GeneratorType::CoarseTune,
    GeneratorType::FineTune,
    GeneratorType::ScaleTuning,
    GeneratorType::InitialAttenuation,
];

// --------------------------------------------------------------------
// Helpers de leitura de generators — nunca confiamos num método de
// conveniência com assinatura ambígua; sempre lemos `gen_list` diretamente
// e comparamos pelo valor bruto (`as_raw`/`as u16`), o que também funciona
// corretamente para generators fora do spec (`SfEnum::Unknown`).
// --------------------------------------------------------------------

fn gen_map(gens: &[Generator]) -> HashMap<u16, GeneratorAmount> {
    let mut map = HashMap::new();
    for g in gens {
        map.insert(g.ty.as_raw(), g.amount.clone());
    }
    map
}

fn merged_map(base: &HashMap<u16, GeneratorAmount>, overlay: &[Generator]) -> HashMap<u16, GeneratorAmount> {
    let mut m = base.clone();
    for g in overlay {
        m.insert(g.ty.as_raw(), g.amount.clone());
    }
    m
}

fn amt_i16(map: &HashMap<u16, GeneratorAmount>, ty: GeneratorType) -> Option<i16> {
    map.get(&(ty as u16)).and_then(|a| a.as_i16().copied())
}

fn amt_u16(map: &HashMap<u16, GeneratorAmount>, ty: GeneratorType) -> Option<u16> {
    map.get(&(ty as u16))
        .and_then(|a| a.as_u16().copied().or_else(|| a.as_i16().map(|v| *v as u16)))
}

fn amt_range(map: &HashMap<u16, GeneratorAmount>, ty: GeneratorType) -> Option<(u8, u8)> {
    map.get(&(ty as u16)).and_then(|a| a.as_range()).map(|r| (r.low, r.high))
}

fn amount_as_i32(a: &GeneratorAmount) -> Option<i32> {
    match a {
        GeneratorAmount::I16(v) => Some(*v as i32),
        GeneratorAmount::U16(v) => Some(*v as i32),
        GeneratorAmount::Range(_) => None,
    }
}

/// A primeira zona de uma lista é a "zona global" quando ela NÃO contém o
/// generator que define o que a zona referencia (`Instrument` pro preset,
/// `SampleID` pro instrumento) — exatamente como o spec SF2.01 define.
fn split_global(zones: &[Zone], defining_gen: GeneratorType) -> (Option<&Zone>, &[Zone]) {
    if let Some(first) = zones.first() {
        let has_defining = first.gen_list.iter().any(|g| g.ty.as_raw() == defining_gen as u16);
        if !has_defining {
            return (Some(first), &zones[1..]);
        }
    }
    (None, zones)
}

// --------------------------------------------------------------------
// Conversões de unidade do spec SF2.01 — cada uma documentada no relatório
// de compatibilidade de quem as usa, nunca aplicada "em silêncio".
// --------------------------------------------------------------------

/// timecents → segundos. `-32768` é o valor-sentinela do spec pra "0s"
/// (tempo mínimo/instantâneo).
fn timecents_to_seconds(tc: i32) -> f64 {
    if tc <= -32768 {
        0.0
    } else {
        2f64.powf(tc as f64 / 1200.0)
    }
}

/// cents absolutos → Hz (fórmula do spec: 8.176 Hz é a referência do MIDI
/// note 0).
fn absolute_cents_to_hz(cents: i32) -> f64 {
    8.176 * 2f64.powf(cents as f64 / 1200.0)
}

fn centibels_to_db(cb: i32) -> f64 {
    cb as f64 / 10.0
}

/// `InitialFilterQ` é definido no spec em centibels (unidade 0.1 dB) de
/// altura do pico de ressonância acima do nível DC. Convertemos pra um
/// fator Q genérico (`10^(dB/20)`) — aproximação razoável, mas não é
/// garantidamente idêntica à curva de nenhum filtro específico, por isso
/// sempre entra como "Approximated" no relatório.
fn initial_filter_q_to_resonance(cb: i32) -> f64 {
    10f64.powf(centibels_to_db(cb) / 20.0)
}

/// Resultado do parsing estrutural (seção 7.1 do documento de arquitetura:
/// alimenta tanto o "Inspetor de Instrumentos"/Analyzer quanto a conversão
/// completa). Não contém nenhum áudio decodificado ainda.
pub struct Sf2Inspection {
    pub instrument: MrqInstrumentModel,
    pub compatibility: MrqCompatibilityReport,
    pub(crate) pending_samples: Vec<PendingSample>,
}

pub(crate) struct PendingSample {
    pub sample_id: String,
    pub header: SampleHeader,
    pub is_vorbis: bool,
    /// Faixa efetiva (já com os offsets de endereço do generator
    /// aplicados), em unidades de FRAME pra PCM ou de BYTE pra Vorbis (ver
    /// `extract_pcm`).
    pub eff_start: u64,
    pub eff_end: u64,
}

/// Carrega e faz o parsing de um SF2/SF3, de um jeito defensivo contra a
/// imaturidade da crate `soundfont` v0.1.0: ela valida o magic RIFF (e
/// possivelmente outros invariantes internos) com `assert_eq!`/`unwrap()`
/// em vez de devolver um `Result` — ou seja, um arquivo que não é um
/// SoundFont de verdade literalmente **entra em panic** dentro da
/// dependência ao invés de simplesmente falhar. Por isso: (1) checamos a
/// assinatura RIFF manualmente ANTES de chamar o parser (cobre o caso mais
/// comum — arquivo errado — sem nem acionar a crate), e (2) isolamos a
/// chamada ao parser com `catch_unwind` como cinto de segurança contra
/// qualquer outro panic interno em arquivos malformados-mas-com-RIFF-válido
/// — nunca derrubamos a thread do comando Tauri por causa de um arquivo de
/// entrada ruim.
fn load_soundfont(file: &mut File) -> Result<SoundFont2, ImportError> {
    let mut magic = [0u8; 4];
    let looks_like_riff = file.read_exact(&mut magic).is_ok() && &magic == b"RIFF";
    file.seek(SeekFrom::Start(0))?;
    if !looks_like_riff {
        return Err(ImportError::InvalidSoundFont {
            message: "arquivo não começa com a assinatura RIFF — não é um SoundFont (.sf2/.sf3) válido".to_string(),
        });
    }

    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| SoundFont2::load(file)))
        .map_err(|_| ImportError::InvalidSoundFont {
            message: "o parser SF2 encontrou dados malformados (falha interna irrecuperável na dependência) — arquivo provavelmente corrompido".to_string(),
        })?
        .map_err(|e| ImportError::InvalidSoundFont { message: format!("{e:?}") })
}

/// Faz só o parsing estrutural (presets/grupos/zonas/generators →
/// `MrqInstrumentModel` + relatório de compatibilidade), sem decodificar
/// nenhum áudio — rápido, pensado pra inspeção/preview antes de converter.
pub fn inspect(path: &Path) -> Result<Sf2Inspection, ImportError> {
    let mut file = File::open(path)?;
    let sf2 = load_soundfont(&mut file)?;

    let mut report = MrqCompatibilityReport::default();

    let has_valid_sm24 = match (&sf2.sample_data.smpl, &sf2.sample_data.sm24) {
        (Some(smpl), Some(sm24)) => {
            let expected = (smpl.len as u64).div_ceil(2);
            sm24.len as u64 == expected
        }
        _ => false,
    };
    if has_valid_sm24 {
        report.add_preserved("sm24", "amostras de 24 bits detectadas (chunk sm24 válido) — profundidade original preservada, sem conversão/arredondamento.");
    }

    let mut presets_out = Vec::new();
    let mut pending_samples = Vec::new();
    let mut zone_counter: u64 = 0;

    for preset in &sf2.presets {
        let (preset_global, preset_zones) = split_global(&preset.zones, GeneratorType::Instrument);
        let preset_global_map = preset_global.map(|z| gen_map(&z.gen_list)).unwrap_or_default();

        let mut groups_out = Vec::new();

        for (inst_zone_idx, pz) in preset_zones.iter().enumerate() {
            let preset_zone_map = merged_map(&preset_global_map, &pz.gen_list);
            let Some(inst_idx) = amt_u16(&preset_zone_map, GeneratorType::Instrument) else { continue };
            let Some(instrument) = sf2.instruments.get(inst_idx as usize) else {
                report.add_unsupported(
                    "Instrument",
                    format!("preset '{}' referencia um índice de instrumento inválido ({inst_idx}) — zona ignorada.", preset.header.name),
                );
                continue;
            };

            if let Some(group) = build_group(
                instrument,
                &preset_zone_map,
                &format!("p{}-{}-i{}", preset.header.bank, preset.header.preset, inst_zone_idx),
                &sf2,
                &mut report,
                &mut pending_samples,
                &mut zone_counter,
            ) {
                groups_out.push(group);
            }
        }

        presets_out.push(MrqPreset {
            id: format!("bank{}-preset{}", preset.header.bank, preset.header.preset),
            name: preset.header.name.clone(),
            groups: groups_out,
        });
    }

    let source_format = if sf2.sample_headers.iter().any(|s| s.sample_type.is_vorbis()) {
        MrqSourceFormat::Sf3
    } else {
        MrqSourceFormat::Sf2
    };

    let instrument = MrqInstrumentModel {
        name: sf2.info.bank_name.clone(),
        source_format,
        imported_at: now_iso8601(),
        presets: presets_out,
        midi: None,
    };

    Ok(Sf2Inspection { instrument, compatibility: report, pending_samples })
}

#[allow(clippy::too_many_arguments)]
fn build_group(
    instrument: &Instrument,
    preset_zone_map: &HashMap<u16, GeneratorAmount>,
    group_id: &str,
    sf2: &SoundFont2,
    report: &mut MrqCompatibilityReport,
    pending_samples: &mut Vec<PendingSample>,
    zone_counter: &mut u64,
) -> Option<MrqGroup> {
    let (inst_global, inst_zones) = split_global(&instrument.zones, GeneratorType::SampleID);
    let inst_global_map = inst_global.map(|z| gen_map(&z.gen_list)).unwrap_or_default();

    // Modulação: só a partir dos generators "ModXxxToYyy" da zona global do
    // instrumento (o caso de uso comum). Sempre no nível do GRUPO —
    // `MrqZone` não tem campo de modulação própria neste modelo.
    let modulation = build_group_modulation(&inst_global_map, report);

    let mut zones_out = Vec::new();

    for iz in inst_zones {
        let inst_zone_map = merged_map(&inst_global_map, &iz.gen_list);
        let Some(sample_idx) = amt_u16(&inst_zone_map, GeneratorType::SampleID) else { continue };
        let Some(sample_header) = sf2.sample_headers.get(sample_idx as usize).cloned() else {
            report.add_unsupported("SampleID", "zona referencia um índice de amostra inválido — zona ignorada.");
            continue;
        };

        if sample_header.sample_type.is_rom() {
            report.add_unsupported(
                "ROM sample",
                format!("amostra '{}' referencia dados de ROM do sintetizador (não embutidos no arquivo) — não é possível extrair o áudio, zona ignorada.", sample_header.name),
            );
            continue;
        }

        let final_numeric = apply_preset_offsets(
            &inst_zone_map,
            preset_zone_map,
            report,
            &format!("{} / {}", instrument.header.name, sample_header.name),
        );

        let (lo_key, hi_key) = amt_range(&inst_zone_map, GeneratorType::KeyRange).unwrap_or((0, 127));
        let (lo_vel, hi_vel) = amt_range(&inst_zone_map, GeneratorType::VelRange).unwrap_or((0, 127));

        let root_note = amt_u16(&inst_zone_map, GeneratorType::OverridingRootKey)
            .map(|v| v as u8)
            .unwrap_or(sample_header.origpitch);

        let coarse_tune = final_numeric.get(&(GeneratorType::CoarseTune as u16)).copied().unwrap_or(0);
        let fine_tune = final_numeric.get(&(GeneratorType::FineTune as u16)).copied().unwrap_or(0);
        let tune_cents = f64::from(coarse_tune * 100 + fine_tune) + f64::from(sample_header.pitchadj);

        let attenuation_cb = final_numeric.get(&(GeneratorType::InitialAttenuation as u16)).copied().unwrap_or(0);
        let volume_db = -centibels_to_db(attenuation_cb);

        let pan_raw = final_numeric.get(&(GeneratorType::Pan as u16)).copied().unwrap_or(0);
        let pan = (f64::from(pan_raw) / 500.0).clamp(-1.0, 1.0);

        let exclusive_group = amt_u16(&inst_zone_map, GeneratorType::ExclusiveClass).filter(|&v| v != 0);
        if exclusive_group.is_some() {
            report.add_approximated(
                "ExclusiveClass",
                format!(
                    "'{}': grupo de exclusividade (\"choke\") preservado como dado (exclusiveGroup), mas o motor de reprodução MRQ ainda não aplica esse comportamento sonoro.",
                    instrument.header.name
                ),
            );
        }

        let envelope = build_envelope(&final_numeric, report);
        let filter = build_filter(&final_numeric, report);

        if !iz.mod_list.is_empty() {
            report.add_unsupported(
                "mod_list (Modulators explícitos)",
                format!(
                    "zona de '{}' define modulators explícitos (roteamento via controlador MIDI) — não interpretados nesta fase, não gravados em nenhum campo.",
                    instrument.header.name
                ),
            );
        }

        let sample_modes = amt_u16(&inst_zone_map, GeneratorType::SampleModes).unwrap_or(0);
        let loop_enabled = sample_modes == 1 || sample_modes == 3;

        let is_vorbis = sample_header.sample_type.is_vorbis();

        let (eff_start, eff_end, eff_loop_start, eff_loop_end) = if is_vorbis {
            // SF3: start/end do cabeçalho de amostra são repropostos como
            // offsets de BYTE do stream Ogg/Vorbis comprimido dentro do
            // chunk `smpl` (convenção adotada pelo próprio formato .sf3,
            // não documentada no spec SF2.01 original) — os generators de
            // endereçamento fino/grosso não se aplicam a dados comprimidos.
            (
                i64::from(sample_header.start),
                i64::from(sample_header.end),
                i64::from(sample_header.loop_start),
                i64::from(sample_header.loop_end),
            )
        } else {
            let coarse_start = i64::from(amt_i16(&inst_zone_map, GeneratorType::StartAddrsCoarseOffset).unwrap_or(0)) * 32768;
            let fine_start = i64::from(amt_i16(&inst_zone_map, GeneratorType::StartAddrsOffset).unwrap_or(0));
            let coarse_end = i64::from(amt_i16(&inst_zone_map, GeneratorType::EndAddrsCoarseOffset).unwrap_or(0)) * 32768;
            let fine_end = i64::from(amt_i16(&inst_zone_map, GeneratorType::EndAddrsOffset).unwrap_or(0));
            let coarse_loop_start = i64::from(amt_i16(&inst_zone_map, GeneratorType::StartloopAddrsCoarseOffset).unwrap_or(0)) * 32768;
            let fine_loop_start = i64::from(amt_i16(&inst_zone_map, GeneratorType::StartloopAddrsOffset).unwrap_or(0));
            let coarse_loop_end = i64::from(amt_i16(&inst_zone_map, GeneratorType::EndloopAddrsCoarseOffset).unwrap_or(0)) * 32768;
            let fine_loop_end = i64::from(amt_i16(&inst_zone_map, GeneratorType::EndloopAddrsOffset).unwrap_or(0));

            (
                i64::from(sample_header.start) + coarse_start + fine_start,
                i64::from(sample_header.end) + coarse_end + fine_end,
                i64::from(sample_header.loop_start) + coarse_loop_start + fine_loop_start,
                i64::from(sample_header.loop_end) + coarse_loop_end + fine_loop_end,
            )
        };

        if eff_start < 0 || eff_end <= eff_start {
            report.add_unsupported(
                "StartAddrsOffset/EndAddrsOffset",
                format!("amostra '{}': faixa inválida após aplicar offsets ({eff_start}..{eff_end}) — zona ignorada.", sample_header.name),
            );
            continue;
        }

        let stereo = match sample_header.sample_type {
            SampleLink::MonoSample | SampleLink::RomMonoSample | SampleLink::VorbisMonoSample => MrqStereoMode::Mono,
            SampleLink::LeftSample | SampleLink::RomLeftSample | SampleLink::VorbisLeftSample => MrqStereoMode::Left,
            SampleLink::RightSample | SampleLink::RomRightSample | SampleLink::VorbisRightSample => MrqStereoMode::Right,
            _ => MrqStereoMode::Mono,
        };

        let sample_id = format!("sf2-{zone_counter}");
        *zone_counter += 1;

        pending_samples.push(PendingSample {
            sample_id: sample_id.clone(),
            header: sample_header,
            is_vorbis,
            eff_start: eff_start as u64,
            eff_end: eff_end as u64,
        });

        zones_out.push(MrqZone {
            sample_id,
            root_note,
            lo_key,
            hi_key,
            lo_vel,
            hi_vel,
            // SF2 não tem um conceito nativo de round robin (zonas com a
            // mesma faixa de tecla/velocity simplesmente tocam juntas, não
            // alternam) — por isso nunca preenchido aqui.
            round_robin_group: None,
            round_robin_index: None,
            tune_cents,
            volume_db,
            pan,
            stereo: Some(stereo),
            loop_enabled: Some(loop_enabled),
            loop_start: if loop_enabled { Some((eff_loop_start - eff_start).max(0) as u64) } else { None },
            loop_end: if loop_enabled { Some((eff_loop_end - eff_start).max(0) as u64) } else { None },
            envelope,
            filter,
            exclusive_group,
        });
    }

    if zones_out.is_empty() {
        return None;
    }

    Some(MrqGroup {
        id: group_id.to_string(),
        name: instrument.header.name.clone(),
        zones: zones_out,
        envelope: None,
        filter: None,
        modulation,
    })
}

fn build_group_modulation(inst_global_map: &HashMap<u16, GeneratorAmount>, report: &mut MrqCompatibilityReport) -> Option<Vec<MrqModulation>> {
    let mut modulation = Vec::new();
    for (ty, dest) in [
        (GeneratorType::ModLfoToPitch, MrqModulationDestination::Pitch),
        (GeneratorType::VibLfoToPitch, MrqModulationDestination::Pitch),
        (GeneratorType::ModLfoToFilterFc, MrqModulationDestination::Cutoff),
        (GeneratorType::ModLfoToVolume, MrqModulationDestination::Volume),
    ] {
        if let Some(amount) = amt_i16(inst_global_map, ty) {
            modulation.push(MrqModulation { source: MrqModulationSource::Lfo, destination: dest, amount: f64::from(amount) });
        }
    }
    for (ty, dest) in [
        (GeneratorType::ModEnvToPitch, MrqModulationDestination::Pitch),
        (GeneratorType::ModEnvToFilterFc, MrqModulationDestination::Cutoff),
    ] {
        if let Some(amount) = amt_i16(inst_global_map, ty) {
            modulation.push(MrqModulation { source: MrqModulationSource::Envelope2, destination: dest, amount: f64::from(amount) });
        }
    }
    if !modulation.is_empty() {
        report.add_preserved("ModLfoTo*/ModEnvTo*", "modulação via generators (LFO/envelope → pitch/corte/volume) preservada no nível do grupo.");
        Some(modulation)
    } else {
        None
    }
}

fn build_envelope(final_numeric: &HashMap<u16, i32>, report: &mut MrqCompatibilityReport) -> Option<MrqEnvelope> {
    let env_gens = [
        GeneratorType::DelayVolEnv,
        GeneratorType::AttackVolEnv,
        GeneratorType::HoldVolEnv,
        GeneratorType::DecayVolEnv,
        GeneratorType::SustainVolEnv,
        GeneratorType::ReleaseVolEnv,
    ];
    if !env_gens.iter().any(|t| final_numeric.contains_key(&(*t as u16))) {
        return None;
    }
    let attack = timecents_to_seconds(final_numeric.get(&(GeneratorType::AttackVolEnv as u16)).copied().unwrap_or(-12000));
    let hold = final_numeric
        .get(&(GeneratorType::HoldVolEnv as u16))
        .copied()
        .map(timecents_to_seconds);
    let decay = timecents_to_seconds(final_numeric.get(&(GeneratorType::DecayVolEnv as u16)).copied().unwrap_or(-12000));
    // SustainVolEnv é em centibels de ATENUAÇÃO a partir do pico (0 = sem
    // atenuação/volume cheio, 1000 = -100dB ~ silêncio) — convertido pra
    // fração linear 0..1 (sustain do nosso modelo).
    let sustain_cb = final_numeric.get(&(GeneratorType::SustainVolEnv as u16)).copied().unwrap_or(0);
    let sustain = (1.0 - f64::from(sustain_cb) / 1000.0).clamp(0.0, 1.0);
    let release = timecents_to_seconds(final_numeric.get(&(GeneratorType::ReleaseVolEnv as u16)).copied().unwrap_or(-12000));

    report.add_preserved(
        "VolEnv (Delay/Attack/Hold/Decay/Sustain/Release)",
        "envelope de volume convertido de timecents/centibels (unidades do spec SF2) para segundos/fração linear.",
    );

    Some(MrqEnvelope { attack, hold, decay, sustain, release })
}

fn build_filter(final_numeric: &HashMap<u16, i32>, report: &mut MrqCompatibilityReport) -> Option<MrqFilter> {
    let has_fc = final_numeric.contains_key(&(GeneratorType::InitialFilterFc as u16));
    let has_q = final_numeric.contains_key(&(GeneratorType::InitialFilterQ as u16));
    if !has_fc && !has_q {
        return None;
    }
    let cutoff_cents = final_numeric.get(&(GeneratorType::InitialFilterFc as u16)).copied().unwrap_or(13500);
    let q_cb = final_numeric.get(&(GeneratorType::InitialFilterQ as u16)).copied().unwrap_or(0);

    report.add_preserved("InitialFilterFc", "frequência de corte do filtro (sempre passa-baixa no SF2) convertida de cents absolutos para Hz.");
    report.add_approximated(
        "InitialFilterQ",
        "ressonância convertida de centibels (unidade do spec SF2) para um fator Q genérico — aproximação, não garantidamente idêntica à curva do filtro original.",
    );

    Some(MrqFilter {
        filter_type: MrqFilterType::LowPass,
        cutoff_hz: absolute_cents_to_hz(cutoff_cents),
        resonance: initial_filter_q_to_resonance(q_cb),
    })
}

/// Aplica, generator a generator, o offset ADITIVO do nível do preset sobre
/// o valor do nível do instrumento/zona — só quando o instrumento também
/// define o mesmo generator explicitamente (ver documentação de
/// `ADDITIVE_AT_PRESET_LEVEL` sobre essa limitação deliberada).
fn apply_preset_offsets(
    instrument_map: &HashMap<u16, GeneratorAmount>,
    preset_map: &HashMap<u16, GeneratorAmount>,
    report: &mut MrqCompatibilityReport,
    context: &str,
) -> HashMap<u16, i32> {
    let mut out = HashMap::new();
    for ty in ADDITIVE_AT_PRESET_LEVEL {
        let raw = *ty as u16;
        let inst_val = instrument_map.get(&raw).and_then(amount_as_i32);
        let preset_val = preset_map.get(&raw).and_then(amount_as_i32);
        match (inst_val, preset_val) {
            (Some(i), Some(p)) => {
                out.insert(raw, i + p);
            }
            (Some(i), None) => {
                out.insert(raw, i);
            }
            (None, Some(_)) => {
                report.add_approximated(
                    format!("{ty:?} (nível do preset)"),
                    format!(
                        "'{context}': generator definido só no nível do preset, sem valor explícito no instrumento — offset aditivo NÃO aplicado (o valor-base padrão do SF2 pra este generator não é assumido por este importador)."
                    ),
                );
            }
            (None, None) => {}
        }
    }
    out
}

/// UTC `YYYY-MM-DDTHH:MM:SSZ` a partir de segundos desde a época Unix, sem
/// depender de `chrono` (evita puxar mais uma dependência só pra isso).
/// Usa o algoritmo de calendário civil de Howard Hinnant (domínio público,
/// https://howardhinnant.github.io/date_algorithms.html) pra converter dias
/// desde a época em ano/mês/dia proléptico-gregoriano.
pub(crate) fn now_iso8601() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let days = (secs / 86400) as i64;
    let time_of_day = secs % 86400;
    let (hour, minute, second) = (time_of_day / 3600, (time_of_day % 3600) / 60, time_of_day % 60);

    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

// --------------------------------------------------------------------
// Decodificação de áudio — SEMPRE no backend Rust, nunca no WebView.
// --------------------------------------------------------------------

/// Extrai e decodifica o PCM de uma amostra pendente, devolvendo PCM
/// inteiro intercalado (mono, já que cada `PendingSample` é sempre um canal
/// SF2 — ver mapeamento `stereo: Left/Right/Mono` em `build_group`) pronto
/// pra entrar em `mrq::writer::add_sample`.
fn extract_pcm(file: &mut File, sf2: &SoundFont2, pending: &PendingSample) -> Result<(Vec<i32>, u16), ImportError> {
    if pending.is_vorbis {
        let smpl = sf2.sample_data.smpl.as_ref().ok_or_else(|| ImportError::SampleRangeOutOfBounds {
            sample_name: pending.header.name.clone(),
        })?;
        if pending.eff_end > u64::from(smpl.len) {
            return Err(ImportError::SampleRangeOutOfBounds { sample_name: pending.header.name.clone() });
        }
        let byte_offset = smpl.offset.checked_add(pending.eff_start).ok_or_else(|| ImportError::SampleRangeOutOfBounds {
            sample_name: pending.header.name.clone(),
        })?;
        let byte_len = (pending.eff_end - pending.eff_start) as usize;
        file.seek(SeekFrom::Start(byte_offset))?;
        let mut compressed = vec![0u8; byte_len];
        file.read_exact(&mut compressed)?;

        let mut ogg = lewton::inside_ogg::OggStreamReader::new(Cursor::new(compressed)).map_err(|e| ImportError::VorbisDecodeError {
            sample_name: pending.header.name.clone(),
            message: format!("{e:?}"),
        })?;

        let mut pcm: Vec<i16> = Vec::new();
        loop {
            match ogg.read_dec_packet() {
                Ok(Some(packets)) => {
                    if let Some(first_channel) = packets.first() {
                        pcm.extend_from_slice(first_channel);
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    return Err(ImportError::VorbisDecodeError { sample_name: pending.header.name.clone(), message: format!("{e:?}") });
                }
            }
        }
        if pcm.is_empty() {
            return Err(ImportError::VorbisDecodeError {
                sample_name: pending.header.name.clone(),
                message: "stream Vorbis decodificou zero frames".to_string(),
            });
        }
        Ok((pcm.into_iter().map(i32::from).collect(), 16))
    } else {
        let smpl = sf2.sample_data.smpl.as_ref().ok_or_else(|| ImportError::SampleRangeOutOfBounds {
            sample_name: pending.header.name.clone(),
        })?;
        let within_bounds = match pending.eff_end.checked_mul(2) {
            Some(end_byte) => end_byte <= u64::from(smpl.len),
            None => false,
        };
        if !within_bounds {
            return Err(ImportError::SampleRangeOutOfBounds { sample_name: pending.header.name.clone() });
        }
        let n_frames = pending.eff_end - pending.eff_start;
        let byte_offset = smpl
            .offset
            .checked_add(pending.eff_start.checked_mul(2).ok_or_else(|| ImportError::SampleRangeOutOfBounds {
                sample_name: pending.header.name.clone(),
            })?)
            .ok_or_else(|| ImportError::SampleRangeOutOfBounds { sample_name: pending.header.name.clone() })?;

        file.seek(SeekFrom::Start(byte_offset))?;
        let mut buf16 = vec![0u8; (n_frames * 2) as usize];
        file.read_exact(&mut buf16)?;
        let samples16: Vec<i16> = buf16.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect();

        let has_valid_sm24 = match (&sf2.sample_data.smpl, &sf2.sample_data.sm24) {
            (Some(smpl), Some(sm24)) => (smpl.len as u64).div_ceil(2) == sm24.len as u64,
            _ => false,
        };

        if has_valid_sm24 {
            let sm24 = sf2.sample_data.sm24.as_ref().expect("checado acima");
            let sm24_offset = sm24.offset.checked_add(pending.eff_start).ok_or_else(|| ImportError::SampleRangeOutOfBounds {
                sample_name: pending.header.name.clone(),
            })?;
            file.seek(SeekFrom::Start(sm24_offset))?;
            let mut lsb = vec![0u8; n_frames as usize];
            file.read_exact(&mut lsb)?;
            let samples24: Vec<i32> = samples16
                .iter()
                .zip(lsb.iter())
                .map(|(&hi, &lo)| (i32::from(hi) << 8) | i32::from(lo))
                .collect();
            Ok((samples24, 24))
        } else {
            Ok((samples16.into_iter().map(i32::from).collect(), 16))
        }
    }
}

/// Faz o parsing completo (reaproveitando `inspect`) e decodifica todo o
/// áudio necessário (PCM direto pro SF2 16/24-bit, Vorbis→PCM pro SF3),
/// gravando o `.mrq` final via o backend da Fase 2 (`mrq::writer`). Roda
/// inteiramente no processo Rust — nunca envia PCM bruto de volta pro
/// WebView antes de terminar.
pub fn convert_to_mrq(
    builder_state: &MrqBuilderState,
    source_path: &Path,
    dest_path: PathBuf,
) -> Result<(MrqFinishResult, MrqCompatibilityReport), ImportError> {
    let mut file = File::open(source_path)?;
    let sf2 = load_soundfont(&mut file)?;

    let inspection = inspect(source_path)?;
    let mut report = inspection.compatibility;

    let session_id = writer::begin(builder_state, dest_path, inspection.instrument)?;

    for pending in &inspection.pending_samples {
        let decode_result = extract_pcm(&mut file, &sf2, pending);
        let (interleaved, bits) = match decode_result {
            Ok(v) => v,
            Err(e) => {
                // Nunca falha silenciosamente nem interrompe o resto da
                // conversão por causa de UMA amostra — mas também nunca
                // finge sucesso: aborta a sessão inteira e devolve o erro
                // real, já que uma zona sem áudio geraria uma referência
                // pendurada (`finish()` da Fase 2 já rejeitaria mesmo
                // assim).
                let _ = writer::abort(builder_state, &session_id);
                return Err(e);
            }
        };

        writer::add_sample(
            builder_state,
            &session_id,
            pending.sample_id.clone(),
            MrqSampleSourceInput::IntegerPcm { bits_per_sample: bits, interleaved },
            pending.header.sample_rate,
            1,
        )?;
    }

    let result = writer::finish(builder_state, &session_id)?;
    report.add_preserved("Áudio", "todas as amostras recodificadas em FLAC lossless (PCM direto do SF2, ou Vorbis decodificado no caso do SF3) dentro do .mrq gerado.");
    Ok((result, report))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
    }

    /// Revisão técnica pós-Fase 10, item "ExclusiveGroup": confirma a regra
    /// exata usada em `exclusive_group` (linha ~370) com a MESMA lógica de
    /// extração usada em produção (`amt_u16` + `.filter(|&v| v != 0)`), sem
    /// precisar montar um `.sf2` binário sintético completo (os fixtures
    /// reais disponíveis — `sin.sf2`/`boomwhacker.sf3` — são tons de teste
    /// simples e não definem `ExclusiveClass`). Importante: a spec SF2 define
    /// `ExclusiveClass = 0` como "nenhum grupo" — não é um id de grupo válido
    /// — por isso o filtro `!= 0` existe; sem ele, toda zona sem grupo
    /// nenhum viraria falsamente `exclusiveGroup: Some(0)`.
    #[test]
    fn exclusive_class_zero_means_no_group_but_any_nonzero_value_is_preserved() {
        let mut map: HashMap<u16, GeneratorAmount> = HashMap::new();

        // Generator ausente (zona não define ExclusiveClass nenhum) -> None.
        assert_eq!(amt_u16(&map, GeneratorType::ExclusiveClass).filter(|&v| v != 0), None);

        // ExclusiveClass = 0 (valor "nenhum grupo" pela spec SF2) -> None, não Some(0).
        map.insert(GeneratorType::ExclusiveClass as u16, GeneratorAmount::U16(0));
        assert_eq!(amt_u16(&map, GeneratorType::ExclusiveClass).filter(|&v| v != 0), None);

        // Qualquer id de grupo real (>0) -> preservado como está.
        map.insert(GeneratorType::ExclusiveClass as u16, GeneratorAmount::U16(7));
        assert_eq!(amt_u16(&map, GeneratorType::ExclusiveClass).filter(|&v| v != 0), Some(7));

        // A crate `soundfont` também pode entregar o valor como I16 (amount
        // assinado) dependendo de como o gerador foi lido do arquivo —
        // `amt_u16` já trata os dois casos (ver linha ~119); confirma que
        // esse caminho também preserva o grupo corretamente.
        map.insert(GeneratorType::ExclusiveClass as u16, GeneratorAmount::I16(3));
        assert_eq!(amt_u16(&map, GeneratorType::ExclusiveClass).filter(|&v| v != 0), Some(3));
    }

    #[test]
    fn inspects_a_real_sf2_file_without_decoding_audio() {
        let inspection = inspect(&fixture("sin.sf2")).expect("sin.sf2 deveria ser um SF2 válido");
        assert_eq!(inspection.instrument.source_format, MrqSourceFormat::Sf2);
        assert!(!inspection.instrument.presets.is_empty(), "sin.sf2 deveria ter pelo menos 1 preset");
        let total_zones: usize = inspection
            .instrument
            .presets
            .iter()
            .flat_map(|p| &p.groups)
            .map(|g| g.zones.len())
            .sum();
        assert!(total_zones > 0, "sin.sf2 deveria ter pelo menos 1 zona com amostra");
        assert_eq!(inspection.pending_samples.len(), total_zones);
    }

    #[test]
    fn detects_sf3_vorbis_compressed_samples() {
        let inspection = inspect(&fixture("boomwhacker.sf3")).expect("boomwhacker.sf3 deveria ser um SF3 válido");
        assert_eq!(inspection.instrument.source_format, MrqSourceFormat::Sf3);
        assert!(
            inspection.pending_samples.iter().any(|s| s.is_vorbis),
            "boomwhacker.sf3 deveria ter pelo menos 1 amostra Vorbis"
        );
    }

    #[test]
    fn converts_a_real_sf2_file_to_mrq_and_reads_it_back_losslessly() {
        let state = MrqBuilderState::default();
        let dir = std::env::temp_dir().join(format!("mrq_sf2_import_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("sin.mrq");

        let (result, report) = convert_to_mrq(&state, &fixture("sin.sf2"), dest.clone()).expect("conversão deveria funcionar");
        assert_eq!(result.path, dest.to_string_lossy().to_string());
        assert!(result.sample_count > 0);
        assert!(!report.preserved.is_empty());

        let metadata = crate::mrq::reader::read_file_metadata(&dest).expect("deveria ler o .mrq de volta");
        assert_eq!(metadata.samples.len(), result.sample_count);

        let integrity = crate::mrq::reader::validate_integrity(&dest).expect("validate_integrity não deveria falhar estruturalmente");
        assert!(integrity.global_ok);
        assert!(integrity.per_sample.iter().all(|s| s.ok));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn converts_a_real_sf3_file_with_vorbis_samples_to_mrq() {
        let state = MrqBuilderState::default();
        let dir = std::env::temp_dir().join(format!("mrq_sf3_import_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("boomwhacker.mrq");

        let (result, _report) = convert_to_mrq(&state, &fixture("boomwhacker.sf3"), dest.clone()).expect("conversão de SF3 deveria funcionar");
        assert!(result.sample_count > 0);

        let integrity = crate::mrq::reader::validate_integrity(&dest).expect("validate_integrity não deveria falhar estruturalmente");
        assert!(integrity.global_ok);
        assert!(integrity.per_sample.iter().all(|s| s.ok));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_a_file_that_is_not_a_soundfont() {
        let dir = std::env::temp_dir().join(format!("mrq_sf2_garbage_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("not-a-soundfont.sf2");
        std::fs::write(&path, b"isto nao e um RIFF valido").unwrap();

        let result = inspect(&path);
        assert!(matches!(result, Err(ImportError::InvalidSoundFont { .. })));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A crate `soundfont` v0.1.0 valida boa parte da estrutura interna com
    /// `assert_eq!`/`unwrap()` em vez de devolver `Result` — um arquivo que
    /// passa pela checagem rápida de magic RIFF mas é truncado/corrompido
    /// logo em seguida pode disparar um panic *dentro da dependência*. Este
    /// teste garante que `load_soundfont` (via `catch_unwind`) sempre
    /// devolve um `Err` estruturado nesse caso, nunca derruba a thread.
    #[test]
    fn never_panics_on_a_riff_file_that_is_corrupted_past_the_magic_bytes() {
        let dir = std::env::temp_dir().join(format!("mrq_sf2_corrupt_riff_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("corrupt.sf2");
        // "RIFF" + tamanho (4 bytes) + "sfbk" (form type correto) + nada
        // mais — passa a checagem de magic, mas não tem nenhum chunk LIST
        // esperado pela crate em seguida.
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&4u32.to_le_bytes());
        bytes.extend_from_slice(b"sfbk");
        std::fs::write(&path, &bytes).unwrap();

        let result = inspect(&path);
        assert!(result.is_err(), "um RIFF/sfbk truncado deveria falhar de forma estruturada, nunca entrar em panic sem controle");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
