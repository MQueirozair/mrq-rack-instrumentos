// Log de diagnóstico persistente, equivalente ao da versão Electron
// (electron/main.ts): fica fora da pasta de instalação, sobrevive a updates,
// e pode ser lido/zerado pela tela de ajuda do app sem precisar de DevTools.
//
// Igual ao original: as linhas são só enfileiradas em memória e gravadas em
// lote, em segundo plano (debounce de 150ms), para nunca travar a UI quando
// uma música com várias faixas gera muitas linhas de log em sequência.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use tokio::fs;
use tokio::sync::Mutex;

const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
const TRUNCATED_KEEP_BYTES: usize = 2 * 1024 * 1024;
const FLUSH_DEBOUNCE_MS: u64 = 150;
const SIZE_CHECK_EVERY: u32 = 200;

pub struct LogState {
    pub log_path: PathBuf,
    queue: Mutex<Vec<String>>,
    flush_scheduled: AtomicBool,
    writes_since_size_check: AtomicU32,
}

impl LogState {
    pub fn new(log_dir: PathBuf) -> Arc<Self> {
        let _ = std::fs::create_dir_all(&log_dir);
        let log_path = log_dir.join("mrq-debug.log");
        Arc::new(Self {
            log_path,
            queue: Mutex::new(Vec::new()),
            flush_scheduled: AtomicBool::new(false),
            writes_since_size_check: AtomicU32::new(0),
        })
    }

    pub async fn append(self: &Arc<Self>, line: &str) {
        let ts = chrono_like_now();
        let formatted = format!("[{ts}] {line}\n");
        {
            let mut q = self.queue.lock().await;
            q.push(formatted);
        }
        self.schedule_flush();
    }

    fn schedule_flush(self: &Arc<Self>) {
        if self
            .flush_scheduled
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }
        let state = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(FLUSH_DEBOUNCE_MS)).await;
            state.flush_scheduled.store(false, Ordering::SeqCst);
            state.flush().await;
        });
    }

    pub async fn flush(self: &Arc<Self>) {
        let batch: Vec<String> = {
            let mut q = self.queue.lock().await;
            if q.is_empty() {
                return;
            }
            std::mem::take(&mut *q)
        };
        if let Some(parent) = self.log_path.parent() {
            let _ = fs::create_dir_all(parent).await;
        }
        let joined = batch.concat();
        use tokio::io::AsyncWriteExt;
        if let Ok(mut file) = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log_path)
            .await
        {
            let _ = file.write_all(joined.as_bytes()).await;
        }

        let count = self.writes_since_size_check.fetch_add(1, Ordering::SeqCst) + 1;
        if count >= SIZE_CHECK_EVERY {
            self.writes_since_size_check.store(0, Ordering::SeqCst);
            if let Ok(meta) = fs::metadata(&self.log_path).await {
                if meta.len() > MAX_LOG_BYTES {
                    if let Ok(content) = fs::read_to_string(&self.log_path).await {
                        let tail = if content.len() > TRUNCATED_KEEP_BYTES {
                            content[content.len() - TRUNCATED_KEEP_BYTES..].to_string()
                        } else {
                            content
                        };
                        let _ = fs::write(
                            &self.log_path,
                            format!("[...log truncado...]\n{tail}"),
                        )
                        .await;
                    }
                }
            }
        }
    }

    pub async fn read_tail(self: &Arc<Self>, max_chars: usize) -> String {
        self.flush().await;
        match fs::read_to_string(&self.log_path).await {
            Ok(content) => {
                if content.len() > max_chars {
                    content[content.len() - max_chars..].to_string()
                } else {
                    content
                }
            }
            Err(_) => String::new(),
        }
    }

    pub async fn clear(self: &Arc<Self>) {
        {
            let mut q = self.queue.lock().await;
            q.clear();
        }
        let _ = fs::write(&self.log_path, "").await;
    }
}

fn chrono_like_now() -> String {
    // Timestamp ISO-8601 em UTC sem depender da crate `chrono`, só pra manter
    // o binário final enxuto (alinhado com o objetivo de reduzir footprint).
    let now = std::time::SystemTime::now();
    let dur = now
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    let millis = dur.subsec_millis();
    let days = secs / 86400;
    let rem = secs % 86400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, mo, d) = civil_from_days(days as i64);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}.{millis:03}Z")
}

// Algoritmo padrão (Howard Hinnant) de conversão dias-desde-epoch -> data civil.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}
