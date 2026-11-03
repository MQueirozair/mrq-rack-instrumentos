// Ponto de entrada nativo. Toda a lógica mora em lib.rs (padrão Tauri v2,
// necessário para suportar build mobile no futuro, mesmo que hoje o MRQ seja
// só desktop).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    mrq_multitracks_play_lib::run();
}
