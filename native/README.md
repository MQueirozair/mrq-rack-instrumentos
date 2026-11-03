# Prova de conceito: motor de áudio nativo em JUCE

Pedido do usuário: "reconstrua o rack todo com a tecnologia JUCE pra vermos
se melhora". Antes de investir nisso, eu montei aqui uma prova de conceito
mínima pra testar se é viável — e **o resultado foi que não dá pra
desenvolver isso neste ambiente (sandbox do agente)**. Ver detalhes abaixo.

## O que existe aqui

- `CMakeLists.txt` — projeto CMake que baixa o JUCE 8.0.6 via `FetchContent`
  e compila um addon nativo do Node (`.node`, via Node-API/`node-addon-api`
  + `cmake-js`).
- `src/JuceAudioEngine.h/.cpp` — uma classe mínima que abre um dispositivo
  de áudio de verdade via `juce::AudioDeviceManager` e toca um osciloscópio
  de teste (seno) com note-on/note-off, pra provar o caminho ponta a ponta
  (JUCE -> callback de áudio em tempo real -> addon nativo -> Node/Electron).
- `src/binding.cpp` — a ponte Node-API que expõe isso ao JS
  (`listOutputDevices`, `start`, `stop`, `noteOnTest`, `noteOffTest` etc.).

**Isto NÃO é o Rack inteiro reescrito.** É só o esqueleto mínimo pra testar
se compilar/rodar JUCE é viável aqui antes de investir semanas portando as
8 camadas, os 5 formatos de instrumento (SF2/NKI/EXS24/DX7/.mrq) e os ~15
efeitos por camada (reverb, delay, chorus, flanger, phaser, bitcrusher,
shimmer, compressor, EQ, gate, drive, tremolo) que hoje existem no
`RackEngine.ts` (Web Audio API).

## Por que não dá pra continuar aqui

Tentei compilar esta prova de conceito mínima (só isso, nem o rack
completo) nesta máquina sandbox e o resultado foi:

- A própria integração CMake do JUCE, mesmo pedindo só módulos de áudio
  (`juce_core`, `juce_audio_devices`, `juce_dsp` etc., sem nenhum módulo de
  GUI), **sempre** compila internamente uma ferramenta auxiliar chamada
  `juceaide`, que por sua vez depende de `juce_gui_basics` + `juce_graphics`
  inteiros — isso é um comportamento do próprio JUCE, não uma escolha minha.
- Essa máquina tem só 2 vCPUs e ~1.9GB de RAM, **sem swap**. Compilar um
  único arquivo do `juce_gui_basics` (`juce_gui_basics.cpp`, um "unity
  build" que inclui o módulo inteiro) sozinho chegou a consumir **~1.44GB
  de RAM** — mais de 70% de toda a memória da máquina, só pra UM arquivo.
- O processo de build (`cmake-js`) foi morto pelo OOM killer do Linux
  (código de saída 137 = SIGKILL) meia hora depois, mas um processo
  `cc1plus` (o compilador C++ de verdade) ficou **órfão e continuou
  rodando sozinho**, travando toda a sandbox por vários minutos seguidos
  (nem comandos triviais como `echo` conseguiam rodar) até eu encontrar e
  matar esse processo manualmente.

Ou seja: **nem a menor fatia possível** de um motor JUCE (um osciloscópio
de teste, sem nenhum efeito, sem nenhum instrumento real) consegue ser
compilada de forma estável neste ambiente. Isso não é um problema de código
— é um limite físico de CPU/RAM da máquina que executa o agente.

## O que isso significa na prática

1. **Eu não consigo desenvolver/testar iterativamente um motor JUCE aqui.**
   Cada tentativa de build arrisca travar a sandbox de novo (como aconteceu)
   e consumir vários minutos só pra eu recuperar o controle, sem gerar
   nenhum resultado utilizável.
2. **Mesmo numa máquina capaz, isto é um projeto de semanas/meses**, não
   algo que cabe numa sessão de chat: portar 8 camadas × ~15 efeitos cada
   (a maioria sem equivalente pronto no JUCE — teria que escrever o DSP de
   bitcrusher/shimmer/phaser/flanger do zero em C++) + os 5 formatos de
   instrumento + round robin/polifonia + MIDI, e ainda trocar o pipeline de
   build/release (hoje gera `.exe`/`.dmg`/`.AppImage` via Tauri+Electron em
   CI) pra compilar binários nativos C++ por SO.
3. O problema real de qualidade de áudio relatado (estalos/distorção) já
   tinha uma causa concreta identificada e corrigida no motor atual (Web
   Audio): um `ScriptProcessorNode` do efeito bitcrusher ficava ligado o
   tempo todo em todas as 8 camadas, mesmo sem o efeito ativado — ver
   changelog da v0.2.47. Migrar pra JUCE não era necessário pra resolver
   esse bug específico.

## Recomendação

Se ainda fizer sentido pra você perseguir uma versão nativa em JUCE no
futuro (por outro motivo, ex.: suporte a plugins VST/AU, menor uso de CPU
geral, etc.), isso precisa ser um projeto separado, feito numa máquina de
desenvolvimento de verdade (com RAM/CPU suficientes — 8GB+ de RAM é o
mínimo razoável pra compilar JUCE com conforto) fora deste fluxo de agente.
Os arquivos desta pasta (`CMakeLists.txt`, `src/`) são um ponto de partida
real caso você queira levar isso adiante em outro ambiente.
