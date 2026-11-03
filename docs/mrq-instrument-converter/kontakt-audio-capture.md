# Kontakt Audio Capture

> Fluxo opcional dentro do **MRQ Instrument Converter** existente (não é um
> segundo conversor) para transformar instrumentos Kontakt que **não podem
> ser abertos diretamente** (`.nki` criptografado de biblioteca comercial —
> ver `nkiImport.ts`) num instrumento `.mrq`, a partir de arquivos de áudio
> já **renderizados pelo próprio Kontakt** por um usuário com acesso legítimo
> ao instrumento original.

## 1. O que este fluxo É e NÃO É

**É:** um importador de amostras de áudio (WAV/AIFF/FLAC/MP3/OGG) com
heurísticas de organização (nome de nota/velocidade/round-robin a partir do
nome do arquivo) que monta um `MrqInstrumentModel` comum e grava um `.mrq`
pelo mesmo pipeline genérico de todo o resto do conversor.

**NÃO é:**
- Um decodificador, descompactador ou "quebrador" de `.nki`. Nenhum arquivo
  `.nki` é lido, aberto ou tocado por este fluxo — ele nunca vê o instrumento
  Kontakt original, só os WAVs que o usuário já exportou dele.
- Uma forma de contornar proteção/DRM de biblioteca comercial. A proteção do
  `.nki` (ver `NkiLayerVoice.ts` / `checkKnownUnsupportedExtension`)
  permanece exatamente como estava — este fluxo não a toca.
- Uma recuperação da estrutura interna do instrumento Kontakt: scripts KSP,
  efeitos/DSP proprietários, modulações, envelopes e pontos de loop do
  patch original **não são e não podem ser** recuperados a partir do áudio
  já renderizado. O que sai do Kontakt como um WAV de 5 segundos carrega só
  aquilo — nada do script que o gerou.

A tela deixa isso explícito num aviso fixo, e o `.mrq` gerado carrega um
`MrqCompatibilityReport` honesto (`preserved`/`approximated`/`unsupported`)
documentando exatamente esses limites — o mesmo padrão de relatório usado
por todos os outros importadores (SF2, NKI, SYX, NPNO).

## 2. Por que a captura funciona (e quando ela não é suficiente)

- **Funciona bem** para instrumentos relativamente simples (poucas
  articulações, poucos round-robins) onde o usuário consegue renderizar
  manualmente as combinações de nota/velocidade/articulação relevantes.
- **Qualidade depende inteiramente do que foi renderizado**: se só 3 notas
  foram exportadas, o instrumento final só soa bem nessas 3 notas (mais a
  interpolação de pitch que o Rack já faz pra qualquer sampler). Se nenhuma
  velocidade alta foi capturada, não existe "velocidade alta" no resultado.
- **Não é viável** para bibliotecas com scripts KSP complexos (ex.:
  legato real, humanização por script, efeitos condicionais) — o resultado
  é sempre "amostra estática reproduzida", nunca o comportamento de script
  do patch original.

## 3. Arquitetura — reaproveitamento, não duplicação

| Peça | Reaproveitada de | Observação |
|---|---|---|
| Decodificação de áudio (WAV/AIFF/FLAC/MP3/OGG → PCM) | `src-tauri/src/importers/audio_file.rs` (`symphonia`) | Mesmo decodificador do importador de áudio avulso já existente; `kontakt_capture.rs` só adiciona uma camada fina por cima (probe + hash + anexar a uma sessão multi-amostra). |
| Escrita do `.mrq` (FLAC, hashes, índice, metadados) | `src-tauri/src/mrq/writer.rs` + sessão `mrqBuilderBegin`/`mrqBuilderFinish` | Mesmo pipeline binário que SF2, NKI, SYX e NPNO já usam — nenhuma mudança no formato `.mrq`. |
| Modelo de dados (`MrqInstrumentModel`, `MrqGroup`, `MrqZone`) | `src/audio/rack/mrqFormat.ts` | Reaproveitado sem alteração estrutural — só um novo valor de tag `sourceFormat: 'kontakt-capture'` (aditivo, não quebra nenhum `match`/leitor existente). |
| Reprodução no Rack | `MrqLayerVoice` | Um `.mrq` gerado por este fluxo carrega e toca exatamente como qualquer outro `.mrq` — inclusive round robin, faixas de tecla/velocidade e grupos de exclusividade (`exclusiveGroup`, mesma limitação documentada de "não dá choke automático ainda" do SF2/SF3). |
| Orquestração frontend (begin → add em loop → finish/abort) | Padrão de `src/audio/rack/syxImport.ts` | `runKontaktCapture` em `kontaktCapture.ts` segue literalmente a mesma forma. |
| UI do conversor (fila, inspetor, analyzer) | `InstrumentConverter.tsx` / `MrqInstrumentAnalyzer.tsx` | O novo botão "Importar instrumento renderizado pelo Kontakt…" abre um modal (`KontaktCaptureDialog.tsx`) e, ao confirmar, injeta um item **já convertido** na mesma fila — mesmo inspetor, mesma pré-escuta. |

### Arquivos novos/alterados

- `src-tauri/src/importers/kontakt_capture.rs` **(novo)** — `probe()` (lê
  metadados + hash SHA-256 do PCM sem gravar nada) e
  `add_sample_to_session()` (decodifica e anexa 1 amostra a uma sessão
  `.mrq` já aberta). 7 testes unitários.
