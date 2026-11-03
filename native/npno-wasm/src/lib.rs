//! Wrapper wasm fino sobre o crate `nord-format` (BSD-3-Clause, projeto comunitário
//! não afiliado à Clavia) para decodificar bibliotecas de piano Nord (`.npno`) dentro
//! do navegador/Electron. Usado pelo Rack de instrumentos do MRQ - Multitracks Play.
//!
//! Decodifica o arquivo inteiro de uma vez (como já fazemos com SoundFont/.sf2) e
//! devolve: (1) um JSON com metadados — nome, canais, taxa de amostragem, mapa de
//! teclas (nota MIDI -> nota raiz gravada) e, para cada "stroke" (uma nota gravada),
//! sua raiz/banco ("attack"/"resonance"/"release")/camada de velocidade/duração; e
//! (2) um único buffer contínuo com o PCM de 16 bits de todos os strokes, decodificado
//! pelo codec proprietário (preditor de diferenças finitas) do próprio `nord-format`.
//! O lado JS recorta esse buffer pelos offsets do JSON e monta os `AudioBuffer`s.
use nord_format::formats::npno::{codec, Bank, Piano};
use nord_format::formats::nsmp::codec as nsmp_codec;
use nord_format::{from_stream as nord_from_stream, Entity};
use serde::Serialize;
use std::io::Cursor;
use wasm_bindgen::prelude::*;

#[derive(Serialize)]
struct StrokeMeta {
    root: u8,
    bank: String,
    layer: u8,
    channels: u16,
    frames: u32,
    /// deslocamento, em bytes, dentro do buffer de PCM devolvido por `pcm()`
    offset: u32,
    /// comprimento, em bytes, do trecho de PCM deste stroke (frames * channels * 2)
    length: u32,
}

#[derive(Serialize)]
struct LibraryMeta {
    name: String,
    variant: String,
    channels: u16,
    /// taxa de amostragem fixa do codec de piano da Nord (confirmada em hardware)
    sample_rate: u32,
    /// nota raiz (0-127) que toca cada tecla MIDI (0-127); 255 = tecla não coberta
    key_map: Vec<u8>,
    strokes: Vec<StrokeMeta>,
    /// strokes cujo áudio não pôde ser decodificado (arquivo real, mas bloco corrompido
    /// ou em formato que o codec desta versão do nord-format ainda não cobre)
    skipped: usize,
}

#[wasm_bindgen]
pub struct DecodedNpno {
    metadata_json: String,
    pcm: Vec<u8>,
}

#[wasm_bindgen]
impl DecodedNpno {
    #[wasm_bindgen(getter)]
    pub fn metadata_json(&self) -> String {
        self.metadata_json.clone()
    }

    /// PCM de 16 bits (little-endian, nativo do wasm) de todos os strokes,
    /// concatenados na ordem em que aparecem em `metadata_json().strokes`.
    #[wasm_bindgen(getter)]
    pub fn pcm(&self) -> Vec<u8> {
        self.pcm.clone()
    }
}

fn bank_name(bank_code: u8) -> String {
    match Bank::from_code(bank_code) {
        Some(b) => b.name().to_string(),
        None => format!("unknown_{bank_code}"),
    }
}

