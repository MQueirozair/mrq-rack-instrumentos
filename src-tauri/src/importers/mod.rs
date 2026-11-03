//! Importadores de formatos de terceiros (SF2/SF3 na Fase 3; SFZ/NPNO/SYX/
//! NKI/áudio avulso em fases futuras) → `MrqInstrumentModel`.
//!
//! Regra de arquitetura (pedida explicitamente): este módulo depende só de
//! `crate::mrq::model`/`crate::mrq::writer` — NUNCA de código de UI/Tauri
//! além dos finos `#[tauri::command]` em `commands.rs`. Isso é o que
//! permite, no futuro, extrair toda a lógica de conversão pra um app
//! "MRQ Instrument Converter" standalone sem reescrever nada além da casca
//! de interface.

pub mod audio_file;
pub mod commands;
pub mod errors;
pub mod kontakt_capture;
pub mod npno;
pub mod sf2;
