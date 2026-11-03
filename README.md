# MRQ - Multitracks Play

Tocador de multitracks ao vivo para banda/culto — toca cada faixa de uma
música separadamente (bateria, baixo, teclado, voz guia, click...), com
controle total de mixagem, roteiro de arranjo, cifra com transposição
automática, rack de instrumentos virtuais tocáveis por MIDI e muito mais.
Feito pra ser operado ao vivo, no palco, sem depender de internet.

Aplicativo de desktop (Windows, macOS e Linux), com interface em
português.

## Principais funcionalidades

- **Biblioteca** — importar músicas e organizar o acervo de multitracks.
- **Lista (Cenas / Setlist)** — montar a ordem das músicas de um show,
  culto ou ensaio.
- **Arranjar** — marcar as partes da música (Intro, Verso, Refrão...) e o
  roteiro de execução.
- **Faixas (mixer)** — ver a forma de onda de cada faixa separadamente e
  ajustar volume, mudo e solo.
- **Tempo** — click/metrônomo, fórmula de compasso e modo de ensaio em
  velocidade reduzida.
- **Cifra** — colar a cifra da música e acompanhar com transposição
  automática.
- **Saídas** — rotear cada faixa pra um par de canais da interface de
  áudio.
- **Tom** — escolher quais faixas acompanham a transposição de tom.
- **Voz guia** — faixa de referência que anuncia as partes da música.
- **MIDI / Pad contínuo** — controlar o roteiro da música com um
  controlador MIDI físico.
- **Rack de instrumentos** — até 7 instrumentos virtuais tocáveis ao vivo
  por um teclado MIDI físico, por cima da multitrack. Suporta várias
  bibliotecas de amostra/síntese importadas diretamente (SoundFont `.sf2`/
  `.sf3`, Yamaha DX7 `.syx`, Nord `.npno`/`.nsmp`, Kontakt `.nki`, além do
  formato leve nativo `.mrq`/`.mrqi`).
- **MRQ Instrument Converter** — tela dedicada pra inspecionar e converter
  instrumentos de outros formatos pro `.mrq` nativo (mais leve e rápido de
  carregar), com relatório de compatibilidade honesto sobre o que foi
  preservado, aproximado ou não suportado em cada conversão.
- **Controle remoto pelo celular** — controlar o transporte da música a
  partir de um navegador no celular, na mesma rede Wi-Fi.
- **OSC / MRQ Sync** — ponte OSC com software externo de produção, e
  sincronismo entre instâncias do MRQ na rede.
- **Modo Palco** — tema de alto contraste e fontes maiores para telas em
  ambientes com pouca luz.
- **Backup** — exportar e restaurar toda a biblioteca e as configurações
  do app.
- **Atualizações automáticas** — o app se atualiza sozinho.

## Tecnologia

- **Frontend**: React + TypeScript + Vite.
- **Casca nativa**: migração em andamento de Electron para
  [Tauri](https://tauri.app/) (Rust) — o alvo atual de release é Tauri
  (`src-tauri/`); o diretório `electron/` ainda existe para compatibilidade
  com a base de usuários em versões anteriores.
- **Áudio**: Web Audio API no frontend; decodificação/parsing de formatos
  binários (SoundFont, DX7 syx, Nord, Kontakt, WAV/FLAC/MP3/OGG) feita em
  Rust no backend Tauri para arquivos grandes, com fallback em
  WebAssembly/JS puro quando faz sentido.

## Scripts principais

```bash
npm install

# desenvolvimento (Electron, legado)
npm run dev:electron

# build de produção (renderer + electron)
npm run build

# instaladores Windows/macOS (electron-builder, legado)
npm run dist:win
npm run dist:mac

# typecheck de todo o projeto (referências TS)
npm run lint

# suíte de testes (Node, sem navegador)
npm run test:parts
npm run test:syx
npm run test:nki
npm run test:mrq-rack
npm run test:kontakt-capture
```

Para o lado Tauri (`src-tauri/`), use os comandos padrão do Tauri CLI
(`cargo tauri dev` / `cargo tauri build`) a partir da raiz do projeto, ou
`cargo check` / `cargo test` dentro de `src-tauri/` pra validar só o
backend Rust.

## Releases

Os instaladores oficiais (Windows `.exe`, macOS `.dmg`/universal, Linux
`.AppImage`/`.deb`/`.rpm`) são gerados automaticamente pelo GitHub Actions
(`.github/workflows/release-tauri.yml`) a cada tag `v*` enviada, e ficam
disponíveis como rascunho nos [Releases](../../releases) do repositório
até serem publicados.

## Documentação adicional

A pasta [`docs/`](./docs) reúne relatórios técnicos e de arquitetura
escritos ao longo do desenvolvimento, organizados por assunto — veja o
[índice em `docs/README.md`](./docs/README.md) (arquitetura do MRQ
Instrument Converter, captura de áudio Kontakt, revisões técnicas e
relatórios de versões antigas).
