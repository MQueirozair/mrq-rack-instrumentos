// Servidor de controle remoto (celular/tablet na mesma rede local), reescrito
// em Rust (axum + WebSocket) no lugar do antigo Express + ws do Electron
// (electron/remoteServer.ts). Mesmo protocolo de rede de antes (pra não
// precisar mudar nada no HTML/JS da pasta electron/remote-ui que roda no
// celular):
//   - GET /health                -> {"ok": true}
//   - GET /* (estático)          -> serve a pasta remote-ui
//   - WS  /ws                    -> mensagens JSON:
//       cliente->servidor: {"type":"auth","pin":"..."}      -> servidor responde {"type":"auth","ok":bool}
//       cliente->servidor: {"type":"command","pin":"...","payload":{...}} -> repassado pro front-end do app (evento "remote:command")
//       servidor->cliente: {"type":"state","payload":{...}} -> estado atual da reprodução (enviado a cada conexão nova e a cada broadcast_state)

use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::State,
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use serde_json::Value;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::{broadcast, Mutex, Notify};

#[derive(Clone)]
pub struct RemoteManagerInner {
    pub app_handle: AppHandle,
    pub static_dir: PathBuf,
    pin: Arc<Mutex<String>>,
    last_state: Arc<Mutex<Option<Value>>>,
    broadcast_tx: broadcast::Sender<Value>,
    shutdown: Arc<Mutex<Option<Arc<Notify>>>>,
    current_port: Arc<Mutex<Option<u16>>>,
}

pub type RemoteManager = Arc<RemoteManagerInner>;

pub fn new_manager(app_handle: AppHandle, static_dir: PathBuf) -> RemoteManager {
    let (tx, _rx) = broadcast::channel(32);
    Arc::new(RemoteManagerInner {
        app_handle,
        static_dir,
        pin: Arc::new(Mutex::new(String::new())),
        last_state: Arc::new(Mutex::new(None)),
        broadcast_tx: tx,
        shutdown: Arc::new(Mutex::new(None)),
        current_port: Arc::new(Mutex::new(None)),
    })
}

impl RemoteManagerInner {
    pub async fn configure(self: &Arc<Self>, enabled: bool, port: u16, pin: String) -> Result<(), String> {
        {
            let mut p = self.pin.lock().await;
            *p = pin;
        }
        let current = *self.current_port.lock().await;
        if !enabled {
            self.stop().await;
            return Ok(());
        }
        if current == Some(port) {
            return Ok(()); // já rodando na porta certa, nada a fazer
        }
        self.stop().await;
        self.start(port).await
    }

    async fn start(self: &Arc<Self>, port: u16) -> Result<(), String> {
        let notify = Arc::new(Notify::new());
        {
            let mut s = self.shutdown.lock().await;
            *s = Some(Arc::clone(&notify));
        }

        let state = Arc::clone(self);
        let static_dir = self.static_dir.clone();
        let app = Router::new()
            .route("/health", get(health))
            .route("/ws", get(ws_upgrade))
            .fallback_service(tower_http::services::ServeDir::new(static_dir))
            .with_state(state);

        let addr = SocketAddr::from(([0, 0, 0, 0], port));
        let listener = tokio::net::TcpListener::bind(addr)
            .await
            .map_err(|e| format!("falha ao escutar na porta {port}: {e}"))?;

        *self.current_port.lock().await = Some(port);

        tauri::async_runtime::spawn(async move {
            let shutdown_signal = async move {
                notify.notified().await;
            };
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(shutdown_signal)
                .await;
        });

        Ok(())
    }

    async fn stop(self: &Arc<Self>) {
        let notify = {
            let mut s = self.shutdown.lock().await;
            s.take()
        };
        if let Some(n) = notify {
            n.notify_waiters();
        }
        *self.current_port.lock().await = None;
    }

    pub async fn broadcast_state(self: &Arc<Self>, snapshot: Value) {
        {
            let mut last = self.last_state.lock().await;
            *last = Some(snapshot.clone());
        }
        let _ = self.broadcast_tx.send(snapshot);
    }

    pub async fn current_port(self: &Arc<Self>) -> Option<u16> {
        *self.current_port.lock().await
    }
}

async fn health() -> impl IntoResponse {
    Json(serde_json::json!({ "ok": true }))
}

async fn ws_upgrade(
    State(manager): State<RemoteManager>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, manager))
}

async fn handle_socket(mut socket: WebSocket, manager: RemoteManager) {
    // manda o estado atual assim que conecta, igual ao servidor antigo.
    if let Some(state) = manager.last_state.lock().await.clone() {
        let msg = serde_json::json!({ "type": "state", "payload": state });
        let _ = socket.send(Message::Text(msg.to_string())).await;
    }

    let mut rx = manager.broadcast_tx.subscribe();

    loop {
        tokio::select! {
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Text(txt))) => {
                        handle_incoming(&txt, &manager, &mut socket).await;
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    _ => {}
                }
            }
            broadcast_msg = rx.recv() => {
                match broadcast_msg {
                    Ok(snapshot) => {
                        let msg = serde_json::json!({ "type": "state", "payload": snapshot });
                        if socket.send(Message::Text(msg.to_string())).await.is_err() {
                            break;
                        }
                    }
                    Err(_) => {}
                }
            }
        }
    }
}

async fn handle_incoming(txt: &str, manager: &RemoteManager, socket: &mut WebSocket) {
    let parsed: Value = match serde_json::from_str(txt) {
        Ok(v) => v,
        Err(_) => return,
    };
    let msg_type = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let current_pin = manager.pin.lock().await.clone();

    match msg_type {
        "auth" => {
            let ok = parsed.get("pin").and_then(|v| v.as_str()) == Some(current_pin.as_str());
            let resp = serde_json::json!({ "type": "auth", "ok": ok });
            let _ = socket.send(Message::Text(resp.to_string())).await;
        }
        "command" => {
            let pin_ok = parsed.get("pin").and_then(|v| v.as_str()) == Some(current_pin.as_str());
            if pin_ok {
                if let Some(payload) = parsed.get("payload") {
                    let _ = manager.app_handle.emit("remote:command", payload.clone());
                }
            }
        }
        _ => {}
    }
}
