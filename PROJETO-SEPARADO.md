# MRQ Rack de Instrumentos — projeto separado

Criado a pedido do usuário: dividir o app original (`mrq-multitracks-play`,
que **continua intocado** em `github.com/MQueirozair/mrq-multitracks-play`)
em 3 projetos independentes, cada um instalável/testável sozinho:

1. **MRQ Multitracks Play2** (`mrq-multitracks-play2`) — o player de
   multitracks.
2. **MRQ Rack de Instrumentos** (este projeto) — o rack de instrumentos
   virtuais (SF2/NKI/EXS24/DX7/.mrq, efeitos por camada, pads, MIDI).
3. **MRQ Instrument Converter** (`mrq-instrument-converter`) — o
   conversor de formatos de instrumento pro formato `.mrq`.

## Estado atual

Isto é uma **cópia completa** do código do `mrq-multitracks-play` na
versão v0.2.48 (nenhum código removido ainda) — ponto de partida seguro
combinado com o usuário antes de começar a enxugar. O Rack hoje vive
dentro de `src/components/InstrumentRack.tsx` + `src/audio/rack/` + a
aba "Rack" da navegação principal — o resto do app (multitracks, letras,
etc.) ainda está todo aqui também.

## Próximo passo (ainda não feito)

Remover do código/UI deste projeto tudo que NÃO é o Rack de Instrumentos
(o player de multitracks, letras, etc. — que vão virar o projeto
`mrq-multitracks-play2`), deixando este projeto abrir direto no Rack como
app independente, até ficar 100% funcional sozinho (instalador próprio,
sem depender de nenhuma outra tela do app original). Depois que os 3
projetos estiverem cada um 100% funcionando de forma independente, o
usuário pediu pra planejarmos juntar os 3 de volta (como módulos/peças de
um só produto, se der certo).
