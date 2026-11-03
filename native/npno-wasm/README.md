# npno-wasm — como recompilar

Wrapper wasm fino sobre o crate `nord-format` (decodifica `.npno`/`.nsmp`).
O resultado compilado vai direto pra `public/vendor/npno-wasm/` (versionado
no git) — `native/npno-wasm/pkg/` é só um diretório de saída local, ignorado
pelo git.

## ⚠️ Importante: NÃO use `wasm-pack build` com o Rust padrão (estável)

Desde o **Rust 1.82**, o alvo `wasm32-unknown-unknown` passou a habilitar por
padrão as features do WebAssembly `reference-types` e `multivalue` — e a
**biblioteca padrão pré-compilada** (`std`) que vem com qualquer Rust >= 1.82
já embute essas features no bytecode dela, então nem passar
`-C target-feature=-reference-types` no `RUSTFLAGS` do seu próprio crate
resolve (o `std` que você está linkando já veio "contaminado").

Isso quebra em WebKit/Safari mais antigos (confirmado em produção: macOS
mais antigo, WebKit sem AudioWorklet/ConstantSourceNode — grosso modo,
anterior ao Safari 15) com:

```
TypeError: WebAssembly.Module doesn't parse at byte NNN: can't get 0th Type's return value
```

(`reference-types` e `multivalue` só ganharam suporte no Safari a partir da
versão 15, 2021 — bem depois de várias outras APIs que esse app já precisa
contornar nesses Macs mais velhos.)

## Receita que funciona (reconstrói o `std` sem essas features)

Requer Rust **nightly** com o componente `rust-src` (pra poder recompilar a
própria `std` com `-Z build-std`, um recurso instável):

```bash
rustup toolchain install nightly --component rust-src
rustup target add wasm32-unknown-unknown   # no toolchain padrão, só por via das dúvidas

# wasm-bindgen CLI tem que ser a MESMA versão exata do crate `wasm-bindgen`
# usado no Cargo.lock deste projeto (ver `grep -A2 'name = "wasm-bindgen"' Cargo.lock`)
cargo install wasm-bindgen-cli --version <versão do Cargo.lock> --locked

cd native/npno-wasm
RUSTFLAGS="-C target-feature=-reference-types,-multivalue,-bulk-memory,-bulk-memory-opt,-sign-ext,-nontrapping-fptoint" \
  cargo +nightly build -Z build-std=std,panic_abort --target wasm32-unknown-unknown --release

wasm-bindgen --target web --out-dir pkg --out-name npno_wasm \
  target/wasm32-unknown-unknown/release/npno_wasm.wasm

# copia pro destino servido pelo app (único lugar versionado no git):
cp pkg/npno_wasm.js pkg/npno_wasm.d.ts pkg/npno_wasm_bg.wasm ../../public/vendor/npno-wasm/
```

Depois de gerar, é recomendável validar:

```bash
node -e "console.log(require('wasm-opt') ? '' : '')"  # opcional
node -e "
const fs = require('fs');
console.log('valid:', WebAssembly.validate(fs.readFileSync('public/vendor/npno-wasm/npno_wasm_bg.wasm')));
"
```

E, se possível, rodar `test-fixtures/synthetic-test-piano.npno` pelo
decodificador (`npno_decode`) pra confirmar que ainda decodifica igual —
ver `scripts/cdp-test-npno.cjs` ou gerar um `--target nodejs` temporário só
pra esse teste local.

## `wasm-bindgen` tem que casar: crate (`Cargo.toml`/`Cargo.lock`) == CLI

Se a versão da CLI `wasm-bindgen` não bater EXATAMENTE com a versão da crate
`wasm-bindgen` usada pra compilar o `.wasm`, o comando falha (ou gera glue
incompatível). Sempre confira as duas antes de rodar.

## Por que não dá pra só usar uma toolchain estável mais antiga (pré-1.82)?

O crate `nord-format` (dependência deste wrapper) exige Rust >= 1.87, que já
é posterior à mudança de default de 1.82 — ou seja, NENHUMA combinação de
"toolchain estável antiga o suficiente" + "nord-format" funciona. Por isso a
única rota é nightly + `-Z build-std` (recompilar a própria `std` sem essas
features), mesmo compilando com uma toolchain recente.
