//! Comandos Tauri expostos ao frontend. Finos de propósito — toda a lógica
//! real mora em `writer.rs`/`reader.rs`; aqui só se converte `String` em
//! `PathBuf` e se encaminha pro `State` gerenciado. Todos devolvem
//! `MrqError` (estruturado, com `kind`) no caminho de erro — nunca uma
//! `String` solta.

use tauri::State;

use super::errors::MrqError;
use super::model::{
    MrqDecodedSample, MrqFileMetadata, MrqFinishResult, MrqInstrumentModel, MrqIntegrityReport,
    MrqSampleIndexEntry, MrqSampleSourceInput,
};
use super::reader;
use super::writer::{self, MrqBuilderState};

/// Abre uma sessão de conversão e devolve o id dela. `final_path` é onde o
/// `.mrq` vai ser gravado quando `mrq_builder_finish` for chamado — nada é
/// criado nesse caminho ainda neste passo.
#[tauri::command]
pub fn mrq_builder_begin(
    state: State<'_, MrqBuilderState>,
    final_path: String,
    instrument: MrqInstrumentModel,
) -> Result<String, MrqError> {
    writer::begin(&state, std::path::PathBuf::from(final_path), instrument)
}

/// Codifica uma amostra (PCM inteiro ou Float32) em FLAC e anexa à sessão.
/// Devolve a entrada de índice resultante (útil pro frontend mostrar
/// progresso/tamanho em tempo real).
#[tauri::command]
pub fn mrq_builder_add_sample(
    state: State<'_, MrqBuilderState>,
    session_id: String,
    sample_id: String,
    source: MrqSampleSourceInput,
    sample_rate_hz: u32,
    channels: u16,
) -> Result<MrqSampleIndexEntry, MrqError> {
    writer::add_sample(&state, &session_id, sample_id, source, sample_rate_hz, channels)
}

/// Monta o arquivo final, autovalida, e só então grava no caminho de
/// destino (escrita segura via arquivo temporário + rename atômico).
#[tauri::command]
pub fn mrq_builder_finish(state: State<'_, MrqBuilderState>, session_id: String) -> Result<MrqFinishResult, MrqError> {
    writer::finish(&state, &session_id)
}

/// Cancela uma conversão em andamento e limpa o blob temporário de
/// amostras — nada é escrito no destino final.
#[tauri::command]
pub fn mrq_builder_abort(state: State<'_, MrqBuilderState>, session_id: String) -> Result<(), MrqError> {
    writer::abort(&state, &session_id)
}

/// Lê só os metadados (instrumento + índice de amostras) de um `.mrq` já
/// existente — não toca em nenhum byte de áudio.
#[tauri::command]
pub fn mrq_read_metadata(path: String) -> Result<MrqFileMetadata, MrqError> {
    reader::read_file_metadata(&std::path::PathBuf::from(path))
}

#[tauri::command]
pub fn mrq_read_sample_index(path: String) -> Result<Vec<MrqSampleIndexEntry>, MrqError> {
    reader::read_sample_index(&std::path::PathBuf::from(path))
}

/// Extrai e decodifica uma única amostra pelo id — acesso aleatório de
/// verdade, sem tocar nas demais amostras do arquivo.
#[tauri::command]
pub fn mrq_extract_sample(path: String, sample_id: String) -> Result<MrqDecodedSample, MrqError> {
    reader::extract_sample(&std::path::PathBuf::from(path), &sample_id)
}

/// Confere a integridade completa do arquivo (hash por amostra + hash
/// global). Não falha por hash incorreto — isso vira dado no relatório.
#[tauri::command]
pub fn mrq_validate_integrity(path: String) -> Result<MrqIntegrityReport, MrqError> {
    reader::validate_integrity(&std::path::PathBuf::from(path))
}
