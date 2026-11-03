mod fsops;
mod importers;
mod logging;
mod migration;
mod mrq;
mod osc;
mod protocol;
mod remote;
mod speech;
mod sync;

use logging::LogState;
use osc::{OscArg, OscManager};
use remote::RemoteManager;
use std::sync::Arc;
use sync::{SyncManager, SyncState};
use tauri::Manager;

#[tauri::command]
async fn log_append(state: tauri::State<'_, Arc<LogState>>, line: String) -> Result<bool, ()> {
    state.append(&line).await;
    Ok(true)
}

#[tauri::command]
fn log_get_path(state: tauri::State<'_, Arc<LogState>>) -> String {
    state.log_path.to_string_lossy().to_string()
}

#[tauri::command]
async fn log_read_tail(
    state: tauri::State<'_, Arc<LogState>>,
    max_chars: Option<usize>,
) -> Result<String, ()> {
    Ok(state.read_tail(max_chars.unwrap_or(200_000)).await)
}

#[tauri::command]
async fn log_clear(state: tauri::State<'_, Arc<LogState>>) -> Result<bool, ()> {
    state.clear().await;
    Ok(true)
}

#[tauri::command]
async fn remote_configure(
    manager: tauri::State<'_, RemoteManager>,
    enabled: bool,
    port: u16,
    pin: String,
) -> Result<(), String> {
    manager.configure(enabled, port, pin).await
}

#[tauri::command]
async fn remote_broadcast_state(
    manager: tauri::State<'_, RemoteManager>,
    snapshot: serde_json::Value,
) -> Result<(), ()> {
    manager.broadcast_state(snapshot).await;
    Ok(())
}

#[tauri::command]
async fn remote_get_current_port(manager: tauri::State<'_, RemoteManager>) -> Result<Option<u16>, ()> {
    Ok(manager.current_port().await)
}

#[tauri::command]
async fn osc_configure(
    manager: tauri::State<'_, OscManager>,
    enabled: bool,
    listen_port: u16,
    send_host: String,
    send_port: u16,
) -> Result<(), String> {
    manager
        .configure(enabled, listen_port, send_host, send_port)
        .await
}

#[tauri::command]
async fn osc_send(
    manager: tauri::State<'_, OscManager>,
    address: String,
    args: Vec<OscArg>,
) -> Result<(), String> {
    manager.send(address, args).await
}

#[tauri::command]
async fn osc_is_enabled(manager: tauri::State<'_, OscManager>) -> Result<bool, ()> {
    Ok(manager.is_enabled().await)
}

#[tauri::command]
async fn sync_configure(
    manager: tauri::State<'_, SyncManager>,
    enabled: bool,
    role: String,
    port: u16,
) -> Result<(), String> {
    manager.configure(enabled, role, port).await
}

#[tauri::command]
async fn sync_broadcast_state(
    manager: tauri::State<'_, SyncManager>,
    state: SyncState,
) -> Result<(), String> {
    manager.broadcast_state(state).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Polyfill da Web MIDI API via Rust (midir) — necessário no macOS
        // (WKWebView não implementa navigator.requestMIDIAccess de jeito
        // nenhum) e usado também no Windows/Linux pra ter um único backend
        // nativo de MIDI consistente em vez de depender da implementação
        // própria (e possivelmente inconsistente) de cada motor de webview.
        // O código do Rack (src/midi/*.ts) já usa só a API padrão
        // navigator.requestMIDIAccess — nenhuma mudança necessária lá.
        .plugin(tauri_plugin_midi::init())
        .register_asynchronous_uri_scheme_protocol("mrqfile", protocol::handle)
        .setup(|app| {
            let log_dir = app
                .path()
                .app_data_dir()
                .expect("não foi possível resolver o diretório de dados do app")
                .join("logs");
            let log_state = LogState::new(log_dir);
            app.manage(log_state);

            // A pasta remote-ui (frontend servido para o celular) é empacotada
            // como resource do app; em dev usamos o caminho direto do repo.
            let static_dir = app
                .path()
                .resource_dir()
                .map(|p| p.join("remote-ui"))
                .unwrap_or_else(|_| std::path::PathBuf::from("electron/remote-ui"));
            let static_dir = if static_dir.exists() {
                static_dir
            } else {
                std::path::PathBuf::from("electron/remote-ui")
            };

            let remote_manager = remote::new_manager(app.handle().clone(), static_dir);
            app.manage(remote_manager);

            let osc_manager = osc::new_manager(app.handle().clone());
            app.manage(osc_manager);

            let sync_manager = sync::new_manager(app.handle().clone());
            app.manage(sync_manager);

            // Estado do MRQ Instrument Converter (Fase 2: só o formato .mrq
            // e o backend de empacotamento/leitura — ver docs/mrq-converter-architecture.md).
            app.manage(mrq::writer::MrqBuilderState::default());

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Some(log) = app_handle.try_state::<Arc<LogState>>() {
                    log.append(&format!(
                        "=== MRQ iniciado (Tauri) === versão={} plataforma={} arch={}",
                        app_handle.package_info().version,
                        std::env::consts::OS,
                        std::env::consts::ARCH,
                    ))
                    .await;
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fsops::scan_folder_tracks,
            fsops::save_binary_file,
            fsops::local_addresses,
            fsops::list_dir_entry_names,
            fsops::find_sample_files,
            migration::find_legacy_electron_config,
            log_append,
            log_get_path,
            log_read_tail,
            log_clear,
            remote_configure,
            remote_broadcast_state,
            remote_get_current_port,
            osc_configure,
            osc_send,
            osc_is_enabled,
            sync_configure,
            sync_broadcast_state,
            speech::speech_model_ready,
            speech::speech_download_model,
            speech::speech_delete_model,
            speech::speech_transcribe_wav,
            mrq::commands::mrq_builder_begin,
            mrq::commands::mrq_builder_add_sample,
            mrq::commands::mrq_builder_finish,
            mrq::commands::mrq_builder_abort,
            mrq::commands::mrq_read_metadata,
            mrq::commands::mrq_read_sample_index,
            mrq::commands::mrq_extract_sample,
            mrq::commands::mrq_validate_integrity,
            importers::commands::mrq_inspect_sf2,
            importers::commands::mrq_convert_sf2_to_mrq,
            importers::commands::mrq_inspect_npno,
            importers::commands::mrq_convert_npno_to_mrq,
            importers::commands::mrq_inspect_audio_file,
            importers::commands::mrq_convert_audio_file_to_mrq,
            importers::commands::mrq_capture_probe_audio_file,
            importers::commands::mrq_capture_add_sample,
        ])
        .run(tauri::generate_context!())
        .expect("erro ao rodar a aplicação Tauri");
}
