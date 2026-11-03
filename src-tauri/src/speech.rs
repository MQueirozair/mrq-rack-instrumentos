//! Reconhecimento de partes por voz (opcional, desligado por padrão).
//!
//! Muitas multitracks/VS gospel brasileiras trazem na FAIXA GUIA uma locução
//! falada anunciando o nome de cada parte antes dela começar (ex.: a voz diz
//! "Estrofe", conta um compasso, e só então a estrofe começa de verdade —
//! convenção documentada por casas como "Mais Que Adoradores"). Esse módulo
//! roda a faixa guia por um reconhecimento de voz local (whisper.cpp, via a
//! crate `whisper-rs`, sem nenhum áudio saindo do computador do usuário) e
//! usa a transcrição pra achar os pontos exatos e o TIPO de cada parte, em
//! vez de adivinhar só pela forma da onda (ver `src/audio/PartRecognition.ts`
//! pro método heurístico, usado como fallback quando a faixa não tem
//! locução ou o modelo de voz ainda não foi baixado).
//!
//! O modelo (ggml, formato do whisper.cpp) NÃO vem embutido no instalador —
//! é grande demais (~148MB) pra todo usuário baixar à toa, já que essa
//! função é opcional. É baixado sob demanda, uma vez, na primeira vez que o
//! usuário liga a opção em Configurações, e fica salvo em
//! `app_data_dir()/models/ggml-base.bin`.

use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

const MODEL_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";
const MODEL_FILENAME: &str = "ggml-base.bin";

fn model_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("models");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn model_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(model_dir(app)?.join(MODEL_FILENAME))
}

#[tauri::command]
pub fn speech_model_ready(app: AppHandle) -> Result<bool, String> {
    Ok(model_path(&app)?.exists())
}

#[derive(Clone, Serialize)]
struct DownloadProgress {
    received: u64,
    total: u64,
}

/// Baixa o modelo de voz (~148MB) pra `app_data_dir()/models/`. Emite
/// `speech:download-progress` ({received, total} em bytes) conforme baixa,
/// pro front-end mostrar uma barra de progresso — é um download grande e
/// silencioso demais pra deixar sem feedback nenhum.
#[tauri::command]
pub async fn speech_download_model(app: AppHandle) -> Result<(), String> {
    let dest = model_path(&app)?;
    if dest.exists() {
        return Ok(());
    }
    let tmp = dest.with_extension("part");

    let resp = reqwest::get(MODEL_URL).await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("download falhou: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut received: u64 = 0;

    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::File::create(&tmp).await.map_err(|e| e.to_string())?;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        received += chunk.len() as u64;
        let _ = app.emit(
            "speech:download-progress",
            DownloadProgress { received, total },
        );
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    tokio::fs::rename(&tmp, &dest)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn speech_delete_model(app: AppHandle) -> Result<(), String> {
    let dest = model_path(&app)?;
    if dest.exists() {
        std::fs::remove_file(&dest).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Clone, Serialize)]
pub struct TranscriptSegment {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

/// Decodifica um WAV PCM16 mono 16kHz "cru" recebido direto da memória (sem
/// nenhum arquivo temporário no disco — os bytes vêm pelo IPC do Tauri como
/// argumento normal do comando). Não usa nenhuma lib de parsing de áudio — o
/// lado JS (`src/audio/SpeechPartRecognition.ts`) sempre gera esse formato
/// exato (cabeçalho WAV padrão + um chunk "data") antes de chamar esse
/// comando, então um parser mínimo manual é suficiente e evita puxar outra
/// dependência pesada só pra isso.
fn decode_wav_pcm16_mono(bytes: &[u8]) -> Result<Vec<f32>, String> {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("arquivo não é um WAV válido".into());
    }
    let mut pos = 12;
    let mut data_start = None;
    let mut data_len = 0usize;
    while pos + 8 <= bytes.len() {
        let chunk_id = &bytes[pos..pos + 4];
        let chunk_size = u32::from_le_bytes([
            bytes[pos + 4],
            bytes[pos + 5],
            bytes[pos + 6],
            bytes[pos + 7],
        ]) as usize;
        if chunk_id == b"data" {
            data_start = Some(pos + 8);
            data_len = chunk_size;
            break;
        }
        pos += 8 + chunk_size + (chunk_size % 2);
    }
    let start = data_start.ok_or("WAV sem chunk 'data'")?;
    let end = (start + data_len).min(bytes.len());
    let pcm = &bytes[start..end];
    let mut samples = Vec::with_capacity(pcm.len() / 2);
    for chunk in pcm.chunks_exact(2) {
        let s = i16::from_le_bytes([chunk[0], chunk[1]]);
        samples.push(s as f32 / 32768.0);
    }
    Ok(samples)
}

/// Transcreve um WAV (16kHz mono PCM16, já preparado pelo front-end a partir
/// da faixa guia) usando o modelo local. 100% offline depois que o modelo já
/// foi baixado — nenhum áudio sai do computador do usuário. Os bytes do WAV
/// vêm direto por argumento do comando (sem passar por disco) — pra um
/// trecho de alguns minutos de voz guia em 16kHz mono isso é pequeno o
/// bastante (poucos MB) pra não precisar de um arquivo temporário.
#[tauri::command]
pub async fn speech_transcribe_wav(
    app: AppHandle,
    wav_bytes: Vec<u8>,
    language: Option<String>,
) -> Result<Vec<TranscriptSegment>, String> {
    let model_file = model_path(&app)?;
    if !model_file.exists() {
        return Err("modelo de voz ainda não foi baixado".into());
    }
    let lang = language.unwrap_or_else(|| "pt".to_string());

    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<TranscriptSegment>, String> {
        let samples = decode_wav_pcm16_mono(&wav_bytes)?;
        use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

        let ctx = WhisperContext::new_with_params(
            &model_file.to_string_lossy(),
            WhisperContextParameters::default(),
        )
        .map_err(|e| format!("falha ao carregar o modelo de voz: {e}"))?;
        let mut state = ctx.create_state().map_err(|e| e.to_string())?;

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some(&lang));
        params.set_translate(false);
        params.set_print_progress(false);
        params.set_print_special(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);

        state
            .full(params, &samples)
            .map_err(|e| format!("falha na transcrição: {e}"))?;

        let n = state.full_n_segments().map_err(|e| e.to_string())?;
        let mut out = Vec::with_capacity(n.max(0) as usize);
        for i in 0..n {
            let text = state
                .full_get_segment_text_lossy(i)
                .unwrap_or_default();
            let t0 = state.full_get_segment_t0(i).unwrap_or(0); // centissegundos
            let t1 = state.full_get_segment_t1(i).unwrap_or(0);
            out.push(TranscriptSegment {
                start_ms: t0 * 10,
                end_ms: t1 * 10,
                text,
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}