/// Decodifica os bytes brutos de um arquivo `.npno` (biblioteca de piano Nord).
/// Lança uma exceção JS (string) se o arquivo não for um `.npno` válido.
#[wasm_bindgen]
pub fn npno_decode(bytes: &[u8]) -> Result<DecodedNpno, JsValue> {
    let mut cursor = Cursor::new(bytes);
    let piano = Piano::read_from(&mut cursor).map_err(|e| JsValue::from_str(&format!("{e}")))?;
    let library = piano
        .library()
        .map_err(|e| JsValue::from_str(&format!("{e}")))?;

    let (name, variant) = library.name();
    let channels = library.channels();
    let key_map = library.key_map().to_vec();

    let mut strokes_meta = Vec::new();
    let mut pcm: Vec<u8> = Vec::new();
    let mut skipped = 0usize;

    for stroke in library.strokes() {
        match codec::decode(stroke, channels) {
            Ok(audio) => {
                let interleaved = audio.interleaved();
                let offset = pcm.len() as u32;
                pcm.reserve(interleaved.len() * 2);
                for sample in &interleaved {
                    pcm.extend_from_slice(&sample.to_le_bytes());
                }
                let length = (pcm.len() as u32) - offset;
                strokes_meta.push(StrokeMeta {
                    root: stroke.root,
                    bank: bank_name(stroke.bank_code()),
                    layer: stroke.layer(),
                    channels,
                    frames: audio.frames() as u32,
                    offset,
                    length,
                });
            }
            Err(_) => {
                // Stroke real mas que este decodificador não reconstrói (bloco fora do
                // que o codec documentado cobre). Não interrompe o carregamento do
                // resto da biblioteca; só essa tecla/camada fica muda.
                skipped += 1;
            }
        }
    }

    let meta = LibraryMeta {
        name,
        variant,
        channels,
        sample_rate: codec::RATE,
        key_map,
        strokes: strokes_meta,
        skipped,
    };
    let metadata_json =
        serde_json::to_string(&meta).map_err(|e| JsValue::from_str(&format!("{e}")))?;

    Ok(DecodedNpno { metadata_json, pcm })
}

/// Só confere a assinatura/estrutura do contêiner, sem decodificar áudio — usado para
/// validar rapidamente um arquivo antes do usuário confirmar o carregamento de uma
/// biblioteca grande.
#[wasm_bindgen]
pub fn npno_sniff(bytes: &[u8]) -> Result<String, JsValue> {
    let mut cursor = Cursor::new(bytes);
    let piano = Piano::read_from(&mut cursor).map_err(|e| JsValue::from_str(&format!("{e}")))?;
    let library = piano
        .library()
        .map_err(|e| JsValue::from_str(&format!("{e}")))?;
    let (name, variant) = library.name();
    Ok(format!("{name}#{variant}"))
}

// ---------------------------------------------------------------------------
// .nsmp / .nsmp3 / .nsmp4 — Nord Sample Library (amostras, não piano)
//
// Usa o MESMO crate `nord-format` que já decodifica o `.npno` acima: o formato
// das três gerações de amostras compartilha a tag `nsmp` no contêiner CBIN, e
// o crate já expõe uma API pronta (`Entity::Sample`, `Sample::zones()`,
// `nsmp::codec::decode`) sem precisarmos escrever nenhum parser novo do zero.
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct NsmpZoneMeta {
    root_key: u8,
    top_note: u8,
    /// Nota mais grave da zona, quando a geração guarda isso (v3/v4). Nas
    /// gerações onde as zonas se encostam (só o topo é guardado), fica None —
    /// o lado JS deriva o grave a partir do topo da zona anterior.
    low_note: Option<u8>,
    channels: u16,
    frames: u32,
    /// deslocamento, em bytes, dentro do buffer de PCM devolvido por `pcm()`
    offset: u32,
    /// comprimento, em bytes, do trecho de PCM desta zona (frames * channels * 2)
    length: u32,
}

#[derive(Serialize)]
struct NsmpMeta {
    name: String,
    /// "nsmp" (Sample Library 2.0 e anteriores), "nsmp3" ou "nsmp4"
    generation: String,
    /// taxa de amostragem fixa do codec de amostras da Nord (35002 Hz, igual
    /// nas três gerações — ver nsmp::codec::FIELD_RATE)
    sample_rate: u32,
    zones: Vec<NsmpZoneMeta>,
    /// zonas cujo áudio não pôde ser decodificado (arquivo real, mas stroke
    /// corrompido ou em variante que este codec ainda não cobre)
    skipped: usize,
}

#[wasm_bindgen]
pub struct DecodedNsmp {
    metadata_json: String,
    pcm: Vec<u8>,
}

