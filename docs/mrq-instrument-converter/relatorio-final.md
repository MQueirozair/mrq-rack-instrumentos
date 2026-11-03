# Relatório Final — MRQ Instrument Converter (Fases 1 a 10)

**Data do relatório:** 31/10/2026
**Branch:** `main` — commit mais recente: `d0ae91d`
**Versão do app:** 0.2.36

Este documento resume tudo o que foi feito no projeto "MRQ Instrument Converter": um conversor de instrumentos de sample/síntese de formatos de terceiros (SoundFont, Nord, DX7, Kontakt, áudio avulso) para o formato próprio `.mrq`, com reprodução integrada ao Rack de instrumentos do MRQ - Multitracks Play.

---

## 1. Visão geral do que foi construído

| # | Entregável | Status |
|---|---|---|
| 1 | Documento de arquitetura (`mrq-converter-architecture.md`) | ✅ Fechado |
| 2 | Formato de arquivo `.mrq` + backend Rust (empacotar/ler/validar) | ✅ Fechado |
| 3 | Importador SoundFont (`.sf2`/`.sf3`) | ✅ Fechado |
| 4 | Importador Nord (`.npno`/`.nsmp`/`.nsmp3`/`.nsmp4`) | ✅ Fechado |
| 5 | Importador DX7 (`.syx`) + renderização opcional de amostras | ✅ Fechado |
| 6 | Importador Kontakt (`.nki`, versões 1-4 sem criptografia) | ✅ Fechado |
| 7 | Importador de áudio avulso (`.wav`/`.aiff`/`.flac`/`.mp3`/`.ogg`) | ✅ Fechado |
| 8 | Página "MRQ Instrument Converter" + MRQ Instrument Analyzer (UI) | ✅ Fechado |
| 9 | Integração com o Rack (`MrqLayerVoice.ts`, toca `.mrq` direto) | ✅ Fechado |
| 10 | Revisão de compatibilidade Windows/macOS + builds nativos reais | ✅ Fechado (testes manuais em máquina real pendentes — ver seção 8) |

**Números do projeto inteiro (Fase 2 até agora):** 15 commits, 67 arquivos tocados, ~8.750 linhas adicionadas, ~30 removidas.

---

## 2. O formato `.mrq` (Fase 2)

Um contêiner binário próprio, desenhado para ser lido/escrito de forma seguro e idêntico em Windows/macOS/Linux:

```
offset 0        [4 bytes]  magic "MRQ1"
offset 4        [4 bytes]  versão do formato (u32, little-endian)
offset 8        [8 bytes]  tamanho do bloco de metadados (u64, little-endian)
offset 16       [N bytes]  metadados: JSON UTF-8 (presets, zonas, envelope, filtro, índice de amostras)
offset 16+N     [...]      amostras de áudio codificadas em FLAC, concatenadas
EOF - 32        [32 bytes] SHA-256 de tudo antes deste bloco (autoconferência de integridade)
```

**Escrita seguravel:** o `writer.rs` grava um arquivo temporário completo **na mesma pasta** do destino final (não na pasta temporária do sistema — evita o erro de "mover entre discos diferentes" no Windows), recalcula o hash do zero, confere a integridade, e só então promove o arquivo por cima do destino com um rename atômico. Se a autoconferência falhar, nada é escrito — o destino original (se existir) nunca fica corrompido no meio do caminho.

**Bibliotecas usadas** (todas puro Rust, sem dependência de toolchain C, licenças verificadas antes de cada uso):
- `flacenc` / `claxon` (codificação/decodificação FLAC) — Apache-2.0
- `sha2` (SHA-256) — MIT OR Apache-2.0
- `tempfile` (escrita atômica) — MIT OR Apache-2.0
- `soundfont` (parser SF2/SF3) — MIT
- `lewton` (decodificador Ogg/Vorbis, pras amostras comprimidas de `.sf3`) — MIT OR Apache-2.0
- `nord-format` (decodificador Nord nativo, separado da versão wasm usada só na reprodução ao vivo) — BSD-3-Clause
- `symphonia` (decodificador de áudio avulso) — MPL-2.0

