//! "MRQ Instrument Model" — representação intermediária comum pra todos os
//! importadores (SF2/SF3/SFZ/NPNO/SYX/NKI/áudio avulso) que vão alimentar o
//! conversor nas próximas fases. Fase 2 só define a estrutura e o contêiner
//! que a guarda — nenhum importador real ainda escreve isto.
//!
//! Regra importante (pedida explicitamente): nenhum campo aqui é inventado.
//! Tudo que um formato de origem não tiver como prover fica `None`/ausente
//! no JSON — nunca um valor padrão "chutado" silenciosamente. Quem gerar um
//! `MrqInstrumentModel` a partir de um formato real é responsável por isso;
//! esta struct só define "o que é possível preservar", não força nada.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MrqEnvelope {
    /// segundos
    pub attack: f64,
    /// segundos, opcional (nem todo formato distingue hold de attack/decay)
    pub hold: Option<f64>,
    /// segundos
    pub decay: f64,
    /// 0..1
    pub sustain: f64,
    /// segundos
    pub release: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum MrqFilterType {
    #[serde(rename = "lowpass")]
    LowPass,
    #[serde(rename = "highpass")]
    HighPass,
    #[serde(rename = "bandpass")]
    BandPass,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MrqFilter {
    pub filter_type: MrqFilterType,
    pub cutoff_hz: f64,
    /// fator de ressonância/Q
    pub resonance: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "source")]
