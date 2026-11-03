// "MRQ Sync": sincronismo leve de estado (tocando/parado, BPM, tom, música)
// entre várias instâncias do MRQ rodando na mesma rede local, via broadcast
// UDP — ver shared/types.ts `SyncSettings` e HelpPanel.tsx seção "sync".
// Segunda "tecnologia nova" pedida pelo usuário pra esta versão.
//
// IMPORTANTE (decisão de escopo, registrada durante o desenvolvimento): isto
// NÃO é o protocolo Ableton Link (sincronismo de FASE de batida, sample-
// accurate, entre DAWs/apps) — implementar Link à mão, sem nenhuma
// biblioteca madura disponível pra Rust/Tauri, foi avaliado como risco alto
// demais pra um recurso usado ao vivo. Em vez disso, o "MRQ Sync" é um RELAY
// DE ESTADO, deliberadamente mais simples: quem está no papel de Líder
// transmite periodicamente seu estado atual por broadcast UDP; quem está no
// papel de Seguidor só RECEBE e EXIBE esse estado (ver indicador no app) —
// nunca força play/pause/BPM sozinho na outra máquina. Isso já resolve o
// caso de uso real (ex.: o notebook do baterista mostrando o BPM/tom de quem
// está liderando a música, sem precisar gritar "qual é o andamento?") sem o
// risco de um pacote de rede perdido travar ou parar o áudio ao vivo de
// alguém no meio de uma apresentação.

use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::net::UdpSocket;
use tokio::sync::{Mutex, Notify};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncState {
    pub is_playing: bool,
    pub bpm: f32,
    pub key: String,
    pub song_title: String,
}

#[derive(Clone, PartialEq)]
struct SyncConfig {
    role: String,
    port: u16,
}

#[derive(Clone)]
pub struct SyncManagerInner {
    app_handle: AppHandle,
    socket: Arc<Mutex<Option<Arc<UdpSocket>>>>,
    shutdown: Arc<Mutex<Option<Arc<Notify>>>>,
    current_config: Arc<Mutex<Option<SyncConfig>>>,
}

pub type SyncManager = Arc<SyncManagerInner>;

pub fn new_manager(app_handle: AppHandle) -> SyncManager {
    Arc::new(SyncManagerInner {
        app_handle,
        socket: Arc::new(Mutex::new(None)),
        shutdown: Arc::new(Mutex::new(None)),
        current_config: Arc::new(Mutex::new(None)),
    })
}

impl SyncManagerInner {
    /// `role` é "leader" ou "follower". Em ambos os papéis abrimos o mesmo
    /// socket UDP (com broadcast habilitado) na porta configurada — só o
    /// papel muda o que fazemos com ele: líder manda (`broadcast_state`),
    /// seguidor escuta e repassa pro front-end via evento "sync:state".
    pub async fn configure(self: &Arc<Self>, enabled: bool, role: String, port: u16) -> Result<(), String> {
        if !enabled {
            self.stop().await;
            *self.current_config.lock().await = None;
            return Ok(());
        }
        let new_config = SyncConfig { role: role.clone(), port };
        if self.current_config.lock().await.as_ref() == Some(&new_config) {
            return Ok(()); // já rodando com exatamente este papel/porta, nada a fazer
        }
        self.stop().await;

        let socket = UdpSocket::bind(("0.0.0.0", port))
            .await
            .map_err(|e| format!("falha ao abrir UDP na porta {port}: {e}"))?;
        socket
            .set_broadcast(true)
            .map_err(|e| format!("falha ao habilitar broadcast UDP: {e}"))?;
        let socket = Arc::new(socket);
        *self.socket.lock().await = Some(Arc::clone(&socket));
        *self.current_config.lock().await = Some(new_config);

        let notify = Arc::new(Notify::new());
        *self.shutdown.lock().await = Some(Arc::clone(&notify));

        let is_follower = role == "follower";
        let app_handle = self.app_handle.clone();
        let sock_recv = Arc::clone(&socket);
        tauri::async_runtime::spawn(async move {
            let mut buf = [0u8; 2048];
            loop {
                tokio::select! {
                    _ = notify.notified() => break,
                    res = sock_recv.recv_from(&mut buf) => {
                        match res {
                            Ok((n, _src)) => {
                                if is_follower {
                                    if let Ok(state) = serde_json::from_slice::<SyncState>(&buf[..n]) {
                                        let _ = app_handle.emit("sync:state", state);
                                    }
                                }
                            }
                            Err(_) => break,
                        }
                    }
                }
            }
        });

        Ok(())
    }

    async fn stop(self: &Arc<Self>) {
        if let Some(n) = self.shutdown.lock().await.take() {
            n.notify_waiters();
        }
        *self.socket.lock().await = None;
    }

    /// Transmite o estado atual por broadcast UDP na rede local — chamado
    /// pelo front-end a cada mudança relevante de estado quando o papel
    /// configurado é "leader" (o front-end decide isso; aqui só mandamos se
    /// houver um socket ativo, senão não faz nada silenciosamente).
    pub async fn broadcast_state(self: &Arc<Self>, state: SyncState) -> Result<(), String> {
        let sock = self.socket.lock().await.clone();
        let port = match self.current_config.lock().await.as_ref() {
            Some(c) => c.port,
            None => return Ok(()),
        };
        if let Some(sock) = sock {
            let payload = serde_json::to_vec(&state).map_err(|e| e.to_string())?;
            let target: SocketAddr = format!("255.255.255.255:{port}")
                .parse()
                .map_err(|e: std::net::AddrParseError| e.to_string())?;
            // falha de broadcast (ex.: rede sem suporte, firewall) não deve
            // nunca interromper a reprodução — ignora silenciosamente.
            let _ = sock.send_to(&payload, target).await;
        }
        Ok(())
    }
}
