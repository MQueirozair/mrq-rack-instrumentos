// OSC (Open Sound Control) — ponte de automação/show-control com softwares
// externos de luz/vídeo/produção (QLab, Resolume, TouchOSC, consoles de
// iluminação, etc.), via UDP. Ver pesquisa de mercado: é o protocolo comum
// entre essas ferramentas (ao contrário do MIDI, tem endereços legíveis tipo
// "/mrq/transport/play" e argumentos tipados).
//
// Implementamos aqui, à mão, só o subconjunto do spec OSC 1.0 que a gente
// realmente usa (mensagens simples com argumentos i/f/s — sem bundles, sem
// pattern-matching de endereço com curingas) usando só `tokio` (já era
// dependência do projeto, inclui suporte a UDP na feature "full" já
// habilitada) — evita trazer uma crate nova (ex.: `rosc`) só pra isso.
//
// Protocolo de uso (ver settings.osc no front-end / HelpPanel.tsx "osc"):
//   - MRQ ENVIA pra `send_host:send_port` quando o estado muda (tocar/parar,
//     troca de parte, tempo/tom) e quando uma cue de palco é disparada.
//   - MRQ também ESCUTA em `0.0.0.0:listen_port`: mensagens recebidas (de um
//     TouchOSC, QLab ou qualquer app OSC) são repassadas pro front-end via
//     evento Tauri "osc:message", que decide o que fazer (ex.: "/mrq/play").

use serde::{Deserialize, Serialize};
use std::convert::TryInto;
use std::net::SocketAddr;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::net::UdpSocket;
use tokio::sync::{Mutex, Notify};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "value")]
pub enum OscArg {
    #[serde(rename = "i")]
    Int(i32),
    #[serde(rename = "f")]
    Float(f32),
    #[serde(rename = "s")]
    Str(String),
}

fn pad4(len: usize) -> usize {
    (4 - (len % 4)) % 4
}

/// Codifica uma única mensagem OSC (endereço + argumentos tipados) em bytes,
/// pronta pra mandar num datagrama UDP.
pub fn encode_message(address: &str, args: &[OscArg]) -> Vec<u8> {
    let mut buf = Vec::new();

    buf.extend_from_slice(address.as_bytes());
    buf.push(0);
    let pad = pad4(buf.len());
    buf.extend(std::iter::repeat(0u8).take(pad));

    let mut tags = String::from(",");
    for a in args {
        tags.push(match a {
            OscArg::Int(_) => 'i',
            OscArg::Float(_) => 'f',
            OscArg::Str(_) => 's',
        });
    }
    buf.extend_from_slice(tags.as_bytes());
    buf.push(0);
    let pad = pad4(tags.len() + 1);
    buf.extend(std::iter::repeat(0u8).take(pad));

    for a in args {
        match a {
            OscArg::Int(v) => buf.extend_from_slice(&v.to_be_bytes()),
            OscArg::Float(v) => buf.extend_from_slice(&v.to_be_bytes()),
            OscArg::Str(s) => {
                let start = buf.len();
                buf.extend_from_slice(s.as_bytes());
                buf.push(0);
                let written = buf.len() - start;
                buf.extend(std::iter::repeat(0u8).take(pad4(written)));
            }
        }
    }
    buf
}

#[derive(Debug, Clone, Serialize)]
pub struct DecodedOscMessage {
    pub address: String,
    pub args: Vec<OscArg>,
}

/// Lê uma string estilo OSC (terminada em \0, preenchida até múltiplo de 4
/// bytes) a partir de `start`, devolvendo o texto e a posição logo após o
/// preenchimento.
fn read_osc_string(data: &[u8], start: usize) -> Option<(String, usize)> {
    let end = data[start..].iter().position(|&b| b == 0)? + start;
    let s = String::from_utf8_lossy(&data[start..end]).to_string();
    let total_len = (end - start) + 1; // inclui o \0 terminador
    let padded_len = total_len + pad4(total_len);
    Some((s, start + padded_len))
}

