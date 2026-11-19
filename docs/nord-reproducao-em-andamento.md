# Reprodução Nord — trabalho em andamento

Esta branch é experimental e não constitui uma versão publicada.

- `NpnoLayerVoice` toca uma amostra de soltura quando houver banco release no próprio `.npno`. A intensidade é aproximada, ainda não calibrada contra um instrumento físico.
- O teste usa fixture sintética `.npno` decodificada pelo WASM existente e AudioContext simulado. Não houve teste com arquivos Nord do usuário, hardware, nem comparação de som.
- No Rack, a entrada MIDI libera notas sustentadas no canal de origem. O CC64 continua binário; situações de notas idênticas simultâneas em camadas omni ou múltiplos dispositivos ainda requerem investigação.
- A conversão `.npno` → `.mrq` ainda não preserva os bancos release/resonance; os Controles ao Vivo do Conversor usam `MrqLayerVoice`, portanto a mudança de `NpnoLayerVoice` não significa suporte a essas amostras no `.mrq`.
- A ressonância de piano, novos motores de órgão/sintetizador, morph, importação de backups e emulação fiel de Stage 4 permanecem pendentes. Não há paridade sonora garantida.
- Nenhum código, firmware, marca ou sample do emulador externo foi incorporado.