---

## 3. Os importadores (Fases 3 a 7)

Cada importador segue o mesmo padrão: **inspecionar** (ler metadados sem decodificar áudio, rápido) e **converter** (decodificar tudo e gravar um `.mrq`), sempre devolvendo um **relatório de compatibilidade** honesto (`preserved` / `approximated` / `unsupported`) — nunca finge que converteu 100% quando não converteu.

| Formato | O que foi mapeado | Observações técnicas |
|---|---|---|
| **SoundFont (.sf2/.sf3)** | Presets, instrumentos, zonas, os ~60 generators do spec, modulators, envelope/filtro | `ExclusiveClass` → campo `exclusiveGroup`, reportado como `Approximated`. Blindado contra um bug de panic da crate `soundfont` 0.1.0 em arquivos malformados (ver seção 7 — lições aprendidas) |
| **Nord (.npno/.nsmp/.nsmp3/.nsmp4)** | Biblioteca de piano (camadas de velocity por "golpe de ataque") e amostra avulsa | Reaproveita o decodificador `nord-format`, mas como dependência **nativa** separada da versão wasm (usada só na reprodução ao vivo no Rack) — importadores nunca atravessam o WebView |
| **DX7 (.syx)** | Bancos de 32 vozes, com renderização opcional de notas representativas pra virarem amostras reais | Pipeline de render feito num artefato esbuild separado (`Dx7OfflineRender.ts`), sem depender de BigInt no bundle principal |
| **Kontakt (.nki, v1-4)** | Zonas (tecla/velocity/afinação/volume/pan), reaproveitando o parser XML já existente no Rack | `.nkx`/`.nkc`/`.nkb`/`.nkm` (bibliotecas protegidas/criptografadas) são **rejeitados explicitamente** com erro claro — nunca se tenta "forçar" um parsing fadado ao fracasso (ver seção 6 do documento de arquitetura: limite técnico e legal real, não só de esforço). Amostras em `.ncw` (codec proprietário sem decoder no navegador) entram no relatório como `unsupported` com o motivo real, não um erro genérico |
| **Áudio avulso (.wav/.aiff/.flac/.mp3/.ogg)** | Um único instrumento/zona cobrindo o teclado inteiro | Usa `symphonia` uniformemente pros 5 formatos |

---

## 4. Interface: Conversor + MRQ Instrument Analyzer (Fase 8)

Nova página no app (`InstrumentConverter.tsx`), só visível na versão Tauri (ver seção 5):

- Fila de conversão com status por item (inspecionando → inspecionado → convertendo → convertido/erro)
- **MRQ Instrument Analyzer** (`MrqInstrumentAnalyzer.tsx`, ~1.000 linhas): inspetor visual com abas — visão geral, mapa de teclado/velocity, envelope/filtro, amostras, comparação **Original vs. MRQ** lado a lado — só habilitada quando há dados reais dos dois lados (nunca mostra comparação inventada)
- Pré-escuta de amostras direto na interface, sem decodificar nada pesado no WebView (toda decodificação acontece no backend Rust via `mrq_extract_sample`)

---

## 5. Integração com o Rack (Fase 9) + correção cruzada Tauri/Electron

Nova camada `MrqLayerVoice.ts` (337 linhas) permite carregar um `.mrq` direto numa camada do Rack, ao lado dos formatos que já existiam (SF2, DX7, NPNO, NKI, SFZ, `.mrqi`):

- Decodifica cada amostra sob demanda via `mrq_extract_sample` (Rust), com até 6 decodificações em paralelo e falha por amostra não-fatal
- Implementa **round robin** (alterna entre zonas do mesmo grupo a cada nota) e **pan estéreo** para pares de amostra mono esquerda/direita (comum em SoundFonts estéreo)
- Deliberadamente **não** reimplementa envelope/filtro/exclusive-group — isso já é tratado de forma genérica pelo `RackEngine` para toda camada, igual às demais

