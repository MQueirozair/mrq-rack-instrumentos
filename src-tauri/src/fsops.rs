// Comandos de arquivo que não cabem bem nos plugins oficiais (dialog/fs) —
// aqui usamos std::fs diretamente, sem passar pelas "capabilities"/escopo do
// plugin tauri-plugin-fs, porque a pasta de músicas do usuário pode estar em
// qualquer lugar do disco (inclusive outra unidade, no Windows) e o app
// precisa do mesmo acesso livre que já tinha no processo principal do
// Electron.

use serde::Serialize;

#[derive(Serialize)]
pub struct TrackEntry {
    pub name: String,
    #[serde(rename = "filePath")]
    pub file_path: String,
}

const AUDIO_EXTENSIONS: &[&str] = &[
    "wav", "wave", "mp3", "flac", "aiff", "aif", "aifc", "ogg", "oga", "opus", "m4a", "mp4",
    "m4b", "aac", "wma", "webm", "caf", "3gp",
];

/// Lê só os arquivos de áudio que estão DIRETO dentro de `dir` (sem descer em
/// subpastas) — é o caso comum e rápido.
async fn scan_dir_audio_files(dir: &std::path::Path) -> Result<Vec<TrackEntry>, String> {
    let mut entries = tokio::fs::read_dir(dir)
        .await
        .map_err(|e| format!("falha ao ler pasta: {e}"))?;

    let mut tracks = Vec::new();
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| format!("falha ao listar pasta: {e}"))?
    {
        let path = entry.path();
        let file_type = match entry.file_type().await {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if !file_type.is_file() {
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !AUDIO_EXTENSIONS.contains(&ext.as_str()) {
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        tracks.push(TrackEntry {
            name: stem,
            file_path: path.to_string_lossy().to_string(),
        });
    }
    Ok(tracks)
}

/// Lista as subpastas diretas de `dir` (não recursivo).
async fn list_subdirs(dir: &std::path::Path) -> Result<Vec<std::path::PathBuf>, String> {
    let mut entries = tokio::fs::read_dir(dir)
        .await
        .map_err(|e| format!("falha ao ler pasta: {e}"))?;
    let mut dirs = Vec::new();
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| format!("falha ao listar pasta: {e}"))?
    {
        if matches!(entry.file_type().await, Ok(ft) if ft.is_dir()) {
            dirs.push(entry.path());
        }
    }
    Ok(dirs)
}

fn sort_tracks(mut tracks: Vec<TrackEntry>) -> Vec<TrackEntry> {
    // locale 'pt-BR' real exigiria uma crate de collation; comparação simples
    // por ordinal já cobre os casos práticos (nomes de faixa comuns).
    tracks.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    tracks
}

/// Grava bytes arbitrários num caminho absoluto — usado hoje pela exportação
/// de camadas do Rack para `.mrqi` (ver mrqiExport.ts no front-end): o
/// caminho vem de um diálogo "Salvar como" já resolvido pelo usuário, então
/// (igual a scan_folder_tracks acima) não faz sentido restringir pelo escopo
/// do plugin tauri-plugin-fs — o usuário já escolheu explicitamente onde
/// salvar, em qualquer pasta/unidade do disco.
#[tauri::command]
pub async fn save_binary_file(path: String, data: Vec<u8>) -> Result<(), String> {
    tokio::fs::write(&path, data)
        .await
        .map_err(|e| format!("falha ao salvar '{path}': {e}"))
}

/// Lista os nomes (não os caminhos completos) de TODAS as entradas diretas
/// de `dir` — arquivos e subpastas, sem filtrar por extensão nem descer
/// recursivamente. Usado pelo NkiLayerVoice (ver src/audio/rack/NkiLayerVoice.ts)
/// pra resolver, sem diferenciar maiúsculas/minúsculas, o caminho de amostra
/// que um `.nki` guarda (tipicamente no estilo Windows, ex.:
/// "Samples\\Grand\\C3.wav") contra os arquivos de verdade no disco: no
/// Windows e no macOS (sistema de arquivos padrão case-insensitive) isso
/// nunca fazia falta, mas no Linux (ext4, case-sensitive) uma letra
/// maiúscula/minúscula trocada entre o que o `.nki` "lembra" e o nome real
/// do arquivo fazia a amostra inteira falhar silenciosamente — mesmo a
/// biblioteca estando intacta e completa. Bypassa o escopo do
/// tauri-plugin-fs pelo mesmo motivo de save_binary_file/scan_folder_tracks
/// acima: a pasta de uma biblioteca de instrumentos pode estar em qualquer
/// lugar do disco, inclusive fora de qualquer pasta "de projeto" do app.
#[tauri::command]
pub async fn list_dir_entry_names(dir: String) -> Result<Vec<String>, String> {
    let path = std::path::PathBuf::from(&dir);
    let mut entries = tokio::fs::read_dir(&path)
        .await
        .map_err(|e| format!("falha ao ler pasta '{dir}': {e}"))?;
    let mut names = Vec::new();
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| format!("falha ao listar pasta '{dir}': {e}"))?
    {
        if let Some(name) = entry.file_name().to_str() {
            names.push(name.to_string());
        }
    }
    Ok(names)
}

