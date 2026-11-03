// Migração única de configurações/biblioteca salvas por uma instalação
// ANTERIOR do MRQ em Electron (electron-store) pra dentro do store do Tauri
// (tauri-plugin-store), já que os dois shells usam diretórios de dados
// diferentes por padrão:
//
//   Electron (userData = appData/app.name, app.name = "name" do package.json):
//     Windows:  %APPDATA%\mrq-multitracks-play\config.json
//     macOS:    ~/Library/Application Support/mrq-multitracks-play/config.json
//     Linux:    ~/.config/mrq-multitracks-play/config.json
//
//   Tauri (app_data_dir = configDir/identifier):
//     Windows:  %APPDATA%\com.mrq.multitracksplay\mrq-config.json
//     macOS:    ~/Library/Application Support/com.mrq.multitracksplay/mrq-config.json
//     Linux:    ~/.local/share/com.mrq.multitracksplay/mrq-config.json (ver nota abaixo)
//
// `config_dir()` do Tauri resolve pro MESMO diretório-base que o
// `app.getPath('appData')` do Electron em cada SO (APPDATA / Application
// Support / XDG_CONFIG_HOME) — só muda o nome da subpasta (identifier do
// app vs. nome do pacote). Por via das dúvidas tentamos os dois nomes
// possíveis (o "name" do package.json E o productName), sem custo nenhum
// se um deles não existir.
//
// Importante: isso só LÊ o arquivo antigo, nunca apaga nem modifica —
// então na pior hipótese (caminho errado nalguma versão específica do SO)
// o resultado é simplesmente "nada encontrado", sem risco de perda de dados.

use tauri::Manager;

const LEGACY_APP_NAMES: &[&str] = &["mrq-multitracks-play", "MRQ - Multitracks Play"];

#[tauri::command]
pub fn find_legacy_electron_config(app: tauri::AppHandle) -> Option<String> {
    let base = app.path().config_dir().ok()?;
    for name in LEGACY_APP_NAMES {
        let candidate = base.join(name).join("config.json");
        if let Ok(content) = std::fs::read_to_string(&candidate) {
            return Some(content);
        }
    }
    None
}
