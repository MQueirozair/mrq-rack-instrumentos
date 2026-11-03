//! Formato `.mrq` ("MRQ Instrument") — Fase 2 do MRQ Instrument Converter.
//! Ver `docs/mrq-converter-architecture.md` pro desenho completo.
//!
//! Módulo totalmente separado do `.mrqi` existente (`mrqiFormat.ts` /
//! `mrqiExport.ts` / `MrqiLayerVoice.ts`, no lado TypeScript) — nenhum dos
//! dois depende do outro, e o `.mrqi` continua funcionando exatamente como
//! antes.

pub mod commands;
pub mod errors;
pub mod format;
pub mod model;
pub mod reader;
pub mod writer;