/// Limites de segurança pra `find_sample_files` abaixo — uma biblioteca de
/// amostras legítima tem no máximo alguns milhares de arquivos; estes
/// limites só existem pra não travar o app (nem varrer o disco inteiro por
/// engano) se o usuário apontar pra uma pasta errada/gigante demais.
const FIND_SAMPLE_FILES_MAX_ENTRIES: usize = 200_000;
const FIND_SAMPLE_FILES_MAX_DEPTH: u32 = 16;

/// Varre `root_dir` recursivamente (com os limites acima) procurando
/// arquivos cujo nome — sem diferenciar maiúsculas/minúsculas — bata com
/// algum de `file_names`. Devolve um mapa "nome em minúsculas" → caminho
/// absoluto do primeiro arquivo encontrado com esse nome. Usado por
/// `NkiLayerVoice.resolveFromLibraryRoot` (ver NkiLayerVoice.ts) pra
/// recuperar amostras de um `.nki` que não estavam ao lado do arquivo nem
/// numa pasta Samples/samples direta — bibliotecas maiores costumam
/// organizar amostras em subpastas aninhadas (por instrumento/articulação/
/// letra inicial), então a busca precisa descer em toda a árvore a partir
/// da pasta raiz que o usuário escolher manualmente. Mesmo raciocínio de
/// bypassar o escopo do tauri-plugin-fs que list_dir_entry_names já segue
/// acima: a biblioteca pode estar em qualquer lugar do disco.
#[tauri::command]
pub async fn find_sample_files(
    root_dir: String,
    file_names: Vec<String>,
) -> Result<std::collections::HashMap<String, String>, String> {
    let wanted: std::collections::HashSet<String> =
        file_names.iter().map(|n| n.to_lowercase()).collect();
    let mut found: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut visited: usize = 0;
    let mut stack: Vec<(std::path::PathBuf, u32)> = vec![(std::path::PathBuf::from(&root_dir), 0)];

    while let Some((dir, depth)) = stack.pop() {
        if found.len() >= wanted.len() || visited > FIND_SAMPLE_FILES_MAX_ENTRIES {
            break;
        }
        if depth > FIND_SAMPLE_FILES_MAX_DEPTH {
            continue;
        }
        let mut entries = match tokio::fs::read_dir(&dir).await {
            Ok(e) => e,
            Err(_) => continue, // pasta sem permissão/sumiu no meio da varredura — ignora, não é fatal
        };
        while let Some(entry) = entries.next_entry().await.ok().flatten() {
            visited += 1;
            if visited > FIND_SAMPLE_FILES_MAX_ENTRIES {
                break;
            }
            let file_type = match entry.file_type().await {
                Ok(t) => t,
                Err(_) => continue,
            };
            let path = entry.path();
            if file_type.is_dir() {
                stack.push((path, depth + 1));
            } else if file_type.is_file() {
                if let Some(name) = entry.file_name().to_str() {
                    let lower = name.to_lowercase();
                    if wanted.contains(&lower) {
                        found.entry(lower).or_insert_with(|| path.to_string_lossy().to_string());
                    }
                }
            }
        }
    }

    Ok(found)
}