pub enum MrqModulationSource {
    #[serde(rename = "lfo")]
    Lfo,
    #[serde(rename = "envelope2")]
    Envelope2,
    #[serde(rename = "velocity")]
    Velocity,
    #[serde(rename = "aftertouch")]
    Aftertouch,
    #[serde(rename = "modwheel")]
    ModWheel,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MrqModulationDestination {
    #[serde(rename = "pitch")]
    Pitch,
    #[serde(rename = "cutoff")]
    Cutoff,
    #[serde(rename = "volume")]
    Volume,
    #[serde(rename = "pan")]
    Pan,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MrqModulation {
    pub source: MrqModulationSource,
    pub destination: MrqModulationDestination,
    pub amount: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MrqStereoMode {
    Mono,
    Stereo,
    Left,
    Right,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MrqZone {
    /// Referencia o `id` de uma amostra adicionada via `mrq_builder_add_sample`
    /// na mesma sessão. Validado em `finish()` — toda referência "pendurada"
    /// (sem amostra correspondente) é rejeitada, nunca ignorada em silêncio.
    pub sample_id: String,
    pub root_note: u8,
    pub lo_key: u8,
    pub hi_key: u8,
    pub lo_vel: u8,
    pub hi_vel: u8,
    /// Zonas com o mesmo valor alternam em round robin entre si.
    pub round_robin_group: Option<String>,
    pub round_robin_index: Option<u32>,
    pub tune_cents: f64,
    pub volume_db: f64,
    /// -1.0 (esquerda) .. 1.0 (direita)
    pub pan: f64,
    pub stereo: Option<MrqStereoMode>,
    pub loop_enabled: Option<bool>,
    pub loop_start: Option<u64>,
    pub loop_end: Option<u64>,
    /// Sobrescreve o envelope do grupo, se houver.
    pub envelope: Option<MrqEnvelope>,
    pub filter: Option<MrqFilter>,
    /// Grupo de exclusividade/"choke" (ex.: generator `ExclusiveClass` do
    /// SF2/SF3 — notas com o mesmo valor se cortam mutuamente, como os
    /// pratos aberto/fechado de uma bateria). Guardado como DADO desde já
    /// (campo aditivo, acrescentado na Fase 3 por pedido explícito), mas
    /// nenhum motor de reprodução MRQ aplica esse comportamento ainda —
    /// por isso ele entra como "Approximated" (preservado, efeito sonoro
    /// ainda não reproduzido) no relatório de compatibilidade de quem o
    /// gerar, nunca como "Preserved" pleno.
    pub exclusive_group: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MrqGroup {
    pub id: String,
    pub name: String,
    pub zones: Vec<MrqZone>,
    /// ADSR padrão do grupo; uma zona pode sobrescrever via `MrqZone::envelope`.
    pub envelope: Option<MrqEnvelope>,
    pub filter: Option<MrqFilter>,
    pub modulation: Option<Vec<MrqModulation>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MrqPreset {
    pub id: String,
    pub name: String,
    pub groups: Vec<MrqGroup>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MrqMidiConfig {
    pub pitch_bend_range_semitones: Option<f64>,
    pub default_channel: Option<u8>,
    pub transpose_semitones: Option<i32>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MrqSourceFormat {
    Sf2,
    Sf3,
    Sfz,
    Npno,
    Nsmp,
    SyxDx7,
    Nki,
    /// Logic Pro EXS24 (`.exs`) — ver `exsImport.ts`/`ExsFile.ts` no frontend.
    /// Ao contrário do Kontakt, a Apple nunca criptografou este formato.
    Exs,
    Wav,
    Aiff,
    Flac,
    Mp3,
    Ogg,
    /// Instrumento montado manualmente pelo fluxo "Kontakt Audio Capture"
    /// (ver `kontakt_capture.rs`) a partir de vários arquivos de áudio
    /// avulso (tipicamente WAV renderizados pelo Kontakt) — distinto de
    /// `Wav` (que é UM arquivo de áudio avulso importado sozinho) porque
    /// aqui o instrumento tem mapeamento de teclado/velocidade/grupos
    /// definido pelo usuário, não uma única zona cobrindo o teclado
    /// inteiro.
    KontaktCapture,
}

/// O "instrumento" propriamente dito — tudo que os importadores das
/// próximas fases vão popular. Não inclui nenhum áudio decodificado (isso
/// entra via `mrq_builder_add_sample`, referenciado pelas zonas acima por
/// `sample_id`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MrqInstrumentModel {
    pub name: String,
    pub source_format: MrqSourceFormat,
    pub imported_at: String,
    pub presets: Vec<MrqPreset>,
    pub midi: Option<MrqMidiConfig>,
}

/// Uma entrada do índice de amostras gravado dentro do `.mrq`. `relative_offset`
/// é relativo ao INÍCIO do bloco de amostras (ou seja, ao byte `16 + metadata_len`
/// do arquivo) — ver `format.rs`. Isso evita problema de "ovo e galinha" entre
/// o tamanho do JSON de metadados e os offsets que ele mesmo contém.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MrqSampleIndexEntry {
    pub id: String,
    pub relative_offset: u64,
    pub length: u64,
    /// SHA-256 do bloco FLAC exatamente como gravado (64 chars hex minúsculo).
    pub sha256: String,
    pub sample_rate_hz: u32,
    pub channels: u16,
    /// Profundidade de bits da fonte ORIGINAL, quando conhecida (ex.: 16 pra
    /// um .wav de 16 bits). `None` quando a fonte não tem essa noção (ex.:
    /// PCM float do Web Audio) — ver `converted_from_float32`.
    pub bits_per_sample_original: Option<u16>,
    /// Profundidade de bits efetivamente usada na codificação FLAC deste bloco.
    pub bits_per_sample_encoded: u16,
    /// `true` quando a amostra chegou como Float32 (ex.: AudioBuffer do Web
    /// Audio) e precisou ser convertida pra PCM inteiro antes da codificação
    /// FLAC (FLAC é um formato de PCM inteiro). Ver `writer.rs` pro ponto
    /// exato da conversão.
    pub converted_from_float32: bool,
    pub codec: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MrqFileMetadata {
    pub format_version: u32,
    pub instrument: MrqInstrumentModel,
    pub samples: Vec<MrqSampleIndexEntry>,
}

/// Entrada de áudio recebida do frontend pra virar uma amostra FLAC dentro
/// do `.mrq`. Duas formas: PCM inteiro na profundidade original (preferível
/// — nenhuma conversão com perda de precisão) ou Float32 normalizado
/// (-1.0..1.0, como todo `AudioBuffer` do Web Audio já entrega) — nesse caso
/// o writer converte pra inteiro antes de codificar, e marca
/// `converted_from_float32 = true` no índice.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum MrqSampleSourceInput {
    #[serde(rename = "integerPcm")]
    IntegerPcm {
        bits_per_sample: u16,
        /// amostras intercaladas (ex.: [L0,R0,L1,R1,...] se channels=2)
        interleaved: Vec<i32>,
    },
    #[serde(rename = "float32")]
    Float32 {
        /// amostras intercaladas, -1.0..1.0
        interleaved: Vec<f32>,
        /// profundidade de bits a usar na codificação FLAC (padrão: 24, ver
        /// "perfil padrão 24-bit/48kHz" da especificação). Não reduz a
        /// qualidade de uma fonte que já era menor — só define o teto de
        /// conversão quando a fonte é float (que não tem uma noção própria
        /// de bit depth).
        target_bits_per_sample: Option<u16>,
    },
}

/// Resultado de `mrq_builder_finish`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MrqFinishResult {
    pub path: String,
    pub sample_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MrqSampleIntegrity {
    pub sample_id: String,
    pub ok: bool,
}

/// Resultado de `mrq_validate_integrity`. Só vira `Err` (ver `MrqError`) em
/// caso de problema ESTRUTURAL (cabeçalho/versão/limites/JSON); um hash que
/// não confere é reportado aqui como dado (`ok: false`), não como erro —
/// o arquivo continua estruturalmente legível mesmo com uma amostra
/// corrompida.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MrqIntegrityReport {
    pub global_ok: bool,
    pub per_sample: Vec<MrqSampleIntegrity>,
}

/// Um item do relatório de compatibilidade (seção 7.1/Compatibility do
/// documento de arquitetura): todo importador real (a partir da Fase 3)
/// preenche um `MrqCompatibilityReport`, nunca inventando dado nenhum —
/// cada campo do formato de origem cai em exatamente uma das 3 categorias.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MrqCompatibilityItem {
    /// Nome curto do campo/recurso (ex.: "InitialFilterQ", "ExclusiveClass").
    pub field: String,
    /// Explicação legível do porquê caiu nessa categoria.
    pub detail: String,
}

/// Preserved = preservado integralmente; Approximated = convertido com
/// alguma aproximação/arredondamento documentado, ou dado preservado mas
/// ainda sem efeito sonoro no motor MRQ; Unsupported = não tem campo
/// equivalente no `MrqInstrumentModel` hoje, não foi gravado em lugar
/// nenhum.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MrqCompatibilityReport {
    pub preserved: Vec<MrqCompatibilityItem>,
    pub approximated: Vec<MrqCompatibilityItem>,
    pub unsupported: Vec<MrqCompatibilityItem>,
}

impl MrqCompatibilityReport {
    pub fn add_preserved(&mut self, field: impl Into<String>, detail: impl Into<String>) {
        self.preserved.push(MrqCompatibilityItem { field: field.into(), detail: detail.into() });
    }
    pub fn add_approximated(&mut self, field: impl Into<String>, detail: impl Into<String>) {
        self.approximated.push(MrqCompatibilityItem { field: field.into(), detail: detail.into() });
    }
    pub fn add_unsupported(&mut self, field: impl Into<String>, detail: impl Into<String>) {
        self.unsupported.push(MrqCompatibilityItem { field: field.into(), detail: detail.into() });
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MrqDecodedSample {
    pub sample_id: String,
    /// PCM Float32 intercalado, -1.0..1.0 — pronto pra virar um `AudioBuffer`
    /// direto no frontend, igual o `.mrqi` já faz hoje (ver `mrqiFormat.ts`).
    pub interleaved: Vec<f32>,
    pub sample_rate_hz: u32,
    pub channels: u16,
    pub bits_per_sample_encoded: u16,
}
