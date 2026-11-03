# Revisão técnica final — MRQ Instrument Converter

Revisão pontual pedida pelo usuário após o fechamento das Fases 1–10, limitada
aos 4 itens abaixo. **Não é uma nova fase** — nenhuma funcionalidade nova foi
criada, nenhum importador foi substituído, nenhuma arquitetura mudou. São
correções/documentação/testes em cima do que já existia.

Todos os testes (Rust + TypeScript) foram executados depois de cada correção.
Resultado final: **51/51 testes Rust (`cargo test --lib`) e todos os scripts
`test:nki`/`test:mrq-rack` em verde**, `tsc --noEmit` limpo, `cargo build --lib`
limpo.

---

## 1. Compatibilidade NKI no macOS (`DecompressionStream`)

**Arquivo examinado:** `src/audio/rack/NkiLayerVoice.ts`.

**O que foi confirmado:** a importação de `.nki` (Kontakt 1-4) descompacta um
corpo zlib usando a API nativa `DecompressionStream('deflate')`. Dados reais
de suporte (caniuse/MDN): essa API só existe a partir do **Safari 16.4**
(macOS 13/Ventura). A Apple parou de atualizar o Safari do **macOS
10.15/Catalina em 15.6.1** — ou seja, qualquer Mac de 10.15 até 12.x
(Monterey) sem upgrade de SO **nunca teve** essa API, mesmo que o app rode
nele (o `tauri.conf.json` anuncia `minimumSystemVersion: "10.15"`). Isso já
tinha sido identificado como risco pendente no relatório de Fases 1-10; esta
revisão o resolveu.

**Correção aplicada:** fallback puro-JavaScript usando `fflate` (`unzlibSync`)
— biblioteca **já usada no projeto** (MIT, 100% JS, sem WASM, já é dependência
pra ler/escrever o contêiner `.mrqi`), então não foi preciso adicionar nem
revisar licença de nenhuma dependência nova. A API nativa continua sendo
tentada primeiro (mais rápida, roda fora da thread principal); se ela não
existir, ou lançar exceção por qualquer motivo, o código cai automaticamente
no fallback. Função nova exportada separadamente (`inflateZlibPureJs`)
justamente para poder ser testada isoladamente — o Node usado para rodar os
testes automatizados já tem `DecompressionStream` nativo, então sem isso o
caminho de fallback nunca seria de fato exercitado por um teste.

**Testes (`scripts/test-nki-import.mjs`, novos):**
- conteúdo UTF-8 decodificado bate exatamente com o original;
- um corpo "deflate raw" (sem cabeçalho zlib) lança erro em vez de devolver lixo;
- bytes aleatórios lançam erro tratável, sem travar o processo;
- um zlib truncado no meio lança erro tratável.

**Limitação restante:** nenhuma quanto à descompactação em si. O resto do
pipeline `.nki` (parsing do XML, `decodeAudioData`, leitura de arquivo via
`window.api.fs`) continua dependendo do WebView/navegador — isso é inerente ao
formato e não mudou nesta revisão. Patches do Kontakt 4.2.2+ continuam sem
suporte (criptografia proprietária da NI, nunca quebrada por nenhuma
ferramenta pública) — isso já era documentado e não é afetado por esta
correção.

---

## 2. Segurança de gravação do `.mrq`

**Arquivo examinado:** `src-tauri/src/mrq/writer.rs`, mais o código-fonte da
crate `tempfile` 3.27.0 (`src/file/imp/unix.rs` e `src/file/imp/windows.rs`,
lido diretamente do cache local do cargo) para não declarar uma garantia que
a biblioteca não documenta.

**Mecanismo confirmado (não presumido):** `finish()` nunca abre o caminho de
destino para escrita. Tudo é gravado num arquivo temporário criado com
`tempfile_in(pasta_do_destino)` — mesma pasta, logo mesmo volume. Só depois
de uma autoconferência completa (`reader::validate_integrity`, recalculada do
zero a partir do que foi gravado em disco) é que `NamedTempFile::persist()` é
chamado — o único ponto que toca o destino.

- **Linux/macOS:** `persist()` (com substituição) vira uma única chamada a
  `rename(2)`. Isso é uma garantia formal do POSIX — troca atômica de
  verdade, nunca um estado "meio antigo, meio novo".
- **Windows:** vira `MoveFileExW(origem, destino, MOVEFILE_REPLACE_EXISTING)`
  no mesmo volume. A Microsoft **não documenta isso como atômico com a mesma
  força que o POSIX documenta `rename(2)`** — é o mesmo primitivo que
  `os.replace` (Python), `os.Rename` (Go) e `Files.move(ATOMIC_MOVE)` (Java
  NIO) usam no Windows, e na prática funciona como uma troca de metadado
  único quando os dois caminhos estão no mesmo volume NTFS (o que este
  código garante usando `tempfile_in`). Dois efeitos colaterais reais,
  documentados no código:
  1. se outro processo tiver o destino aberto sem `FILE_SHARE_DELETE`
     (antivírus, backup, outra instância do app), a operação falha — e o
     destino **não é tocado**, a conversão simplesmente falha e pode ser
     repetida;
  2. não há `fsync`/write-through explícito depois da troca — resíduo de
     risco em caso de queda de energia exatamente no instante da troca,
     compartilhado com praticamente qualquer escrita seguro baseada em
     rename (inclusive o caminho POSIX acima), não uma lacuna exclusiva
     deste código.

