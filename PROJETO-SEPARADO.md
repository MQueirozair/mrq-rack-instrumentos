# MRQ Rack de Instrumentos — projeto separado

Criado a pedido do usuário: dividir o app original (`mrq-multitracks-play`,
que **continua intocado** em `github.com/MQueirozair/mrq-multitracks-play`)
em 3 projetos independentes, cada um instalável/testável sozinho:

1. **MRQ Multitracks Play2** (`mrq-multitracks-play2`) — o player de
   multitracks.
2. **MRQ Rack de Instrumentos** (este projeto) — o rack de instrumentos
   virtuais (SF2/NKI/EXS24/DX7/.mrq, efeitos, pads, teclado virtual).
3. **MRQ Instrument Converter** (`mrq-instrument-converter`) — o conversor
   de formatos de instrumento pro formato próprio `.mrq`.

## Estado atual (ENXUGADO ✅)

Este projeto já foi trimado pra abrir DIRETO no Rack de instrumentos, como
app independente:

- `src/App.tsx` reescrito: sem a barra de navegação original (biblioteca,
  setlist, player, Conversor, etc.) — só `TitleBar` + `MidiBridge` + o Rack
  (`InstrumentRack`) + atalhos de MIDI/Ajuda/Configurações.
- Removido de dentro do próprio `InstrumentRack.tsx` o painel "Música"
  (`RackMusicPanel`), que deixava tocar/pausar a faixa do Setlist sem sair
  da aba — dependia do player de multitracks completo (Setlist/Library/
  PlayerShell), o que ia contra o objetivo de standalone. Quem quiser tocar
  o Rack junto com uma música vai rodar o **MRQ Multitracks Play2** ao lado
  e conectar os instrumentos via MIDI/áudio do sistema operacional.
- Removidos de `src/components/`: tudo exclusivo do player de multitracks
  (`PlayerShell`, `ArrangeEditor`, `TracksView`, `TransportBar`,
  `WaveformCanvas`, `MixerStrip`, `ChordView`, `CountInOverlay`,
  `NextSongPreview`, `PartsGrid`, `SongHeader`, `SongNotes`,
  `TeleprompterOverlay`, `TransitionBanner`, `VisualMetronome`,
  `SetlistPanel`, `LibraryPanel`, `TempoPanel`, `OutputsPanel`, `KeyPanel`,
  `GuideVoicePanel`, `PadWidget`) e tudo exclusivo do Conversor
  (`InstrumentConverter`, `MrqInstrumentAnalyzer`, `MappingEditor`,
  `KontaktCaptureDialog`, `IconRail`). Também removido `src/devPreview/` e
  `vite.preview.config.ts` (harness de pré-visualização específico do
  Conversor). De 40 componentes em `src/components/`, sobraram 14.
- **Mantidos de propósito** (centrais ao Rack ou genéricos/compartilhados):
  `InstrumentRack`, `RackFxModule`, `RackKnob`, `RackEqGraph`,
  `RackMidiPanel`, `MidiBridge` (rotea CCs/notas MIDI físicos pros comandos
  do Rack — volume/mute/solo/octaver por camada, master, pânico — é
  funcionalidade central do Rack, não do player), `MidiPanel` (tela de
  configurar os bindings de MIDI), `TitleBar`, `SessionTimer`,
  `AudioHealthIndicator`, `ChordIndicator`, `SettingsModal`, `HelpPanel`,
  `ErrorBoundary`.
- `src/audio/` e `src/midi/` **não foram tocados** (mesma decisão do
  Conversor): os parsers de formato moram na mesma pasta que o motor de
  reprodução ao vivo do Rack, e os dois projetos precisam deles — real
  deduplicação é tarefa de quando os 3 forem reunidos, não antes.
- Chave de assinatura (Tauri updater) **própria**, gerada só pra este app,
  já cadastrada como secret do GitHub Actions deste repo
  (`TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) e com
  a pubkey/endpoint correspondentes em `src-tauri/tauri.conf.json` apontando
  pra este repositório (não mais pro `mrq-multitracks-play` original). A
  chave privada/senha também ficam anotadas (fora de qualquer repo git) em
  `~/CHAVES-DE-ASSINATURA-TAURI-NAO-COMPARTILHAR.md` nesta sandbox — vale a
  pena salvar em local seguro, já que não tem como recuperar o valor de
  volta do GitHub (secret é write-only).
- Branding corrigido: `package.json` (`productName`, `description`,
  `appId` → `com.mrq.rackinstrumentos`), `src-tauri/tauri.conf.json`
  (título da janela), `index.html` (`<title>`).

### Verificação feita (sem compilar nativo nesta sandbox)

- `npx tsc -b --noEmit` → limpo, sem erros.
- `npm run build:renderer` (mesmo comando que o workflow "Release (Tauri)"
  roda antes de empacotar) → build limpo, ~668 KB de JS (contra ~846 KB do
  app completo).
- `npm run test:mrq-rack` (testes de `MrqLayerVoice.ts`, o motor de
  reprodução por trás das camadas do Rack) → todos passando.
- **Não** foi tentado build nativo Tauri/Rust nesta sandbox (sem
  `cargo`/`rustc`/`webkit2gtk` instalados). A verificação definitiva do
  instalador real depende do GitHub Actions deste repo — já com os secrets
  de assinatura cadastrados, então o workflow "Release (Tauri)" deve
  conseguir rodar até o fim quando for disparado (ex.: criando uma tag).

## Próximos passos

1. Fazer o mesmo trabalho de enxugamento no `mrq-multitracks-play2`
   (manter o player de multitracks, remover Rack e Conversor).
2. Disparar o workflow "Release (Tauri)" (ex.: tag `v0.1.0`) em cada um dos
   3 repositórios pra confirmar que os instaladores reais (Windows/macOS/
   Linux) saem funcionando — é a validação final que esta sandbox não
   consegue fazer sozinha.
3. Depois que os 3 projetos estiverem cada um 100% funcionando de forma
   independente, planejar como reunir os 3 de volta (como módulos/peças de
   um só produto, se der certo).

## Nota de verificação (passagem adicional)

Revisei este projeto depois do trim acima (feito numa execução anterior/
paralela desta mesma tarefa) e confirmei que está tudo consistente:
`tsc --noEmit` limpo, `vite build` limpo, testes automatizados de formato
(SF2/NKI/EXS/SYX/Kontakt/MrqLayerVoice) todos passando, sem nenhum import
quebrado apontando pra arquivo removido. Só faltava corrigir 2 referências
esquecidas ao nome do repositório original no caminho legado do Electron
(`package.json` > `build.publish.repo` e `electron/main.ts` >
`UPDATE_REPO_NAME`) — corrigidas agora.

**Aviso sobre a chave de assinatura:** os secrets `TAURI_SIGNING_PRIVATE_KEY`
e `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` já estão cadastrados neste
repositório (confirmado via API) e a `pubkey` em `tauri.conf.json` parece
corresponder a eles (só um conjunto de secrets existe, sem sinal de
sobrescrita posterior). Só não tenho uma cópia local de backup dessa chave
privada nesta sandbox (foi gerada por uma sessão/sandbox diferente) — se
algum dia precisar trocar, gere um par novo com `npx @tauri-apps/cli@2
signer generate` e atualize os dois secrets + a `pubkey` juntos (do
contrário o updater do app vai rejeitar os releases assinados).
