// Protocolo customizado "mrqfile://" — equivalente ao protocol.registerFileProtocol
// usado no Electron (electron/main.ts) para servir arquivos de áudio locais sem
// copiar nada e sem os bloqueios de CORS/segurança do file:// puro.
//
// Formato da URL (igual ao da versão Electron, pra não precisar mudar nada no
// renderer): mrqfile://local-file/<caminho inteiro em encodeURIComponent>
//
// Diferente do Electron (que delega pro net stack do Chromium responder Range
// automaticamente a partir de um caminho de arquivo), aqui SOMOS nós que
// temos que entender o cabeçalho "Range" e responder 206 Partial Content —
// isso é essencial pra dar seek numa faixa de áudio em reprodução.

use std::path::PathBuf;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{UriSchemeContext, UriSchemeResponder};
use tauri::Runtime;


pub fn handle<R: Runtime>(
    _ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    // O WebView2 no Windows (e, em menor grau, o WebKit no macOS/Linux) trata
    // o fetch() do renderer para "mrqfile://" como uma requisição cross-origin
    // de verdade (a página roda em https://tauri.localhost, esquema diferente
    // de "mrqfile"). Sem "Access-Control-Allow-Origin" na resposta, o browser
    // recusa entregar o corpo pro JS e o fetch() estoura "Failed to fetch" —
    // é exatamente o que apareceu no log do usuário no Windows. Por isso toda
    // resposta (sucesso, erro e preflight) precisa sair com CORS liberado.
    if request.method() == tauri::http::Method::OPTIONS {
        responder.respond(with_cors(
            Response::builder()
                .status(StatusCode::NO_CONTENT)
                .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, OPTIONS")
                .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "Range, Content-Type")
                .body(Vec::new())
                .unwrap(),
        ));
        return;
    }

    let range_header = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let file_path = match resolve_path(request.uri()) {
        Ok(p) => p,
        Err(resp) => {
            responder.respond(with_cors(resp));
            return;
        }
    };

    tauri::async_runtime::spawn(async move {
        let resp = serve_file(&file_path, range_header.as_deref()).await;
        responder.respond(with_cors(resp));
    });
}

/// Garante que toda resposta do protocolo "mrqfile://" tenha os cabeçalhos de
/// CORS necessários para o fetch() do renderer conseguir ler o corpo — sem
/// isso o WebView2 (Windows) bloqueia a resposta inteira silenciosamente.
fn with_cors(mut resp: Response<Vec<u8>>) -> Response<Vec<u8>> {
    resp.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        header::HeaderValue::from_static("*"),
    );
    resp.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        header::HeaderValue::from_static("Range, Content-Type"),
    );
    resp
}

fn resolve_path(uri: &tauri::http::Uri) -> Result<PathBuf, Response<Vec<u8>>> {
    // uri.path() já vem decodificado de "//host" (o host é descartado, só usamos
    // o resto do path, que é o bloco opaco encodeURIComponent-codificado).
    let raw = uri.path().trim_start_matches('/');
    let decoded = percent_decode(raw);
    Ok(PathBuf::from(decoded))
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(hex);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

async fn serve_file(path: &PathBuf, range_header: Option<&str>) -> Response<Vec<u8>> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};

    let mut file = match tokio::fs::File::open(path).await {
        Ok(f) => f,
        Err(_) => {
            return Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Vec::new())
                .unwrap();
        }
    };

    let meta = match file.metadata().await {
        Ok(m) => m,
        Err(_) => {
            return Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Vec::new())
                .unwrap();
        }
    };
    let total_len = meta.len();

    let mime = mime_guess::from_path(path)
        .first_or_octet_stream()
        .to_string();

    let (start, end, status) = match range_header.and_then(parse_range) {
        Some((s, e)) => {
            let s = s.min(total_len.saturating_sub(1));
            let e = e.map(|e| e.min(total_len.saturating_sub(1))).unwrap_or(total_len.saturating_sub(1));
            (s, e, StatusCode::PARTIAL_CONTENT)
        }
        None => {
            // Sem Range: devolve o arquivo INTEIRO (status 200, Content-Length real).
            // ANTES disto limitávamos a 8MB "pra não travar em arquivos gigantes,
            // já que o player pediria o resto via Range" — só que isso só é verdade
            // pra elementos <audio>/<video> (que de fato re-pedem via Range quando
            // precisam de mais). Todo o resto do app (carregar instrumento do Rack,
            // gerar forma de onda, ler amostra do Kontakt/SFZ, e até o carregamento
            // principal de faixas em AudioEngine.loadSong) usa um fetch() simples
            // seguido de .arrayBuffer() — SEM nunca mandar Range — e não tem como
            // saber que a resposta "200 OK com Content-Length X" na verdade só
            // trouxe os primeiros 8MB de um arquivo maior. Isso corrompia
            // silenciosamente qualquer arquivo >8MB (bibliotecas Nord grandes,
            // SoundFonts grandes e até faixas de áudio do multitrack), fazendo
            // formatos com verificação de integridade (.npno) falharem com erro de
            // checksum, e os demais tocarem/decodificarem truncados sem aviso
            // nenhum. Elementos de mídia HTML continuam funcionando normalmente
            // aqui: eles mandam Range desde a primeira requisição quando o servidor
            // anuncia "Accept-Ranges: bytes" (como fazemos), então não dependem
            // deste branch pra nada.
            (0, total_len.saturating_sub(1), StatusCode::OK)
        }
    };

    let len = if total_len == 0 { 0 } else { end.saturating_sub(start) + 1 };
    let mut buf = vec![0u8; len as usize];
    if file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
        return Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .body(Vec::new())
            .unwrap();
    }
    if len > 0 {
        if let Err(_) = file.read_exact(&mut buf).await {
            return Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Vec::new())
                .unwrap();
        }
    }

    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, len.to_string());

    if status == StatusCode::PARTIAL_CONTENT {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{total_len}"),
        );
    }

    builder.body(buf).unwrap_or_else(|_| {
        Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .body(Vec::new())
            .unwrap()
    })
}

fn parse_range(header_value: &str) -> Option<(u64, Option<u64>)> {
    let v = header_value.strip_prefix("bytes=")?;
    let mut parts = v.splitn(2, '-');
    let start_s = parts.next()?.trim();
    let end_s = parts.next().unwrap_or("").trim();
    if start_s.is_empty() {
        // sufixo tipo "bytes=-500" (últimos 500 bytes) — não é usado pelos
        // players de áudio em volta, mas tratamos pra não quebrar.
        let suffix: u64 = end_s.parse().ok()?;
        return Some((0u64.saturating_sub(suffix), None));
    }
    let start: u64 = start_s.parse().ok()?;
    let end = if end_s.is_empty() {
        None
    } else {
        end_s.parse::<u64>().ok()
    };
    Some((start, end))
}
