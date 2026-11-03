# Documentação técnica

Relatórios e documentos de arquitetura escritos ao longo do
desenvolvimento do MRQ - Multitracks Play. Organizados por assunto:

## [`mrq-instrument-converter/`](./mrq-instrument-converter)

Tudo sobre o **MRQ Instrument Converter** e o pipeline de importação de
instrumentos de terceiros (SoundFont, DX7, Nord, Kontakt) pro formato
nativo `.mrq`/`.mrqi`, usado tanto na tela dedicada do conversor quanto no
Rack de instrumentos.

- [`mrq-converter-architecture.md`](./mrq-instrument-converter/mrq-converter-architecture.md)
  — documento de arquitetura original (auditoria do que já existia no
  projeto, modelo intermediário de instrumento, formato de arquivo `.mrq`,
  bibliotecas candidatas, plano de fases). **Referenciado por comentário em
  vários arquivos-fonte** (`nkiImport.ts`, `converterFormats.ts`,
  `mrqFormat.ts`, `InstrumentConverter.tsx` etc.) — se mover ou renomear,
  atualize essas referências junto.
- [`relatorio-final.md`](./mrq-instrument-converter/relatorio-final.md) —
  relatório de fechamento das Fases 1 a 10 do conversor.
- [`revisao-tecnica-final.md`](./mrq-instrument-converter/revisao-tecnica-final.md)
  — revisão pontual pedida depois do fechamento das fases, limitada a
  alguns itens específicos (não é uma fase nova).
- [`kontakt-audio-capture.md`](./mrq-instrument-converter/kontakt-audio-capture.md)
  — fluxo opcional dentro do conversor pra capturar via áudio instrumentos
  Kontakt que não podem ser abertos diretamente (biblioteca comercial
  criptografada).

## [`releases/`](./releases)

Anotações de lançamento de versões específicas, do histórico do projeto:

- [`v0.1.11.md`](./releases/v0.1.11.md)
- [`v0.1.12.md`](./releases/v0.1.12.md) — introdução do Rack de
  instrumentos.

> Releases mais recentes não têm relatório avulso aqui — o resumo de cada
> versão vai direto na *release notes* do GitHub (ver
> [`.github/workflows/release-tauri.yml`](../.github/workflows/release-tauri.yml))
> e no histórico de commits (`chore(release): bump versão pra X.Y.Z`).