/// Decodifica uma mensagem OSC simples recebida por UDP. Pacotes que não
/// comecem com "/" (ex.: um "#bundle") são ignorados silenciosamente — não
/// precisamos desse recurso aqui.
pub fn decode_message(data: &[u8]) -> Option<DecodedOscMessage> {
    let (address, mut pos) = read_osc_string(data, 0)?;
    if !address.starts_with('/') {
        return None;
    }
    if pos >= data.len() || data[pos] != b',' {
        return Some(DecodedOscMessage { address, args: vec![] });
    }
    let (type_tags, new_pos) = read_osc_string(data, pos)?;
    pos = new_pos;
    let mut args = Vec::new();
    for c in type_tags.chars().skip(1) {
        match c {
            'i' => {
                if pos + 4 > data.len() {
                    break;
                }
                let v = i32::from_be_bytes(data[pos..pos + 4].try_into().ok()?);
                args.push(OscArg::Int(v));
                pos += 4;
            }
            'f' => {
                if pos + 4 > data.len() {
                    break;
                }
                let v = f32::from_be_bytes(data[pos..pos + 4].try_into().ok()?);
                args.push(OscArg::Float(v));
                pos += 4;
            }
            's' => {
                let (s, new_pos) = read_osc_string(data, pos)?;
                args.push(OscArg::Str(s));
                pos = new_pos;
            }
            _ => { /* tipo não suportado (blob, timetag, etc.) — ignora o resto da mensagem */
            }
        }
    }
    Some(DecodedOscMessage { address, args })
}

#[derive(Clone, PartialEq)]
struct OscConfig {
    listen_port: u16,
    send_host: String,
    send_port: u16,
}

#[derive(Clone)]
pub struct OscManagerInner {
    app_handle: AppHandle,
    socket: Arc<Mutex<Option<Arc<UdpSocket>>>>,
    target: Arc<Mutex<Option<SocketAddr>>>,
    shutdown: Arc<Mutex<Option<Arc<Notify>>>>,
    listen_port: Arc<Mutex<Option<u16>>>,
    current_config: Arc<Mutex<Option<OscConfig>>>,
}

pub type OscManager = Arc<OscManagerInner>;

pub fn new_manager(app_handle: AppHandle) -> OscManager {
    Arc::new(OscManagerInner {
        app_handle,
        socket: Arc::new(Mutex::new(None)),
        target: Arc::new(Mutex::new(None)),
        shutdown: Arc::new(Mutex::new(None)),
        listen_port: Arc::new(Mutex::new(None)),
        current_config: Arc::new(Mutex::new(None)),
    })
}

