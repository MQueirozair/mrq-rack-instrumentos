//! Comandos Tauri do importador SF2/SF3 (Fase 3). Finos de propósito, igual
//! ao padrão de `crate::mrq::commands`: toda a lógica real mora em
//! `sf2.rs`; aqui só se converte `String` em `PathBuf`, se encaminha pro
//! `State` gerenciado, e se agrega o resultado + relatório de
//! compatibilidade numa resposta serializável. Erro sempre estruturado
//! (`ImportError`, com `kind`) — nunca uma `String` solta.

use std::path::PathBuf;

use serde::Serialize;
use tauri::State;

use crate::mrq::model::{MrqCompatibilityReport, MrqFinishResult, MrqInstrumentModel, MrqSampleIndexEntry};
use crate::mrq::writer::MrqBuilderState;

use super::audio_file;
use super::errors::ImportError;
use super::kontakt_capture;
use super::npno;
use super::sf2;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sf2InspectionResult {
    pub instrument: MrqInstrumentModel,
    pub compatibility: MrqCompatibilityReport,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sf2ConversionResult {
    pub finish: MrqFinishResult,
    pub compatibility: MrqCompatibilityReport,
}

/// Faz só o parsing estrutural do SF2/SF3 (presets/grupos/zonas/generators
/// → `MrqInstrumentModel`) e devolve junto o relatório de compatibilidade
/// — sem decodificar nenhum áudio. Pensado pra alimentar uma futura tela de
/// inspeção/preview antes do usuário confirmar a conversão completa.
#[tauri::command]
pub fn mrq_inspect_sf2(path: String) -> Result<Sf2InspectionResult, ImportError> {
    let inspection = sf2::inspect(&PathBuf::from(path))?;
    Ok(Sf2InspectionResult { instrument: inspection.instrument, compatibility: inspection.compatibility })
}

/// Converte um arquivo SF2/SF3 inteiro (estrutura + áudio) pra um `.mrq`
/// gravado em `dest_path`, reaproveitando o backend `.mrq` da Fase 2
/// (`mrq_builder_begin`/`add_sample`/`finish`, chamados internamente em
/// sequência — o frontend não precisa orquestrar essas etapas pra
/// importações SF2/SF3). Roda inteiramente no processo Rust.
#[tauri::command]
pub fn mrq_convert_sf2_to_mrq(
    state: State<'_, MrqBuilderState>,
    source_path: String,
    dest_path: String,
) -> Result<Sf2ConversionResult, ImportError> {
    let (finish, compatibility) = sf2::convert_to_mrq(&state, &PathBuf::from(source_path), PathBuf::from(dest_path))?;
    Ok(Sf2ConversionResult { finish, compatibility })
}

/// Fase 4 — importador NPNO/NSMP (biblioteca de piano / amostra Nord). Um
/// único comando cobre os dois formatos: `npno::inspect` faz o "sniff" do
/// contêiner e despacha internamente conforme o tipo real do arquivo.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NpnoInspectionResult {
    pub instrument: MrqInstrumentModel,
    pub compatibility: MrqCompatibilityReport,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NpnoConversionResult {
    pub finish: MrqFinishResult,
    pub compatibility: MrqCompatibilityReport,
}

/// Só faz o parsing estrutural (sem decodificar o áudio pesado do `.npno`;
/// ver nota em `npno.rs` sobre a exceção do `.nsmp`) — pensado pra alimentar
/// uma futura tela de inspeção/preview antes do usuário confirmar a
/// conversão completa.
#[tauri::command]
pub fn mrq_inspect_npno(path: String) -> Result<NpnoInspectionResult, ImportError> {
    let inspection = npno::inspect(&PathBuf::from(path))?;
    Ok(NpnoInspectionResult { instrument: inspection.instrument, compatibility: inspection.compatibility })
}

/// Converte um arquivo `.npno`/`.nsmp`/`.nsmp3`/`.nsmp4` inteiro (estrutura +
/// áudio) pra um `.mrq` gravado em `dest_path`, reaproveitando o backend
/// `.mrq` da Fase 2. Roda inteiramente no processo Rust.
#[tauri::command]
pub fn mrq_convert_npno_to_mrq(
    state: State<'_, MrqBuilderState>,
    source_path: String,
    dest_path: String,
) -> Result<NpnoConversionResult, ImportError> {
    let (finish, compatibility) = npno::convert_to_mrq(&state, &PathBuf::from(source_path), PathBuf::from(dest_path))?;
    Ok(NpnoConversionResult { finish, compatibility })
}

/// Fase 7 — importador de arquivo de áudio avulso (WAV/AIFF/FLAC/MP3/OGG,
/// via `symphonia`). Um único comando cobre os 5 formatos: `audio_file::inspect`
/// despacha internamente conforme a extensão do arquivo.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioFileInspectionResult {
    pub instrument: MrqInstrumentModel,
    pub compatibility: MrqCompatibilityReport,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioFileConversionResult {
    pub finish: MrqFinishResult,
    pub compatibility: MrqCompatibilityReport,
}

/// Faz o parsing + decodificação completa do áudio (não tem como separar
/// "estrutura" de "áudio" num arquivo que É só áudio — ver nota em
/// `audio_file.rs`) e devolve junto o relatório de compatibilidade.
#[tauri::command]
pub fn mrq_inspect_audio_file(path: String) -> Result<AudioFileInspectionResult, ImportError> {
    let inspection = audio_file::inspect(&PathBuf::from(path))?;
    Ok(AudioFileInspectionResult { instrument: inspection.instrument, compatibility: inspection.compatibility })
}

/// Converte um arquivo `.wav`/`.aiff`/`.flac`/`.mp3`/`.ogg` inteiro pra um
/// `.mrq` gravado em `dest_path`, reaproveitando o backend `.mrq` da
/// Fase 2. Roda inteiramente no processo Rust.
#[tauri::command]
pub fn mrq_convert_audio_file_to_mrq(
    state: State<'_, MrqBuilderState>,
    source_path: String,
    dest_path: String,
) -> Result<AudioFileConversionResult, ImportError> {
    let (finish, compatibility) = audio_file::convert_to_mrq(&state, &PathBuf::from(source_path), PathBuf::from(dest_path))?;
    Ok(AudioFileConversionResult { finish, compatibility })
}

/// "Kontakt Audio Capture" (fluxo opcional — ver `kontakt_capture.rs`) —
/// monta UM instrumento MRQ a partir de VÁRIOS arquivos de áudio avulso
/// (tipicamente WAV renderizados manualmente a partir de um instrumento
/// Kontakt que não pode ser importado diretamente). Diferente dos outros
/// importadores deste arquivo (um comando "inspect" + um comando
/// "convert" inteiro), aqui o frontend orquestra a sessão (mesmo padrão já
/// exposto desde a Fase 2 por `mrq::commands::mrq_builder_{begin,finish}`):
/// este comando só sonda UM arquivo por vez, pra alimentar a grade de
/// mapeamento visual antes do usuário confirmar nada.
#[tauri::command]
pub fn mrq_capture_probe_audio_file(path: String) -> Result<kontakt_capture::CaptureFileProbe, ImportError> {
    kontakt_capture::probe(&PathBuf::from(path))
}

/// Decodifica e adiciona UMA amostra a uma sessão `.mrq` já aberta via
/// `mrq_builder_begin` — chamado uma vez por arquivo WAV selecionado pelo
/// usuário na tela de captura, depois que ele confirma o mapeamento
/// (nota/key range/velocity range/grupo). Quem abre (`mrq_builder_begin`)
/// e fecha (`mrq_builder_finish`/`mrq_builder_abort`) a sessão é o
/// frontend — este comando só cobre o passo "decodificar + anexar".
#[tauri::command]
pub fn mrq_capture_add_sample(
    state: State<'_, MrqBuilderState>,
    session_id: String,
    sample_id: String,
    path: String,
) -> Result<MrqSampleIndexEntry, ImportError> {
    kontakt_capture::add_sample_to_session(&state, &session_id, sample_id, &PathBuf::from(path))
}