**Correção cruzada encontrada nesta fase:** a página do Conversor e o formato `.mrq` dependem de comandos Rust exclusivos do backend Tauri — **não existe equivalente no Electron**. O item de navegação estava aparecendo também em builds Electron, o que quebraria ao tentar usar o seletor de arquivo. Corrigido:
- Novo `src/runtimeEnv.ts` com `isTauriRuntime()`
- Item "Conversor" só aparece no menu quando `isTauriRuntime()` é verdadeiro
- Guarda extra dentro do próprio componente (mostra aviso em PT-BR em vez de quebrar, se for aberto de outra forma)
- `electron/main.ts`/`electron/preload.ts` foram deliberadamente **não** alterados — usuários Electron nunca devem ver `.mrq` no seletor nativo deles

---

## 6. Fase 10 — Revisão de compatibilidade + builds nativos reais

### 6.1 Revisão técnica (Windows/macOS/Linux)

Checklist completo revisado: separadores de caminho, nomes reservados do Windows, sensibilidade a maiúsculas/minúsculas, permissões de sistema de arquivos, dependências Rust nativas, WASM/codecs, Tauri/WebView2/WKWebView, integridade de importação/exportação/reprodução do `.mrq`.

**Único problema real encontrado, com evidência concreta:**
`NkiLayerVoice.resolveSample()` (usado tanto na reprodução ao vivo de `.nki` quanto no importador da Fase 6) só tentava candidatos com a capitalização **exata** gravada dentro do `.nki`. Em Windows/macOS (sistemas de arquivos case-insensitive por padrão) isso nunca dava problema. No **Linux** (case-sensitive), uma biblioteca perfeitamente válida falhava silenciosamente se a capitalização divergisse do nome real do arquivo (cenário comum em bibliotecas reempacotadas entre sistemas operacionais).

**Correção aplicada** (commit `d0ae91d`):
- Novo comando Tauri `fsops::list_dir_entry_names` (+ 2 testes unitários) — lista nomes de arquivos/pastas de um diretório
- Equivalente Electron: IPC `fs:listDirNames` (`electron/main.ts`/`preload.ts`) — `NkiLayerVoice.ts` é compartilhado pelos dois shells
- `NkiLayerVoice.resolveSample()`: tenta os candidatos exatos primeiro (comportamento 100% preservado quando já funcionava); só cai no fallback case-insensitive, nível por nível, se todos falharem

**Demais itens do checklist:** nenhum problema encontrado (detalhes completos na seção "Problemas encontrados" do relatório anterior, preservados abaixo em formato resumido):
- Separadores de caminho: já normalizados consistentemente em todo o projeto
- Nomes de arquivo: IDs de amostra são sempre programáticos; nomes sugeridos nos diálogos de salvar vêm do arquivo original, nunca de texto livre
- Permissões: comandos Rust próprios, deliberadamente fora do escopo do plugin `tauri-plugin-fs` (mesmo padrão já usado antes)
- Dependências Rust: 100% puro Rust nos importadores, sem toolchain C — confirmado empiricamente pelos builds reais (seção 6.2)
- WASM: nenhum WASM novo introduzido; o único pré-existente (`nord-format` na reprodução ao vivo) já teve seu problema de compatibilidade corrigido antes desta feature (v0.2.34)
- WebView: nenhuma API moderna sensível a versão foi introduzida; `MrqLayerVoice` não usa `AudioWorklet`
- Integridade do `.mrq`: formato totalmente independente de plataforma (little-endian explícito, autoconferência antes de gravar), 45/45 testes Rust cobrindo round-trip de cada importador

**Limitações pré-existentes notadas (não são bugs desta fase, não corrigidas — fora de escopo):**
- Build de macOS não é assinado/notarizado (sem Apple Developer ID) — vale pra todos os releases do projeto, não só este
- Decodificação de `.nki` usa `DecompressionStream`, que exige WebKit mais novo (macOS 13+) que o piso mínimo anunciado (macOS 10.15) — herdado de código anterior a este projeto

### 6.2 Builds nativos reais (workflow_dispatch)

Disparei manualmente o workflow `release-tauri.yml` (não um push de tag — execução manual, a partir do commit `d0ae91d`, com a correção já incluída):

