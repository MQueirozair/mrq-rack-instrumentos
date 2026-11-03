//! Erros estruturados dos importadores (Fase 3+ do MRQ Instrument
//! Converter). Mesmo estilo de `crate::mrq::errors::MrqError`: nunca uma
//! `String` solta pro frontend, sempre um `kind` discriminando o caso.

use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "kind")]
pub enum ImportError {
    #[serde(rename = "io")]
    Io { message: String },

    /// O arquivo não é um RIFF/SoundFont válido, ou viola a estrutura
    /// esperada pelo parser (`soundfont` crate) de alguma forma que o
    /// impede de ser lido.
    #[serde(rename = "invalidSoundFont")]
    InvalidSoundFont { message: String },

    /// O arquivo não é um contêiner Nord (CBIN) válido, não é uma biblioteca
    /// de piano (`.npno`) nem uma amostra (`.nsmp`/`.nsmp3`/`.nsmp4`), ou é
    /// um tipo de arquivo Nord reconhecido mas fora do escopo deste
    /// importador (ex.: um programa/song/sysex).
    #[serde(rename = "invalidNordFile")]
    InvalidNordFile { message: String },

    /// Falha ao decodificar o fluxo Ogg/Vorbis de uma amostra comprimida
    /// (`.sf3`).
    #[serde(rename = "vorbisDecodeError")]
    VorbisDecodeError { sample_name: String, message: String },

    /// Faixa de amostra (start/end, já com os offsets de endereço do
    /// generator aplicados) inválida ou fora dos limites do arquivo —
    /// nunca lida mesmo assim.
    #[serde(rename = "sampleRangeOutOfBounds")]
    SampleRangeOutOfBounds { sample_name: String },

    /// O arquivo não é um WAV/AIFF/FLAC/MP3/OGG válido (ou de um tipo/
    /// extensão fora do escopo deste importador), ou o `symphonia` não
    /// conseguiu decodificar nenhum quadro de áudio dele.
    #[serde(rename = "invalidAudioFile")]
    InvalidAudioFile { message: String },

    /// Encaminha um erro vindo do backend `.mrq` (Fase 2) — ex.: durante a
    /// chamada a `mrq::writer::{begin,add_sample,finish}`.
    #[serde(rename = "mrqError")]
    MrqError { inner: crate::mrq::errors::MrqError },
}

impl std::fmt::Display for ImportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ImportError::Io { message } => write!(f, "erro de E/S: {message}"),
            ImportError::InvalidSoundFont { message } => write!(f, "SoundFont inválido: {message}"),
            ImportError::InvalidNordFile { message } => write!(f, "arquivo Nord inválido ou fora do escopo: {message}"),
            ImportError::VorbisDecodeError { sample_name, message } => {
                write!(f, "falha ao decodificar a amostra Vorbis '{sample_name}': {message}")
            }
            ImportError::SampleRangeOutOfBounds { sample_name } => {
                write!(f, "faixa de amostra inválida/fora dos limites para '{sample_name}'")
            }
            ImportError::InvalidAudioFile { message } => write!(f, "arquivo de áudio inválido ou fora do escopo: {message}"),
            ImportError::MrqError { inner } => write!(f, "{inner}"),
        }
    }
}

impl std::error::Error for ImportError {}

impl From<std::io::Error> for ImportError {
    fn from(e: std::io::Error) -> Self {
        ImportError::Io { message: e.to_string() }
    }
}

impl From<crate::mrq::errors::MrqError> for ImportError {
    fn from(e: crate::mrq::errors::MrqError) -> Self {
        ImportError::MrqError { inner: e }
    }
}