**Testes novos (`src-tauri/src/mrq/writer.rs`):**
- `finish_failure_preserves_pre_existing_file_at_destination_byte_for_byte`:
  escreve um arquivo "original" no destino, força uma falha real em
  `finish()` (referência de amostra pendurada) e confere, **byte a byte**,
  que o arquivo original sobrevive intacto — e que nenhum temporário de
  montagem fica para trás na pasta.
- `successful_finish_fully_replaces_pre_existing_file_at_destination`: conv
  ersão bem-sucedida reconvertendo pro mesmo caminho realmente substitui o
  conteúdo antigo por completo (sem misturar, sem duplicar).

**Conclusão:** não foi declarada atomicidade sem prova. Linux/macOS tem
garantia formal; Windows tem o mesmo nível de confiança que ferramentas de
produção amplamente usadas (Python/Go/Java), com as duas ressalvas acima
documentadas explicitamente no código-fonte (comentário de módulo em
`writer.rs`).

---

## 3. `exclusiveGroup`

**Arquivos examinados:** `src-tauri/src/importers/sf2.rs`,
`src/audio/rack/mrqFormat.ts`, `src/audio/rack/MrqLayerVoice.ts`.

**Confirmado:**
- O importador SF2 lê o generator `ExclusiveClass` do instrumento
  (`amt_u16(..., GeneratorType::ExclusiveClass)`), filtra o valor `0` (que
  pela spec SF2 significa "nenhum grupo", não um id de grupo válido) e grava
  o resultado em `MrqZone.exclusiveGroup`.
- Toda vez que esse valor existe, o importador chama
  `report.add_approximated("ExclusiveClass", ...)` — confirmado por leitura
  direta de `MrqCompatibilityReport::add_approximated`, que empurra pro vetor
  `approximated` (não `preserved` nem `unsupported`). A mensagem já deixa
  explícito que "o motor de reprodução MRQ ainda não aplica esse
  comportamento sonoro".
- **Problema encontrado e corrigido:** o comentário de `MrqLayerVoice.ts`
  dizia que "exclusive group/choke" era "tratado de forma genérica pelo
  RackEngine" na mesma frase que falava de envelope/filtro — isso é
  **impreciso**: envelope/filtro genéricos realmente existem no RackEngine
  (`LayerEnvelopeSettings`/`LayerFilterSettings`), mas **não existe, em
  nenhum lugar do Rack, código que implemente o comportamento de "choke
  group"** (matar vozes ativas de outras zonas do mesmo `exclusiveGroup` ao
  tocar uma nova nota) — confirmado por busca em todo o código-fonte
  TypeScript. O comentário foi reescrito para dizer isso sem ambiguidade.

**Teste novo (`src-tauri/src/importers/sf2.rs`):**
`exclusive_class_zero_means_no_group_but_any_nonzero_value_is_preserved` —
testa a regra exata (`amt_u16` + filtro `!= 0`) usada em produção, incluindo
os dois formatos de `GeneratorAmount` (`U16`/`I16`) que a crate `soundfont`
pode entregar. Não foi possível testar isso ponta a ponta com um arquivo
`.sf2` real porque os únicos fixtures disponíveis (`sin.sf2`,
`boomwhacker.sf3`) são tons de teste simples e não definem `ExclusiveClass`.

**Limitação restante (documentada, não corrigida — fora do escopo pedido):**
o Rack **não encerra automaticamente vozes da mesma classe de exclusividade**
hoje. O dado é preservado e visível (inclusive no Analyzer, aba "Grupos e
zonas"), mas não tem efeito sonoro em nenhuma camada (`MrqLayerVoice`, SF2
nativo, NKI, `.mrqi`). Implementar isso de verdade exigiria o `RackEngine`
saber agrupar vozes ativas por `exclusiveGroup` e encerrar as antigas no
`noteOn` de uma nova — mudança de escopo maior, não feita aqui por não ter
sido pedida nesta revisão.

---

## 4. Integridade e recuperação do `.mrq`

**Arquivos examinados:** `src-tauri/src/mrq/reader.rs`,
`src-tauri/src/mrq/writer.rs` (testes), `src-tauri/src/mrq/errors.rs`,
`src-tauri/src/importers/sf2.rs` (extração de PCM/Vorbis, upstream da
codificação FLAC).

**Limites e offsets confirmados:**
- `read_file_metadata` nunca aceita um offset/tamanho de amostra sem antes
  checar `checked_add` (estouro de inteiro) e os limites reais do bloco de
  amostras do arquivo (`sample_block_start..sample_block_end`).
- No importador SF2, a extração de PCM (`extract_pcm`) tem checagem de
  limites tanto pro caminho PCM 16/24-bit (`checked_mul` antes de comparar
  contra o tamanho real do chunk `smpl`) quanto pro caminho Vorbis/SF3
  (comparação direta + `checked_add` no offset) — nenhum dos dois caminhos
  confia cegamente em `eff_start`/`eff_end` vindos dos generators do SF2.

