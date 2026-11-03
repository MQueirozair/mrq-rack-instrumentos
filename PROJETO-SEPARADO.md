# MRQ Rack de Instrumentos — projeto separado

Criado a pedido do usuário: dividir o app original (`mrq-multitracks-play`,
que **continua intocado** em `github.com/MQueirozair/mrq-multitracks-play`)
em 3 projetos independentes, cada um instalável/testável sozinho:

1. **MRQ Multitracks Play2** (`mrq-multitracks-play2`) — o player de
   multitracks.
2. **MRQ Rack de Instrumentos** (este projeto) — o rack de instrumentos
   virtuais (SF2/NKI/EXS24/DX7/.mrq, efeitos, pads).
3. **MRQ Instrument Converter** (`mrq-instrument-converter`) — o
   conversor de formatos de instrumento pro formato próprio `.mrq`.

## Estado atual (ENXUGADO ✅)

Este projeto já foi trimado pra abrir DIRETO no Rack de instrumentos,
como app independente:

- `src/App.tsx` reescrito: sem a barra de navegação original (biblioteca,
  setlist, player, Conversor) — só `TitleBar` + `MidiBridge` + o Rack
  (`InstrumentRack`) + atalho de Ajuda/Configurações.
- Removidos de `src/components/`: todas as telas exclusivas do player de
  multitracks (`PlayerShell`, `TracksView`, `MixerStrip`, `ArrangeEditor`,
  `ChordView`, `CountInOverlay`, `NextSongPreview`, `SongHeader`,
  `SongNotes`, `TeleprompterOverlay`, `TransitionBanner`, `SetlistPanel`,
  `LibraryPanel`, `TempoPanel`, `OutputsPanel`, `KeyPanel`,
  `GuideVoicePanel`, `MidiPanel`, `AudioWatchdog`, `PadWidget`,
  `IconRail`) e do Conversor (`InstrumentConverter`,
  `MrqInstrumentAnalyzer`, `MappingEditor`, `KontaktCaptureDialog`). De 36
  componentes em `src/components/`, sobraram 16. Também removido o
  harness de pré-visualização do Conversor (`src/devPreview/`,
  `dev-preview.html`, `vite.preview.config.ts`, script `dev:preview`) —
  é específico do outro projeto.
- **Mantidos de propósito**: `TitleBar`, `SessionTimer`,
  `AudioHealthIndicator`, `ChordIndicator`, `RackMidiPanel`,
  `SettingsModal`, `HelpPanel`, `ErrorBoundary`, `InstrumentRack` (o
  próprio Rack) e as peças que ELE usa: `RackFxModule`, `RackKnob`,
  `RackEqGraph`. **`MidiBridge` foi mantido de propósito** (diferente do
  projeto do Conversor): é ele quem liga um teclado/controlador MIDI
  físico aos comandos do Rack (volume/mute/solo/octaver por camada,
  pânico — ver os casos `rack:*` dentro dele); sem ele só o teclado
  virtual na tela funciona.
- `InstrumentRack.tsx` (2796 linhas) **não foi editado** — ele próprio
  importa `TransportBar` e `PartsGrid` pra um painel secundário
  ("Música", dentro da aba Rack) que deixa tocar/pausar uma música do
  Setlist sem sair da tela do Rack. Sem Biblioteca/Setlist nesta versão,
  esse painel fica inofensivo (mostra "Nenhuma música carregada") — não
  valia o risco de editar um arquivo desse tamanho só pra remover um
  painel secundário que já degrada bem sozinho. `TransportBar` por sua
  vez precisa de `VisualMetronome` (restaurado) — `TracksView.tsx` foi
  removido por não ser usado por nada aqui.
- `src/audio/` e `src/midi/` **não foram tocados** (mesma decisão do
  projeto do Conversor): o Rack e o Conversor compartilham os mesmos
  parsers de formato (`mrqFormat.ts`, `exsImport.ts`, etc.) dentro de
  `src/audio/rack/` — deduplicar é tarefa de quando os 3 projetos forem
  reunidos, não antes.
- Branding corrigido: `package.json` (`productName`, `description`,
  `appId` → `com.mrq.rackinstrumentos`), `src-tauri/tauri.conf.json`
  (título da janela + endpoint/chave do auto-updater), `index.html`
  (`<title>`).
- **Chave de assinatura própria**: gerei um par de chaves Tauri novo
  (exclusivo deste projeto, não o do app original) e cadastrei a privada
  como secret do GitHub Actions deste repo (`TAURI_SIGNING_PRIVATE_KEY` /
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) — sem isso o workflow "Release
  (Tauri)" falharia na etapa de assinatura. O endpoint do updater em
  `tauri.conf.json` também foi corrigido pra apontar pra este repo (antes
  ainda apontava pro `mrq-multitracks-play` original).

### Verificação feita (sem compilar nativo nesta sandbox)

- `npx tsc -b --noEmit` → limpo, sem erros.
- `npm run build:renderer` (= `tsc --noEmit && vite build`, o MESMO
  comando que o workflow "Release (Tauri)" roda antes de empacotar) →
  build limpo, ~671 KB de JS (contra ~846 KB do app completo).
- Testes automatizados relevantes ao Rack, todos passando: `test:syx`,
  `test:nki`, `test:exs`, `test:mrq-rack`, `test:sf2-sanitize`,
  `test:kontakt-capture`.
- Smoke-test visual via `vite dev` (preview ao vivo) → app abre, título
  certo, sem crash.
- **Não** foi tentado build nativo Tauri/Rust nesta sandbox (sem
  `cargo`/`rustc`/`webkit2gtk` instalados). A verificação definitiva do
  instalador real (Windows/macOS/Linux) depende do GitHub Actions deste
  repo, que agora já tem a chave de assinatura própria cadastrada.

## Próximos passos

1. Fazer o mesmo trabalho de enxugamento no `mrq-multitracks-play2`
   (manter o player, remover o Rack e o Conversor).
2. Depois que os 3 projetos estiverem cada um 100% funcionando de forma
   independente (instalador próprio rodando via CI de cada repo), o
   usuário pediu pra planejarmos juntar os 3 de volta (como módulos/peças
   de um só produto, se der certo).