- `src-tauri/src/importers/commands.rs` — dois comandos Tauri finos
  (`mrq_capture_probe_audio_file`, `mrq_capture_add_sample`) que só chamam
  as funções acima.
- `src-tauri/src/mrq/model.rs` — `MrqSourceFormat::KontaktCapture` (variante
  aditiva, serializa como `"kontakt-capture"`).
- `src/audio/rack/midiNoteNames.ts` — `noteNameToMidi()`, inverso de
  `midiNoteName()` já existente (mesma convenção C3=60), usado pra
  reconhecer nota pelo nome do arquivo.
- `src/audio/rack/kontaktCapture.ts` **(novo)** — toda a lógica pura
  (heurística de nome de arquivo, faixas automáticas de tecla/velocidade,
  detecção de duplicados, montagem do modelo + relatório) e a orquestração
  real. Testado isoladamente em `scripts/test-kontakt-capture.mjs`
  (`npm run test:kontakt-capture`).
- `src/components/KontaktCaptureDialog.tsx` **(novo)** — modal de
  mapeamento (grade editável, pré-escuta nativa via `<audio>`, aviso de
  transparência fixo, badges de detecção automática/manual/duplicado).
- `src/components/InstrumentConverter.tsx` — novo botão de entrada, novo
  campo opcional `captureKind` em `QueueItem`, ajustes de rótulo/guarda de
  botão pra itens vindos deste fluxo (que já nascem convertidos).
- `src/styles/theme.css` — variante `.modal.wide` + bloco `.kc-*` de estilo
  da grade de mapeamento.

## 4. Fluxo de uso

1. Na tela do conversor, clicar em **"Importar instrumento renderizado pelo
   Kontakt…"**.
2. Escolher arquivos avulsos ou uma pasta inteira (reaproveita
   `scan_folder_tracks`, o mesmo comando já usado pra importar pastas de
   faixas de música).
3. Cada arquivo é sondado em paralelo no backend Rust (duração, taxa de
   amostragem, canais, hash) e tem seu nome analisado por heurística —
   badges "auto"/"manual" deixam claro o que foi detectado vs. o que ficou
   no padrão.
4. Arquivos com conteúdo de áudio idêntico (mesmo hash) são sinalizados
   como possível duplicata.
5. O usuário ajusta grupo/camada, nota raiz, faixa de tecla, faixa de
   velocidade, round robin e grupo de exclusividade livremente, ou clica em
   **"Aplicar mapeamento automático"** pra recalcular faixas contíguas de
   tecla/velocidade por grupo a partir das notas/velocidades já definidas.
6. Cada amostra pode ser auditada (reprodução nativa do navegador/WebView
   via `<audio>`, sem round-trip pelo decodificador Rust).
7. Ao confirmar, escolhe-se onde salvar o `.mrq`; o modelo é montado
   (`buildCaptureInstrumentModel`) e gravado pelo pipeline padrão
   (`runKontaktCapture`), com barra de progresso por amostra.
8. O item aparece na fila do conversor já como "convertido", pronto pra
   inspecionar no MRQ Instrument Analyzer ou carregar direto no Rack.

## 5. Compatibilidade

- **Tauri Windows/macOS**: usa só `@tauri-apps/plugin-dialog` (já usado por
  todo o resto do conversor) e os dois comandos Rust novos — sem nenhuma
  API específica de plataforma.
- **WebView antigo do macOS**: a grade de mapeamento usa só HTML/CSS/JS
  simples (sem recursos ES2020+ arriscados) e a pré-escuta usa `<audio>`
  nativo, não `decodeAudioData` em lote.
- **Electron**: a tela do conversor inteira (`InstrumentConverter.tsx`) já é
  bloqueada fora do Tauri (`isTauriRuntime()`), então este fluxo herda essa
  mesma limitação — nenhuma mudança de comportamento no build Electron.
- **Operações pesadas (decodificação, hashing, FLAC)**: inteiramente no
  Rust, por caminho de arquivo — nenhum PCM grande atravessa a ponte do
  WebView como JSON, em nenhum sentido.

## 6. Testes automatizados

- `cargo test` (dentro de `src-tauri/`) — 58/58, incluindo os 7 testes
  novos de `kontakt_capture.rs` (probe determinístico, hash estável,
  detecção de arquivo corrompido, montagem completa de instrumento com 2
  amostras, falha limpa quando uma amostra referenciada não é anexada).
- `npm run test:kontakt-capture` — heurística de nome de arquivo (notas com
  nome/número, velocidade por prefixo/sufixo, round robin explícito e por
  sufixo de letra, nomes sem padrão nenhum), faixas automáticas de
  tecla/velocidade (contíguas, sem sobreposição, escopadas por grupo),
  round robin (mesma nota+velocidade dentro do mesmo grupo vira round robin;
  grupos diferentes nunca se misturam), detecção de duplicados e montagem do
  `MrqInstrumentModel`/relatório de compatibilidade (incluindo a garantia de
  que o relatório nunca afirma recuperar a estrutura original do Kontakt).
- `npx tsc --noEmit` — projeto inteiro, sem erros após todas as alterações.

**Pendente (recomendado, não bloqueante):** validação manual de build em
Windows e macOS reais (o ambiente de desenvolvimento atual é Linux) — a
lógica foi escrita sem nenhuma API específica de plataforma nova além das já
usadas pelo resto do conversor, mas uma validação final nos binários
empacotados de cada SO fica como próximo passo recomendado ao usuário.