#[tauri::command]
pub async fn scan_folder_tracks(folder_path: String) -> Result<Vec<TrackEntry>, String> {
    let dir = std::path::PathBuf::from(&folder_path);
    let direct = scan_dir_audio_files(&dir).await?;
    if !direct.is_empty() {
        return Ok(sort_tracks(direct));
    }

    // A pasta escolhida não tem áudio direto nela — muito comum quando o
    // pacote de multitracks baixado vem com os arquivos dentro de uma
    // subpasta ("WAV", "Tracks", "Audio", "Stems", "48kHz" etc.). Em vez de
    // obrigar o usuário a navegar manualmente até lá (o que acabava fazendo
    // o nome da pasta errada — a subpasta genérica, não o nome da música —
    // virar o título da música), procura até 2 níveis abaixo. Só faz isso
    // quando a pasta escolhida tem poucas subpastas: é o sinal de que é a
    // pasta de UMA música (uma ou duas subpastas de organização), não uma
    // biblioteca inteira com dezenas de músicas dentro — nesse caso é melhor
    // não adivinhar e deixar o erro "nenhum arquivo encontrado" de antes.
    let subdirs = list_subdirs(&dir).await?;
    if subdirs.is_empty() || subdirs.len() > 8 {
        return Ok(Vec::new());
    }

    let mut found = Vec::new();
    for sub in &subdirs {
        let here = scan_dir_audio_files(sub).await?;
        if here.is_empty() {
            // mais um nível (ex.: "Música/Áudio/48kHz/*.wav")
            if let Ok(inner_dirs) = list_subdirs(sub).await {
                for inner in inner_dirs {
                    found.extend(scan_dir_audio_files(&inner).await?);
                }
            }
        } else {
            found.extend(here);
        }
    }
    Ok(sort_tracks(found))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// Pasta temporária isolada por teste (evita testes rodando em paralelo
    /// pisarem um no caminho do outro).
    fn temp_test_dir(label: &str) -> std::path::PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("mrq_fsops_test_{label}_{}_{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(path: &std::path::Path) {
        std::fs::write(path, b"fake audio data").unwrap();
    }

    #[tokio::test]
    async fn finds_files_directly_in_the_chosen_folder() {
        let dir = temp_test_dir("direct");
        touch(&dir.join("Click.wav"));
        touch(&dir.join("Guide.wav"));
        touch(&dir.join("notes.txt")); // não é áudio, deve ser ignorado

        let tracks = scan_folder_tracks(dir.to_string_lossy().to_string()).await.unwrap();
        assert_eq!(tracks.len(), 2);
        assert!(tracks.iter().any(|t| t.name == "Click"));
        assert!(tracks.iter().any(|t| t.name == "Guide"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn falls_back_one_level_when_the_chosen_folder_has_a_single_audio_subfolder() {
        // Reproduz o caso relatado: usuário escolhe a pasta da música, mas os
        // wavs estão dentro de uma única subpasta ("WAV") — antes disso o
        // scan simplesmente devolvia vazio e o usuário tinha que navegar até
        // lá manualmente.
        let dir = temp_test_dir("one_level");
        let sub = dir.join("WAV");
        std::fs::create_dir_all(&sub).unwrap();
        touch(&sub.join("Bass.wav"));
        touch(&sub.join("Drums.wav"));

        let tracks = scan_folder_tracks(dir.to_string_lossy().to_string()).await.unwrap();
        assert_eq!(tracks.len(), 2);
        assert!(tracks.iter().any(|t| t.name == "Bass"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn falls_back_two_levels_when_needed() {
        let dir = temp_test_dir("two_levels");
        let sub = dir.join("Audio").join("48kHz");
        std::fs::create_dir_all(&sub).unwrap();
        touch(&sub.join("Keys.wav"));

        let tracks = scan_folder_tracks(dir.to_string_lossy().to_string()).await.unwrap();
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].name, "Keys");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn does_not_recurse_into_a_folder_with_many_subfolders() {
        // Sinal de que a pasta escolhida é uma biblioteca inteira (várias
        // músicas), não a pasta de uma música só — não deve adivinhar.
        let dir = temp_test_dir("library");
        for i in 0..10 {
            let sub = dir.join(format!("Musica {i}"));
            std::fs::create_dir_all(&sub).unwrap();
            touch(&sub.join("Click.wav"));
        }

        let tracks = scan_folder_tracks(dir.to_string_lossy().to_string()).await.unwrap();
        assert!(tracks.is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn returns_empty_for_a_completely_empty_folder() {
        let dir = temp_test_dir("empty");
        let tracks = scan_folder_tracks(dir.to_string_lossy().to_string()).await.unwrap();
        assert!(tracks.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn list_dir_entry_names_lists_files_and_subfolders_by_name_only() {
        let dir = temp_test_dir("list_names");
        touch(&dir.join("C3.wav"));
        touch(&dir.join("readme.txt"));
        std::fs::create_dir_all(dir.join("SubPasta")).unwrap();

        let mut names = list_dir_entry_names(dir.to_string_lossy().to_string()).await.unwrap();
        names.sort();
        assert_eq!(names, vec!["C3.wav".to_string(), "SubPasta".to_string(), "readme.txt".to_string()]);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn list_dir_entry_names_reports_a_clear_error_for_a_missing_folder() {
        let dir = temp_test_dir("missing_parent").join("nao-existe");
        let err = list_dir_entry_names(dir.to_string_lossy().to_string()).await.unwrap_err();
        assert!(err.contains("falha ao ler pasta"));
    }

    #[tokio::test]
    async fn find_sample_files_locates_names_nested_in_subfolders() {
        let dir = temp_test_dir("find_nested");
        let sub = dir.join("Samples").join("Piano").join("A");
        std::fs::create_dir_all(&sub).unwrap();
        touch(&sub.join("C3.wav"));
        touch(&dir.join("readme.txt"));

        let found = find_sample_files(dir.to_string_lossy().to_string(), vec!["C3.wav".to_string()])
            .await
            .unwrap();
        assert_eq!(found.len(), 1);
        assert!(found.get("c3.wav").unwrap().ends_with("C3.wav"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn find_sample_files_matches_names_case_insensitively() {
        let dir = temp_test_dir("find_case");
        touch(&dir.join("grandpiano_a4.WAV"));

        let found = find_sample_files(dir.to_string_lossy().to_string(), vec!["GrandPiano_A4.wav".to_string()])
            .await
            .unwrap();
        assert_eq!(found.len(), 1);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn find_sample_files_returns_only_matches_not_the_whole_tree() {
        let dir = temp_test_dir("find_partial");
        touch(&dir.join("found.wav"));
        touch(&dir.join("not_wanted.wav"));

        let found = find_sample_files(dir.to_string_lossy().to_string(), vec!["found.wav".to_string()])
            .await
            .unwrap();
        assert_eq!(found.len(), 1);
        assert!(found.contains_key("found.wav"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn find_sample_files_returns_empty_map_for_nothing_found() {
        let dir = temp_test_dir("find_none");
        touch(&dir.join("other.wav"));

        let found = find_sample_files(dir.to_string_lossy().to_string(), vec!["missing.wav".to_string()])
            .await
            .unwrap();
        assert!(found.is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }
}

#[tauri::command]
pub fn local_addresses() -> Vec<String> {
    match if_addrs::get_if_addrs() {
        Ok(addrs) => addrs
            .into_iter()
            .filter(|a| !a.is_loopback())
            .filter_map(|a| match a.addr {
                if_addrs::IfAddr::V4(v4) => Some(v4.ip.to_string()),
                _ => None,
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}