**Decodificação independente confirmada:** `extract_sample` lê só os bytes
exatos da amostra pedida (offset + tamanho do índice), nunca varre nem
decodifica outra amostra. Provado por teste já existente
(`extracting_one_sample_still_works_even_if_another_sample_is_corrupted`) e
pelo teste `multiple_independent_samples_each_extract_correctly`.

**Testes novos adicionados nesta revisão:**
- `validate_integrity_flags_only_the_corrupted_sample_in_its_own_report_entry`
  — confirma que `validate_integrity` (não só `extract_sample`) marca
  `ok: false` exatamente na amostra corrompida, mantém a outra `ok: true`, e
  também derruba o hash global.
- `truncating_the_file_mid_sample_data_fails_cleanly_instead_of_returning_garbage`
  — corta um `.mrq` válido no meio do bloco de amostras e confirma que pelo
  menos um dos três caminhos de leitura (`read_file_metadata`,
  `extract_sample`, `validate_integrity`) falha de forma estruturada; nenhum
  finge sucesso.
- `extract_sample_rejects_metadata_that_disagrees_with_the_real_flac_stream`
  — **bug real encontrado e corrigido** (ver abaixo).

**Bug encontrado e corrigido — metadados inconsistentes não eram
detectados:** o SHA-256 por amostra só cobre os bytes do bloco FLAC — nunca
cobriu os campos `channels`/`sampleRateHz` do índice JSON. Antes desta
revisão, `extract_sample` confiava cegamente nesses dois campos do JSON ao
montar o `MrqDecodedSample` devolvido pro chamador, **sem conferir contra o
cabeçalho STREAMINFO real do FLAC decodificado**. Ou seja: um `.mrq` com
metadados editados à mão (ou um bug futuro de escrita) poderia descrever uma
amostra estéreo de 44.1kHz apontando pra um FLAC mono de 48kHz de verdade, e
o app aceitaria isso silenciosamente, devolvendo áudio rotulado errado (o que
corrompe qualquer cálculo de duração/offset de loop feito a partir desse
objeto, tanto no Analyzer quanto no Rack).

**Correção:** nova variante de erro estruturada `MrqError::MetadataStreamMismatch`
(`src-tauri/src/mrq/errors.rs`, propagada também no tipo `MrqError` do lado
TypeScript em `mrqFormat.ts`) e uma checagem cruzada em
`reader::extract_sample` logo após abrir o `FlacReader`: se
`channels`/`sampleRateHz` do índice não baterem com o que o FLAC realmente
contém, a extração falha com um erro específico em vez de devolver dado
incorreto.

**Panics/travamentos:** nenhum encontrado. Todo o conjunto de testes do
backend Rust (`cargo test --lib`, 51 testes, incluindo os de arquivo vazio,
garbage menor que o cabeçalho, magic inválido, versão desconhecida, JSON de
metadados inválido, `metadata_len` que excede o arquivo, índice de amostra
apontando pra fora do arquivo, hash global incorreto, hash de amostra
incorreto, arquivo truncado no meio e metadados inconsistentes) passa sem
nenhum panic — todo erro é devolvido como `Result` estruturado.

---

## Arquivos alterados nesta revisão

| Arquivo | O que mudou |
|---|---|
| `src/audio/rack/NkiLayerVoice.ts` | fallback puro-JS (`fflate`) de descompressão zlib para WebKit sem `DecompressionStream` |
| `scripts/test-nki-import.mjs` | testes novos do fallback de descompressão |
| `src-tauri/src/mrq/writer.rs` | comentário de módulo documentando o mecanismo de substituição por plataforma + 4 testes novos |
| `src-tauri/src/mrq/reader.rs` | checagem cruzada `channels`/`sampleRateHz` contra o STREAMINFO real do FLAC |
| `src-tauri/src/mrq/errors.rs` | nova variante `MetadataStreamMismatch` |
| `src/audio/rack/mrqFormat.ts` | campos novos (`field`/`actual`) no tipo `MrqError` do lado TS |
| `src-tauri/src/importers/sf2.rs` | teste novo da regra `ExclusiveClass` (0 = nenhum grupo) |
| `src/audio/rack/MrqLayerVoice.ts` | comentário corrigido: `exclusiveGroup` não é tratado pelo RackEngine, é só dado preservado |

## Limitações que permanecem (documentadas, não corrigidas por estarem fora do escopo dos 4 itens pedidos)

1. Rack não implementa o comportamento sonoro de "choke group" (item 3).
2. Substituição de arquivo no Windows depende de `MoveFileExW`, que não tem
   garantia formal de atomicidade da Microsoft (mitigado ao máximo possível:
   mesmo volume, autoconferência antes de qualquer escrita no destino,
   comportamento de falha seguro) (item 2).
3. `.nki` do Kontakt 4.2.2+ (criptografado) e `.nkx`/`.nkc`/bibliotecas
   protegidas continuam sem suporte — limitação de formato, não de
   engenharia (item 1, pré-existente).
