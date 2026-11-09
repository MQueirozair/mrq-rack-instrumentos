# Força o ggml (usado pelo whisper-rs/whisper.cpp, ver src-tauri/src/speech.rs)
# a NÃO compilar com otimizações "nativas" da CPU do runner (-mcpu=native /
# -march=native). Em runners macOS arm64 recentes (ex.: macos-15) a detecção
# de recursos do ggml fica inconsistente e gera erro de compilação
# ("always_inline function 'vmmlaq_s32' requires target feature 'i8mm'").
# Além de corrigir o build, isso deixa o binário final mais portátil entre
# diferentes CPUs (não trava com "illegal instruction" em CPUs mais antigas
# que a do runner que compilou).
#
# O build script do whisper-rs-sys só repassa pro CMake variáveis de
# ambiente que começam com WHISPER_ ou CMAKE_ — por isso a variável
# GGML_NATIVE precisa chegar via CMAKE_TOOLCHAIN_FILE (este arquivo),
# processado bem no início da configuração do CMake.
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