impl OscManagerInner {
    /// (Re)configura a ponte OSC: liga/desliga, e troca a porta de escuta e o
    /// destino de envio. Sempre para a instância anterior primeiro (idempotente
    /// — chamar de novo com os mesmos parâmetros só reinicia o socket).
    pub async fn configure(
        self: &Arc<Self>,
        enabled: bool,
        listen_port: u16,
        send_host: String,
        send_port: u16,
    ) -> Result<(), String> {
        if !enabled {
            self.stop().await;
            *self.current_config.lock().await = None;
            return Ok(());
        }
        let new_config = OscConfig { listen_port, send_host: send_host.clone(), send_port };
        if self.current_config.lock().await.as_ref() == Some(&new_config) {
            return Ok(()); // já rodando com exatamente esta configuração, nada a fazer
        }
        self.stop().await;
        let target: SocketAddr = format!("{send_host}:{send_port}")
            .parse()
            .map_err(|e| format!("endereço de destino OSC inválido: {e}"))?;

        let addr = SocketAddr::from(([0, 0, 0, 0], listen_port));
        let sock = UdpSocket::bind(addr)
            .await
            .map_err(|e| format!("falha ao escutar UDP na porta {listen_port}: {e}"))?;
        let sock = Arc::new(sock);

        *self.target.lock().await = Some(target);
        *self.socket.lock().await = Some(Arc::clone(&sock));
        *self.listen_port.lock().await = Some(listen_port);
        *self.current_config.lock().await = Some(new_config);

        let notify = Arc::new(Notify::new());
        *self.shutdown.lock().await = Some(Arc::clone(&notify));

        let app_handle = self.app_handle.clone();
        tauri::async_runtime::spawn(async move {
            let mut buf = [0u8; 2048];
            loop {
                tokio::select! {
                    _ = notify.notified() => break,
                    res = sock.recv_from(&mut buf) => {
                        match res {
                            Ok((n, _src)) => {
                                if let Some(msg) = decode_message(&buf[..n]) {
                                    let _ = app_handle.emit("osc:message", msg);
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
        *self.target.lock().await = None;
        *self.listen_port.lock().await = None;
    }

    /// Envia uma mensagem OSC pro destino configurado. Erro claro (em vez de
    /// silencioso) quando a ponte não está ligada — o front-end mostra isso
    /// como aviso só quando o usuário tenta usar um recurso que depende disso
    /// (ex.: cue de palco) com OSC desligado, nunca interrompe a reprodução.
    pub async fn send(self: &Arc<Self>, address: String, args: Vec<OscArg>) -> Result<(), String> {
        let sock = self.socket.lock().await.clone();
        let target = *self.target.lock().await;
        match (sock, target) {
            (Some(sock), Some(target)) => {
                let payload = encode_message(&address, &args);
                sock.send_to(&payload, target)
                    .await
                    .map_err(|e| format!("falha ao enviar mensagem OSC: {e}"))?;
                Ok(())
            }
            _ => Err("a ponte OSC não está ativada".to_string()),
        }
    }

    pub async fn is_enabled(self: &Arc<Self>) -> bool {
        self.socket.lock().await.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Garante que codificar e decodificar uma mensagem produz o endereço e
    /// os argumentos originais de volta, inclusive com o preenchimento de
    /// alinhamento de 4 bytes do spec OSC 1.0 (o ponto mais fácil de errar
    /// num encoder/decoder escrito à mão). Cobre os 3 tipos de argumento que
    /// implementamos (i/f/s) e o caso sem nenhum argumento.
    #[test]
    fn round_trip_no_args() {
        let encoded = encode_message("/mrq/transport/play", &[]);
        assert_eq!(encoded.len() % 4, 0);
        let decoded = decode_message(&encoded).expect("deveria decodificar");
        assert_eq!(decoded.address, "/mrq/transport/play");
        assert!(decoded.args.is_empty());
    }

    #[test]
    fn round_trip_mixed_args() {
        let args = vec![
            OscArg::Int(7),
            OscArg::Float(123.5),
            OscArg::Str("Refrão".to_string()),
        ];
        let encoded = encode_message("/mrq/cue/fire", &args);
        assert_eq!(encoded.len() % 4, 0, "mensagem OSC deve ficar alinhada em 4 bytes");
        let decoded = decode_message(&encoded).expect("deveria decodificar");
        assert_eq!(decoded.address, "/mrq/cue/fire");
        assert_eq!(decoded.args.len(), 3);
        match &decoded.args[0] {
            OscArg::Int(v) => assert_eq!(*v, 7),
            _ => panic!("esperava Int"),
        }
        match &decoded.args[1] {
            OscArg::Float(v) => assert!((*v - 123.5).abs() < 0.001),
            _ => panic!("esperava Float"),
        }
        match &decoded.args[2] {
            OscArg::Str(s) => assert_eq!(s, "Refrão"),
            _ => panic!("esperava Str"),
        }
    }

    #[test]
    fn ignores_bundle_like_packets() {
        // "#bundle" não começa com "/" — nosso decoder deve simplesmente
        // devolver None em vez de interpretar algo errado.
        let fake_bundle = b"#bundle\0\0\0\0\0\0\0\0";
        assert!(decode_message(fake_bundle).is_none());
    }
}