#[wasm_bindgen]
impl DecodedNsmp {
    #[wasm_bindgen(getter)]
    pub fn metadata_json(&self) -> String {
        self.metadata_json.clone()
    }

    /// PCM de 16 bits (little-endian, nativo do wasm) de todas as zonas,
    /// concatenadas na ordem em que aparecem em `metadata_json().zones`.
    #[wasm_bindgen(getter)]
    pub fn pcm(&self) -> Vec<u8> {
        self.pcm.clone()
    }
}

/// Decodifica os bytes brutos de um arquivo `.nsmp`/`.nsmp3`/`.nsmp4` (amostra
/// Nord Sample Library). Lança uma exceção JS (string) se o arquivo não for
/// uma amostra Nord válida.
#[wasm_bindgen]
pub fn nsmp_decode(bytes: &[u8]) -> Result<DecodedNsmp, JsValue> {
    let mut cursor = Cursor::new(bytes);
    let entity =
        nord_from_stream(&mut cursor).map_err(|e| JsValue::from_str(&format!("{e}")))?;
    let sample = match entity {
        Entity::Sample(s) => s,
        _ => {
            return Err(JsValue::from_str(
                "o arquivo não é uma amostra Nord (.nsmp/.nsmp3/.nsmp4) válida",
            ))
        }
    };

    let name = sample.name().unwrap_or_default();
    let generation = sample.generation().to_string();
    let layout = sample
        .layout()
        .map_err(|e| JsValue::from_str(&format!("{e}")))?;
    let zones = sample
        .zones()
        .map_err(|e| JsValue::from_str(&format!("{e}")))?;

    let mut zones_meta = Vec::new();
    let mut pcm: Vec<u8> = Vec::new();
    let mut skipped = 0usize;

    for zone in &zones {
        match nsmp_codec::decode(zone.stream, zone.at, layout) {
            Ok(audio) => {
                let offset = pcm.len() as u32;
                pcm.reserve(audio.samples.len() * 2);
                for sample in &audio.samples {
                    pcm.extend_from_slice(&sample.to_le_bytes());
                }
                let length = (pcm.len() as u32) - offset;
                zones_meta.push(NsmpZoneMeta {
                    root_key: zone.root_key,
                    top_note: zone.top_note,
                    low_note: zone.low_note,
                    channels: audio.channels,
                    frames: audio.frames() as u32,
                    offset,
                    length,
                });
            }
            Err(_) => {
                // Zona real mas que este decodificador não reconstrói (bloco fora do
                // que o codec documentado cobre). Não interrompe o carregamento do
                // resto da amostra; só essa zona fica muda.
                skipped += 1;
            }
        }
    }

    let meta = NsmpMeta {
        name,
        generation,
        sample_rate: nsmp_codec::FIELD_RATE,
        zones: zones_meta,
        skipped,
    };
    let metadata_json =
        serde_json::to_string(&meta).map_err(|e| JsValue::from_str(&format!("{e}")))?;

    Ok(DecodedNsmp { metadata_json, pcm })
}

/// Só confere a assinatura/estrutura do contêiner, sem decodificar áudio —
/// mesma ideia de `npno_sniff`, mas para amostras `.nsmp`/`.nsmp3`/`.nsmp4`.
#[wasm_bindgen]
pub fn nsmp_sniff(bytes: &[u8]) -> Result<String, JsValue> {
    let mut cursor = Cursor::new(bytes);
    let entity =
        nord_from_stream(&mut cursor).map_err(|e| JsValue::from_str(&format!("{e}")))?;
    match entity {
        Entity::Sample(s) => {
            let name = s.name().unwrap_or_default();
            Ok(format!("{name}#{}", s.generation()))
        }
        _ => Err(JsValue::from_str(
            "o arquivo não é uma amostra Nord (.nsmp/.nsmp3/.nsmp4) válida",
        )),
    }
}