| Plataforma | Runner (confirmado via API) | Resultado |
|---|---|---|
| Windows | `windows-latest` | ✅ Sucesso — `MRQ.Multitracks.Play_0.2.36_x64-setup.exe` |
| macOS universal (Intel + Apple Silicon) | `macos-latest`, `--target universal-apple-darwin` | ✅ Sucesso — `MRQ.Multitracks.Play_0.2.36_universal.dmg` |
| Linux | `ubuntu-22.04` | ✅ Sucesso — `.deb`/`.rpm`/`.AppImage` |

Release mantido como **rascunho** (draft), não publicado, não visível a usuários nem ao auto-updater.

**Importante, dito explicitamente para não gerar falsa segurança:** compilar e empacotar com sucesso **não equivale a testar o app rodando numa máquina Windows ou macOS real**. Ninguém executou os instaladores numa máquina física/VM ainda — ver checklist de testes manuais na seção 8.

---

## 7. Lições aprendidas / bugs corrigidos ao longo do caminho

Durante o desenvolvimento das Fases 2-10, alguns problemas reais foram encontrados e corrigidos (não só nesta última rodada):

1. **Crate `soundfont` 0.1.0 tem bugs de panic em arquivos malformados** (Fase 3) — blindado com tratamento defensivo em vez de deixar o processo abortar.
2. **`Entity::Bundle` do `nord-format` exige uma feature não habilitada** (Fase 4) — corrigido o código que assumia disponibilidade da feature.
3. **Loop infinito em decodificação de áudio truncado/corrompido** (Fase 7) — o loop de decodificação de pacotes do `symphonia` podia nunca sinalizar EOF num WAV truncado; corrigido com um contador de erros consecutivos com teto, convertendo em erro estruturado em vez de travar.
4. **Nav do Conversor aparecia em builds Electron** (Fase 9) — corrigido escondendo o item fora do Tauri.
5. **Resolução de amostra `.nki` sensível a maiúsculas/minúsculas** (Fase 10) — corrigido com fallback case-insensitive.

---

## 8. Checklist de testes manuais pendentes (máquinas reais)

**Windows:**
- [ ] Instalar o `.exe` gerado, confirmar que abre sem erro
- [ ] Abrir a página "Conversor" e converter um `.sf2`/`.sf3`, `.npno`/`.nsmp`, `.syx`, `.nki` e um áudio avulso reais
- [ ] Carregar o `.mrq` resultante como camada no Rack e tocar notas (afinação, volume, pan, loop, round robin se aplicável)
- [ ] Carregar um `.nki` real com pasta de amostras ao lado

**macOS:**
- [ ] Baixar o `.dmg` universal — liberar no Gatekeeper antes de abrir (botão direito → Abrir, ou Preferências → Segurança)
- [ ] Repetir os testes de conversão/Rack acima
- [ ] Testar em um Mac Intel **e** um Apple Silicon
- [ ] Se possível, testar numa versão mais antiga do macOS (10.15–12.x) para confirmar o fallback de áudio e documentar a limitação conhecida de `.nki`/`DecompressionStream`

**Linux (relacionado à correção desta rodada):**
- [ ] Testar um `.nki` cuja capitalização de amostra no XML divirja do nome real do arquivo no disco — cenário específico que o fix desta fase resolve

**Qualquer SO:**
- [ ] Testar o fluxo de auto-update assim que uma versão real for publicada

---

## 9. Estado do repositório

- Branch `main`, HEAD em `d0ae91d`, tudo commitado e empurrado para o GitHub
- Release rascunho `v0.2.36` (da Fase 9) e release rascunho `main` (da Fase 10, com a correção de case-insensitive) — **nenhum dos dois publicado**
- Observação: já existiam rascunhos antigos não publicados/não apagados no GitHub (v0.2.13 a v0.2.20), de antes deste projeto — não foram mexidos, só reportados caso queira fazer uma limpeza

**Nenhuma nova fase foi iniciada além da Fase 10. Aguardando autorização para qualquer próximo passo.**
