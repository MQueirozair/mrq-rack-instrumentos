import { useEffect, useRef, useState } from 'react';
import {
  Library,
  ListMusic,
  LayoutGrid,
  AudioWaveform,
  Timer,
  FileText,
  Volume2,
  Hash,
  Mic,
  Piano,
  Layers,
  Replace,
  Smartphone,
  Monitor,
  RefreshCw,
  Database,
  GraduationCap,
  Guitar,
  KeyboardMusic as KeyboardMusicIcon,
  Info,
  Zap,
  Radio,
  Tv,
  AlertTriangle,
  Split,
  Merge,
  Magnet,
  LayoutTemplate,
  Pencil,
  CheckSquare,
} from 'lucide-react';

const BASE = import.meta.env.BASE_URL;

function FormatChip({ children, accent }: { children: React.ReactNode; accent?: boolean }) {
  return <span className={`format-chip ${accent ? 'accent' : ''}`}>{children}</span>;
}

function Figure({ src, alt, caption }: { src: string; alt: string; caption: string }) {
  return (
    <figure className="help-figure">
      <img src={`${BASE}help/${src}`} alt={alt} loading="lazy" />
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

function SectionHead({ icon: Icon, title, purpose }: { icon: typeof Library; title: string; purpose: string }) {
  return (
    <div className="help-section-head">
      <div className="help-section-icon">
        <Icon size={17} />
      </div>
      <div>
        <h2>{title}</h2>
        <p className="help-section-purpose">{purpose}</p>
      </div>
    </div>
  );
}

const TOC: { id: string; label: string }[] = [
  { id: 'inicio', label: 'Início' },
  { id: 'biblioteca', label: 'Biblioteca' },
  { id: 'setlist', label: 'Lista / Cenas' },
  { id: 'arranjar', label: 'Arranjar' },
  { id: 'faixas', label: 'Faixas (mixer)' },
  { id: 'tempo', label: 'Tempo' },
  { id: 'cifra', label: 'Cifra' },
  { id: 'saidas', label: 'Saídas' },
  { id: 'tom', label: 'Tom' },
  { id: 'guia', label: 'Voz guia' },
  { id: 'midi', label: 'MIDI / Pad' },
  { id: 'rack', label: 'Rack de instrumentos' },
  { id: 'conversor', label: 'Conversor de instrumentos' },
  { id: 'remoto', label: 'Controle remoto' },
  { id: 'osc', label: 'OSC / MRQ Sync' },
  { id: 'palco', label: 'Modo Palco' },
  { id: 'backup', label: 'Backup' },
  { id: 'atualizacoes', label: 'Atualizações' },
  { id: 'casos-de-uso', label: 'Como usar' },
  { id: 'atalhos', label: 'Atalhos' },
  { id: 'suporte', label: 'Suporte' },
];

export default function HelpPanel() {
  const [appVersion, setAppVersion] = useState('—');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.api.app?.getVersion().then(setAppVersion).catch(() => {});
  }, []);

  function goTo(id: string) {
    const el = document.getElementById(id);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <div className="help-page">
      <div className="help-scroll" ref={scrollRef}>
        <div className="help-hero" id="inicio">
          <div className="help-hero-top">
            <img src={`${BASE}app-icon-64.png`} alt="MRQ" />
            <div>
              <h1 className="help-hero-title">MRQ — Multitracks Play</h1>
              <p className="help-hero-sub">Guia completo: o que o programa faz e como configurar cada recurso</p>
            </div>
            <div className="help-version-pill">
              <Info size={13} /> Versão instalada: <strong>{appVersion}</strong>
            </div>
          </div>
          <p className="help-hero-lede">
            O MRQ foi feito pra duas situações: <b>tocar ao vivo com multitracks</b> (click, voz guia, bateria, baixo
            etc. tocando junto com a banda num show ou culto) e <b>estudar/ensaiar uma música sozinho</b> — isolando
            faixas, soltando o tempo, mudando o tom, lendo a cifra e treinando parte por parte antes do ensaio com o
            grupo. Todas as telas abaixo ficam disponíveis pelos ícones da barra à esquerda; esta página explica cada
            uma delas, os formatos de arquivo aceitos e o passo a passo de configuração.
          </p>

          <div className="help-callout" style={{ marginBottom: 18 }}>
            <b>Correções desta versão:</b> a detecção automática de partes (Arranjar → "Reconhecer partes") foi
            refeita de novo, mais a fundo — agora usa o próprio silêncio da voz-guia pra achar com mais confiança
            onde começam e terminam os trechos instrumentais (intro, interlúdio, solo, ponte instrumental), separa
            "Pré-refrão" de "Verso" pela duração mais curta antes do refrão, e usa o volume de verdade da faixa (não
            mais um valor normalizado que escondia a diferença entre verso e refrão) pra decidir qual grupo repetido
            é o refrão. Não rotula mais tudo de "Refrão" por engano, não cria partes desnecessárias, e repetições do
            mesmo tipo agora ficam numeradas (Refrão, Refrão 2, Refrão 3...) pra nunca ter dois botões iguais sem
            diferença. Importar uma pasta agora encontra os arquivos de áudio sozinho mesmo quando estão numa
            subpasta (ex. "Música/WAV/"), sem precisar navegar manualmente. <b>Click Track</b> e <b>Guide/Guia</b>{' '}
            sempre aparecem primeiro no mixer, e o canal <b>MASTER</b> fica sempre visível (não rola junto com as
            outras faixas).
          </div>
          <div className="help-callout" style={{ marginBottom: 18 }}>
            <b>Também nesta leva:</b> pílula de acorde maior (mostra o acorde inteiro, sem cortar) · Tap tempo ·
            Loop A/B de ensaio · Modo Palco — Telão (cifra em tela cheia) · Folha de roteiro pra imprimir/PDF ·
            Monitor de saúde do áudio (avisa sobre soluços ao vivo) · acorde ao vivo transmitido pro celular de toda
            a banda · Cues de palco por parte (OSC/MIDI) · e duas tecnologias novas — ponte <b>OSC</b> com software de
            produção externo (QLab, Resolume, TouchOSC) e <b>MRQ Sync</b> (sincronismo de estado entre instâncias do
            MRQ na mesma rede). Veja os detalhes de cada uma nas seções abaixo.
          </div>

          <div className="help-formats-grid">
            <div className="help-formats-card">
              <h4>Faixas de multitrack (Biblioteca)</h4>
              <div className="chips">
                {['.wav', '.aiff', '.flac', '.mp3', '.ogg', '.opus', '.m4a', '.aac', '.wma', '.webm', '.caf', '.3gp'].map((f) => (
                  <FormatChip key={f}>{f}</FormatChip>
                ))}
              </div>
            </div>
            <div className="help-formats-card">
              <h4>Timbres do Rack de instrumentos</h4>
              <div className="chips">
                <FormatChip accent>.sf2 / .sf3</FormatChip>
                <FormatChip accent>.syx (DX7)</FormatChip>
                <FormatChip accent>.npno (Nord)</FormatChip>
                <FormatChip accent>.nsmp / .nsmp3 / .nsmp4 (Nord)</FormatChip>
                <FormatChip accent>.nki (Kontakt 1-4)</FormatChip>
                <FormatChip accent>.sfz (inclui Kontakt 5-8 exportado)</FormatChip>
                <FormatChip accent>.mrqi (formato leve do Rack)</FormatChip>
                <FormatChip>.wav / .aiff / .flac / .mp3 / .ogg (amostra)</FormatChip>
              </div>
            </div>
            <div className="help-formats-card">
              <h4>Cifra</h4>
              <div className="chips">
                <FormatChip>Texto colado (sem arquivo)</FormatChip>
              </div>
            </div>
            <div className="help-formats-card">
              <h4>Backup / Cenas / Setlist</h4>
              <div className="chips">
                <FormatChip>.json</FormatChip>
              </div>
            </div>
          </div>
        </div>

        <div className="help-toc">
          {TOC.slice(1).map((t) => (
            <button key={t.id} onClick={() => goTo(t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        {/* ---------------- BIBLIOTECA ---------------- */}
        <section className="help-section" id="biblioteca">
          <SectionHead icon={Library} title="Biblioteca" purpose="Importar músicas e organizar o acervo de multitracks" />
          <div className="help-grid-2">
            <div>
              <p>
                É aqui que toda música mora. Cada música é <b>uma pasta no seu computador</b> contendo uma faixa de
                áudio por instrumento/voz (ex.: "Clique.wav", "Guia.wav", "Bateria.wav"...). O MRQ nunca copia os
                arquivos de áudio — ele só memoriza o caminho da pasta, então o espaço em disco não dobra e músicas
                com pastas muito grandes abrem rápido.
              </p>
              <ol>
                <li>
                  Clique em <b>"Importar pasta de multitracks"</b> (botão laranja na tela inicial ou o <b>+</b> no
                  topo da Biblioteca).
                </li>
                <li>
                  Escolha a pasta da música. O MRQ varre a pasta e lista toda faixa de áudio reconhecida — se os
                  arquivos estiverem direto nela, abre a música sozinho, sem precisar escolher arquivo por arquivo.
                  Se a pasta escolhida não tiver nenhum áudio direto nela mas tiver só uma ou duas subpastas (comum em
                  pacotes baixados prontos, ex. "Música/WAV/", "Música/Áudio/48kHz/"), o MRQ procura automaticamente
                  até 2 níveis abaixo antes de desistir — só pede pra navegar manualmente se a pasta escolhida parecer
                  uma biblioteca inteira (muitas subpastas, provavelmente várias músicas diferentes).
                </li>
                <li>
                  As faixas de <b>Click Track</b> e <b>Guide/Guia</b> (reconhecidas pelo nome do arquivo) sempre vêm
                  primeiro no mixer, nessa ordem — são as que a banda mais precisa achar rápido no palco.
                </li>
                <li>
                  Formatos aceitos nas faixas: <FormatChip>.wav/.wave</FormatChip> <FormatChip>.aiff/.aif/.aifc</FormatChip>{' '}
                  <FormatChip>.flac</FormatChip> <FormatChip>.mp3</FormatChip> <FormatChip>.ogg/.oga/.opus</FormatChip>{' '}
                  <FormatChip>.m4a/.mp4/.m4b/.aac</FormatChip> <FormatChip>.wma</FormatChip> <FormatChip>.webm</FormatChip>{' '}
                  <FormatChip>.caf</FormatChip> <FormatChip>.3gp</FormatChip>.
                </li>
                <li>
                  Use <b>"Buscar música..."</b> para achar pelo nome e <b>"Só favoritas"</b> pra filtrar as músicas
                  marcadas com estrela (clique na estrela do card da música pra favoritar).
                </li>
              </ol>
              <div className="help-callout tip">
                <b>Dica:</b> nomeie os arquivos de forma clara ("Clique", "Guia", "Bateria", "Baixo"...) — esse nome
                aparece em todo canto do app (mixer, Saídas, Tom) e facilita demais na hora do show.
              </div>
            </div>
            <Figure src="help-library-empty.png" alt="Tela inicial da Biblioteca" caption="Biblioteca vazia — primeiro passo é importar a pasta de uma multitrack." />
          </div>
          <Figure
            src="help-player-overview.png"
            alt="Música aberta mostrando forma de onda, partes e mixer"
            caption="Depois de importada e aberta, a música mostra a forma de onda, o roteiro de partes e o mixer de faixas."
          />
        </section>

        {/* ---------------- SETLIST / CENAS ---------------- */}
        <section className="help-section" id="setlist">
          <SectionHead icon={ListMusic} title="Lista (Cenas / Setlist)" purpose="Montar a ordem das músicas de um show, culto ou ensaio" />
          <div className="help-grid-2">
            <div>
              <p>
                Uma <b>Cena</b> é um setlist: uma lista ordenada de músicas prontas pra tocar em sequência num evento.
                Cada música dentro da cena guarda seu próprio <b>tom</b> e <b>BPM</b> escolhidos — assim a mesma
                música pode estar em tons diferentes em cenas diferentes, sem bagunçar o arquivo original.
              </p>
              <ol>
                <li>
                  Abra a aba <b>Lista</b>, clique em <b>"+ adicionar música à cena..."</b> e escolha entre as músicas
                  da Biblioteca.
                </li>
                <li>Clique numa música da lista pra abri-la e tocar.</li>
                <li>
                  Use os ícones no topo da cena pra <b>gerar a folha de roteiro</b> (<FormatChip accent>novidade</FormatChip>,
                  ícone de folha), <b>exportar</b> (baixa um arquivo <FormatChip>.json</FormatChip> com a cena) ou{' '}
                  <b>excluir</b> a cena.
                </li>
                <li>O histórico de execução (quando cada música tocou) fica disponível pelo ícone de relógio.</li>
              </ol>
              <p>
                <b>Novidade — Folha de roteiro (gig sheet):</b> o ícone de folha no topo da cena gera um arquivo{' '}
                <FormatChip>.html</FormatChip> autossuficiente — abra no navegador e use "Imprimir / Salvar como PDF"
                pra ter uma folha impressa com a ordem, tom, BPM, duração e anotações de cada música, pronta pra
                colar na estante ou distribuir pra banda.
              </p>
              <div className="help-callout">
                Exportar/importar cenas em <FormatChip>.json</FormatChip> é útil pra levar o roteiro de um culto pra
                outro computador (ex.: notebook do músico de apoio) — mas lembre de reimportar as pastas de
                multitrack naquele computador também, já que o áudio em si não viaja dentro do arquivo da cena.
              </div>
            </div>
            <Figure src="help-setlist.png" alt="Cena com uma música adicionada" caption="Cena 'Culto de Domingo' com uma música na lista, pronta pra tocar." />
          </div>
        </section>

        {/* ---------------- ARRANJAR ---------------- */}
        <section className="help-section" id="arranjar">
          <SectionHead icon={LayoutGrid} title="Arranjar" purpose="Marcar as partes da música (Intro, Verso, Refrão...) e o roteiro de execução" />
          <div className="help-grid-2">
            <div>
              <p>
                Aqui você divide a música em <b>partes</b> (Intro, Verso, Pré-refrão, Refrão, Instrumental, Ponte,
                Solo, Tag, Interlúdio, Final, Outra) pra poder pular entre trechos ao vivo sem precisar tocar a música
                inteira do início ao fim.
              </p>
              <ol>
                <li>Arraste com o mouse sobre a forma de onda pra marcar um trecho novo.</li>
                <li>Dê um nome, escolha o tipo da parte e confirme em <b>"Adicionar parte"</b>.</li>
                <li>Clique numa parte já marcada, na lista "Partes marcadas", pra editar nome/tipo/compassos.</li>
                <li>Arraste os cartões pra <b>reordenar o roteiro</b> (a ordem de execução ao vivo).</li>
                <li>
                  <b>"Reconhecer partes (beta)"</b> lê a faixa guia (ou a primeira faixa, se não houver uma marcada
                  como guia) e sugere as partes sozinho, analisando onde o áudio muda de verdade — ótimo pra um
                  primeiro rascunho, mas sempre revise o resultado antes de tocar ao vivo.
                </li>
                <li>
                  <b>Reconhecimento por voz (opcional):</b> muitas multitracks/VS trazem, na própria faixa guia, uma
                  locução anunciando cada parte antes dela começar (a voz diz "Estrofe", conta um compasso, e a
                  estrofe começa). Ligando <b>Ajustes → Reconhecer por voz</b> (e baixando o modelo de voz, ~148MB,
                  uma vez só — tudo roda local no computador, nenhum áudio sai pra internet), o botão "Reconhecer
                  partes" passa a OUVIR essa locução pra nomear as partes com muito mais precisão do que só analisando
                  a forma da onda. Se a faixa não tiver locução (ou o reconhecimento não achar confiança suficiente),
                  o MRQ cai sozinho de volta pro método por áudio — não precisa escolher um ou outro manualmente.
                </li>
                <li>
                  O seletor <b>"Sensibilidade"</b> ao lado do botão controla quantas partes ele tende a sugerir
                  quando o reconhecimento cai no método por áudio (sem locução reconhecida):
                  <b> poucas</b> (só trocas bem óbvias, menos revisão depois), <b>normal</b> (padrão) ou
                  <b> muitas</b> (pega até trocas sutis, mas pode sugerir partes demais em músicas com muita variação
                  de dinâmica). Rode de novo com outra sensibilidade se o resultado não ficou bom.
                </li>
                <li>
                  Cada parte mostra sua <b>duração</b> (compassos e minutos:segundos) na lista — uma parte com menos
                  de 4 compassos aparece destacada em laranja, um sinal de que ela pode ser sobra de uma detecção
                  automática que separou demais e vale a pena revisar.
                </li>
                <li>
                  Pra corrigir rápido uma sugestão automática sem refazer tudo na mão: o ícone de
                  <b> dividir</b> (<Split size={12} style={{ verticalAlign: 'middle' }} />) quebra uma parte ao meio
                  (quando ela juntou duas seções diferentes), e o ícone de <b>mesclar</b>
                  (<Merge size={12} style={{ verticalAlign: 'middle' }} />) funde a parte com a próxima (quando ela
                  separou demais).
                </li>
                <li><kbd>Delete</kbd> remove o passo selecionado do roteiro · <kbd>Ctrl+Z</kbd> desfaz · <kbd>Ctrl+Shift+Z</kbd> refaz.</li>
              </ol>
              <p>
                <b>Novidade — Cues de palco:</b> clique no ícone de raio (<Zap size={12} style={{ verticalAlign: 'middle' }} />)
                em qualquer parte marcada pra configurar um <b>endereço OSC</b> e/ou um <b>Program Change MIDI</b> que
                disparam automaticamente, sozinhos, assim que aquela parte entra ao vivo — pra trocar a cena de um
                software de luz/vídeo (QLab, Resolume, mesa de luz) no exato momento certo, sem precisar de um
                operador extra. Veja a seção <i>OSC / Sync</i> abaixo pra ligar a ponte OSC.
              </p>
              <p className="help-callout">
                <b>Novidade — Marcar / Arranjar:</b> a tela agora tem dois modos, alternados pelas abas
                {' '}<Pencil size={12} style={{ verticalAlign: 'middle' }} /><b> Marcar</b> e{' '}
                <LayoutGrid size={12} style={{ verticalAlign: 'middle' }} /><b> Arranjar</b>, em vez de uma lista
                comprida só: <b>Marcar</b> é onde você mexe nos limites/nomes/tipos de cada parte; <b>Arranjar</b> é
                onde você monta o roteiro (ordem, repetições, versões) a partir das partes já marcadas.
              </p>
              <p className="help-callout">
                <b>Novidade — Modal "Parte" com anacruse:</b> clique no lápis
                ({' '}<Pencil size={12} style={{ verticalAlign: 'middle' }} />) de qualquer parte pra abrir uma janela
                de edição com <b>Nome</b>, <b>Tipo</b> e o campo novo <b>"Entra antes do compasso"</b> — use quando a
                banda já começa a tocar aquela parte um pouco antes da cabeça do compasso marcado (a clássica
                "anacruse"/levada de entrada, comum em refrões e pontes). Escolhendo 1, 2, 3, 4, 6 ou 8 tempos antes,
                o início da parte é recalculado sozinho pra soar no instante certo — sem precisar fazer a conta na mão.
              </p>
              <p className="help-callout">
                <b>Novidade — Selo de origem da marcação:</b> cada parte reconhecida automaticamente ganha um selinho
                na lista: {' '}<Mic size={12} style={{ verticalAlign: 'middle' }} /> verde quando ela veio da
                <b> locução da faixa guia</b> (alta confiança) e {' '}<AudioWaveform size={12} style={{ verticalAlign: 'middle' }} />
                {' '}laranja quando veio só da <b>heurística de forma de onda</b> (sem locução reconhecida — vale a
                pena conferir os limites com mais cuidado). Partes criadas ou editadas à mão não ganham selo.
              </p>
              <p className="help-callout">
                <b>Novidade — Encaixar no tempo</b> ({' '}<Magnet size={12} style={{ verticalAlign: 'middle' }} />):
                corrige pequenos erros de quem arrastou a seleção na forma de onda com a mão, arredondando o início e
                o fim da parte pro tempo (beat) mais próximo, usando o compasso da música — ótimo depois de um
                "Reconhecer partes" ou de um ajuste manual que ficou "quase certo".
              </p>
              <p className="help-callout">
                <b>Novidade — Seleção múltipla:</b> o botão {' '}<CheckSquare size={12} style={{ verticalAlign: 'middle' }} />
                {' '}<b>"Selecionar várias"</b>, no topo da lista de partes, marca todas de uma vez (desmarque as que
                não quiser com a caixinha de cada linha) pra fazer uma <b>ação em lote</b>: mudar o tipo de várias
                partes ao mesmo tempo (ex.: corrigir vários "Verso" detectados errado pra "Refrão") ou excluir várias
                partes de uma vez, sem precisar repetir a operação parte por parte.
              </p>
              <p className="help-callout">
                <b>Novidade — Versões e modelos, no modo Arranjar:</b> o seletor <b>"Original ▾"</b> (ou o nome da
                versão ativa) abre um menu pra <b>salvar como nova versão</b>, <b>renomear</b> ou <b>excluir</b> a
                versão atual, e trocar rapidamente entre todas as versões salvas da música — sem afetar nunca a
                ordem original gravada. Ao lado, <b>"Exportar roteiro"</b> ({' '}<FileText size={12} style={{ verticalAlign: 'middle' }} />)
                copia a ordem das partes como texto simples, pronto pra colar num grupo de WhatsApp ou e-mail pra
                quem da banda não usa o app. E o menu <b>"Modelos"</b> ({' '}<LayoutTemplate size={12} style={{ verticalAlign: 'middle' }} />)
                deixa salvar a sequência de <i>tipos</i> de parte do roteiro atual (ex.: "Louvor padrão": Intro,
                Verso, Refrão, Verso, Refrão, Ponte, Refrão, Final) como um modelo reutilizável — e aplicar esse
                mesmo modelo em QUALQUER outra música depois, como uma nova versão: o MRQ casa cada passo do modelo
                com a primeira parte daquele tipo ainda disponível na música (repetindo partes do mesmo tipo se o
                modelo pedir mais do que a música tem), economizando o trabalho de montar o roteiro do zero toda vez
                que a estrutura se repete de uma música pra outra.
              </p>
              <p className="help-callout">
                <b>Correção desta versão:</b> a detecção automática estava criando partes demais e, em algumas
                músicas, rotulava TODAS as partes como "Refrão". O detector foi refeito com uma técnica mais robusta
                de reconhecimento de estrutura musical (curva de novidade por similaridade, com suavização e limiar
                adaptativo — a mesma base usada por ferramentas de análise de áudio como MSAF), com um passo que
                funde automaticamente qualquer trecho curto demais no vizinho mais parecido, e uma rede de segurança
                no rótulo: se o programa não encontrar diversidade de verdade entre as partes, não arrisca chamar
                tudo de "Refrão". A entrada da análise é sempre a <b>faixa guia</b> (nunca o mix completo) — e agora o
                programa também usa o <b>silêncio da própria voz-guia</b> como pista de estrutura: um trecho em que a
                voz-guia não canta quase sempre é instrumental de verdade (intro, interlúdio, ponte instrumental ou
                solo), um corte muito mais confiável do que comparar timbre. Isso trouxe de volta tipos que o
                detector não usava direito: <b>Pré-refrão</b> (trecho curto cantado logo antes do refrão),{' '}
                <b>Interlúdio</b> e <b>Solo</b> (instrumental "em destaque", mais alto que uma simples passagem).
                Repetições do mesmo tipo agora ficam numeradas (ex. "Refrão", "Refrão 2", "Refrão 3") em vez de todas
                se chamarem igual.
              </p>
            </div>
            <Figure src="help-arrange.png" alt="Tela de Arranjar com partes marcadas" caption="Partes marcadas na forma de onda e lista editável abaixo." />
          </div>
        </section>

        {/* ---------------- FAIXAS / MIXER ---------------- */}
        <section className="help-section" id="faixas">
          <SectionHead icon={AudioWaveform} title="Faixas (mixer)" purpose="Ver a forma de onda de cada faixa separadamente e ajustar volume, mudo e solo" />
          <div className="help-grid-2">
            <div>
              <p>
                Mostra cada faixa de áudio da música numa linha própria, com sua forma de onda, além do mixer embaixo
                com um fader por faixa. Use <b>M</b> (mudo) e <b>S</b> (solo) pra isolar instrumentos — essencial tanto
                pra conferir uma faixa problemática quanto pra estudar uma parte específica (ex.: só o baixo).
              </p>
              <p>
                O botão <b>"Modo prova de som"</b> ajuda a testar canal por canal antes do show. O canal{' '}
                <b>MASTER</b> fica sempre visível, separado por uma linha, à direita da lista de faixas — ele não
                rola junto quando a música tem muitas faixas e a lista fica mais larga que a tela (nem aqui, nem na
                mesma mesa dentro de uma cena da Lista/Setlist), então você sempre consegue ver o nível geral sem
                precisar rolar até o fim.
              </p>
              <p>
                O cabeçalho <b>"Mesa de mixagem"</b>, logo acima dos canais, tem um botão de minimizar (seta) que
                esconde a mesa inteira — útil pra ganhar espaço de tela quando você só precisa ver a forma de onda e
                o roteiro de partes por um tempo, sem mexer em volume/mudo/solo. Clique de novo pra mostrar a mesa
                outra vez (preferência rápida, não fica salva entre sessões).
              </p>
              <p>
                <b>Novidade — Monitor de saúde do áudio:</b> enquanto a música toca, o MRQ fica de olho em possíveis{' '}
                <b>soluços/falhas de áudio</b> (buffer travando, o sistema operacional suspendendo o som sozinho,
                computador sobrecarregado). Se detectar algo, uma pílula laranja{' '}
                <AlertTriangle size={12} style={{ verticalAlign: 'middle' }} /> <b>"Soluço de áudio"</b> acende na
                barra de título na hora — pra você descobrir um problema de áudio no mesmo instante, em vez de só
                perceber pelo ouvido no meio de uma música ao vivo.
              </p>
            </div>
            <Figure src="help-tracks.png" alt="Visualização de faixas separadas" caption="Cada faixa com sua própria forma de onda, mais o mixer completo abaixo." />
          </div>
        </section>

        {/* ---------------- TEMPO ---------------- */}
        <section className="help-section" id="tempo">
          <SectionHead icon={Timer} title="Tempo" purpose="Click/metrônomo, fórmula de compasso e modo de ensaio em velocidade reduzida" />
          <div className="help-grid-2">
            <div>
              <p>
                <b>Modo Ensaio</b> é a ferramenta de estudo por excelência: toca a parte ativa em loop numa velocidade
                reduzida (50% a 100%) <i>sem alterar o BPM salvo da música</i> — perfeito pra treinar um trecho difícil
                devagar antes de tocar no tempo real.
              </p>
              <ol>
                <li>Escolha a porcentagem de velocidade desejada (50% a 100%).</li>
                <li>
                  Em <b>"BPM e compasso"</b>, clique <b>"Ajustar"</b> pra corrigir o andamento e a fórmula de compasso
                  reais da música (usados pra calcular os compassos das partes corretamente).
                </li>
                <li>
                  <b>"Dobrar o click"</b> sobrepõe um metrônomo próprio por cima do click já gravado na faixa, útil
                  quando o click original é fraco ou tem variação de tempo.
                </li>
              </ol>
              <p>
                <b>Novidade — Tap tempo:</b> não sabe o BPM de cabeça? Bata no ritmo da música (botão "👆 Bater") pelo
                menos 2 vezes seguidas — o MRQ calcula a média dos intervalos entre as batidas e mostra o BPM na
                hora; clique <b>"Aplicar"</b> pra usar esse valor na música (ou "Cancelar" pra descartar).
              </p>
              <p>
                <b>Novidade — Loop A/B:</b> pra martelar só um trechinho difícil (em vez da parte inteira), clique{' '}
                <b>"Marcar A"</b> no compasso de início do trecho, deixe tocar até o fim do trecho e clique{' '}
                <b>"Marcar B e ativar"</b> — o MRQ repete só esse intervalo de compassos até você clicar em{' '}
                <b>"Desativar loop A/B"</b>. É independente do loop da parte inteira (botão de loop no player).
              </p>
            </div>
            <Figure src="help-tempo.png" alt="Painel de Tempo com Modo Ensaio" caption="Modo Ensaio (velocidade reduzida), BPM, fórmula de compasso e duplicação do click." />
          </div>
        </section>

        {/* ---------------- CIFRA ---------------- */}
        <section className="help-section" id="cifra">
          <SectionHead icon={FileText} title="Cifra" purpose="Colar a cifra da música e acompanhar com transposição automática" />
          <div className="help-grid-2">
            <div>
              <p>
                Não é um formato de arquivo — você <b>cola o texto</b> da cifra direto na caixa. Use colchetes pra
                marcar as seções, ex.: <code>[Refrão]</code>, com os acordes numa linha acima da letra. O MRQ separa
                as seções automaticamente e permite clicar numa parte à direita pra pular a música até ali.
              </p>
              <ol>
                <li>Clique em <b>"Colar cifra"</b>, cole o texto (informando o tom original da cifra) e salve.</li>
                <li>
                  Quando você muda o tom da música (na aba <b>Tom</b> ou no cabeçalho principal), a cifra é{' '}
                  <b>transposta automaticamente</b> — os acordes mudam, a letra não.
                </li>
              </ol>
              <p>
                <b>Novidade — Modo Palco: Telão:</b> o botão <b>"<Tv size={12} style={{ verticalAlign: 'middle' }} /> Modo
                Palco — Telão"</b> (acima da cifra, quando já
                existe uma cifra colada) abre a cifra em <b>tela cheia</b>, com fonte bem maior e alto contraste —
                pensado pra ligar num monitor/TV secundário virado pro músico/vocalista durante a apresentação. A
                seção da parte que está tocando agora rola automaticamente pra ficar visível (por nome, casando com
                o marcador <code>[Nome]</code> da cifra). Use <kbd>+</kbd>/<kbd>-</kbd> pra ajustar o tamanho da
                fonte e <kbd>Esc</kbd> pra fechar.
              </p>
            </div>
            <Figure src="help-chord.png" alt="Cifra colada com acordes" caption="Cifra colada com seções [Intro], [Verso 1], [Refrão]... e navegação pelas partes à direita." />
          </div>
        </section>

        {/* ---------------- SAÍDAS ---------------- */}
        <section className="help-section" id="saidas">
          <SectionHead icon={Volume2} title="Saídas" purpose="Rotear cada faixa pra um par de canais da sua interface de áudio" />
          <div className="help-grid-2">
            <div>
              <p>
                Pensado pra quem usa uma <b>interface de áudio multicanal</b> ao vivo: você pode mandar o click e a
                guia só pro fone de ouvido do baterista (um par de saída) e o restante da banda pra PA (outro par),
                por exemplo.
              </p>
              <ol>
                <li>
                  Primeiro configure quantos canais sua interface tem em <b>Ajustes → Áudio → "Canais de saída do
                  dispositivo"</b>.
                </li>
                <li>Volte em Saídas e escolha, faixa por faixa, qual par estéreo (1/2, 3/4...) ela deve usar.</li>
              </ol>
            </div>
            <Figure src="help-outputs.png" alt="Roteamento de faixas para pares de saída" caption="Cada faixa roteada para um par estéreo do dispositivo de áudio multicanal." />
          </div>
        </section>

        {/* ---------------- TOM ---------------- */}
        <section className="help-section" id="tom">
          <SectionHead icon={Hash} title="Tom" purpose="Escolher quais faixas acompanham a transposição de tom" />
          <div className="help-grid-2">
            <div>
              <p>
                Ao transpor a música (botões <b>+/-</b> de TOM no cabeçalho), nem toda faixa deve mudar de altura:
                click, guia e bateria normalmente ficam fixas, enquanto baixo, violão, teclado e vocais acompanham o
                novo tom. Aqui você define isso faixa por faixa, uma vez só — a escolha fica salva com a música.
              </p>
            </div>
            <Figure src="help-key.png" alt="Faixas marcadas para seguir o tom ou ficar fixas" caption="Click/guia/bateria fixos; baixo, violão, teclado e vocal acompanham o tom." />
          </div>
        </section>

        {/* ---------------- VOZ GUIA ---------------- */}
        <section className="help-section" id="guia">
          <SectionHead icon={Mic} title="Voz guia" purpose="Faixa de referência que anuncia as partes da música" />
          <div className="help-grid-2">
            <div>
              <p>
                Defina qual faixa é a "voz guia" (quem fala "próximo, refrão" etc. no fone dos músicos). O recurso
                mais importante aqui é o comportamento <b>quando você pula pra uma parte fora da ordem gravada</b> ao
                vivo:
              </p>
              <ul>
                <li><b>Não mexer</b> — a guia toca exatamente como foi gravada (pode anunciar a parte errada).</li>
                <li><b>Calar a guia</b> — ela simplesmente silencia nesse trecho e volta a falar quando a parte pedida chegar.</li>
                <li><b>Calar e anunciar a parte pedida</b> — a guia é cortada e o app anuncia por cima qual parte está vindo.</li>
              </ul>
            </div>
            <Figure src="help-guide.png" alt="Opções de comportamento da voz guia" caption="Escolha de faixa guia e comportamento ao pular partes fora de ordem." />
          </div>
        </section>

        {/* ---------------- MIDI / PAD ---------------- */}
        <section className="help-section" id="midi">
          <SectionHead icon={Piano} title="MIDI / Pad contínuo" purpose="Controlar o roteiro da música com um controlador MIDI físico" />
          <div className="help-grid-2">
            <div>
              <p>
                Permite "aprender" teclas de um controlador MIDI pra pular direto pro próximo trecho de um tipo (ex.:
                uma tecla sempre avança pro próximo Refrão), sem precisar olhar pro mouse durante o show.
              </p>
              <ol>
                <li>Clique em <b>"Aprender"</b> ao lado do tipo de parte desejado (Intro, Verso, Refrão...).</li>
                <li>Aperte a tecla do seu controlador MIDI que vai disparar aquele tipo de parte.</li>
                <li><b>"Limpar"</b> remove o mapeamento daquela tecla.</li>
              </ol>
              <p>Essa configuração é separada do MIDI físico usado pelo Rack de instrumentos (aba seguinte).</p>
            </div>
            <Figure src="help-midi.png" alt="Mapeamento de teclas MIDI por tipo de parte" caption="Uma tecla do controlador MIDI por tipo de parte da música." />
          </div>
        </section>

        {/* ---------------- RACK ---------------- */}
        <section className="help-section" id="rack">
          <SectionHead icon={Layers} title="Rack de instrumentos" purpose="Até 8 instrumentos virtuais tocáveis ao vivo por um teclado MIDI físico, por cima da multitrack" />
          <p>
            O Rack transforma o MRQ num instrumento ao vivo de verdade: conecte um teclado MIDI físico ao computador e
            toque até <b>8 camadas (instrumentos) simultâneas</b> por cima da música que está rodando — útil pra quem
            reforça o teclado/sintetizador da banda, cobre um naipe de cordas, ou simplesmente quer soar mais cheio
            sem contratar mais músicos. A 8ª camada (<b>CAMADA 08 · PAD</b>) é igual às outras 7 por dentro — carrega
            qualquer um dos formatos abaixo normalmente — mas em vez do formulário tradicional mostra uma grade de 12
            pads coloridos (uma oitava cromática, com navegação de oitava) pra tocar com o mouse/touch sem precisar de
            teclado MIDI físico.
          </p>
          <Figure
            src="help-rack-formats.png"
            alt="Rack com 7 camadas, cinco delas com instrumentos carregados de formatos diferentes"
            caption="As 7 primeiras camadas do Rack — cada uma pode carregar um formato de instrumento diferente. Há ainda uma 8ª camada (CAMADA 08 · PAD, grade de pads coloridos) e a coluna MASTER à direita."
          />

          <h3 style={{ fontSize: 13.5, marginTop: 18 }}>Formatos de timbre aceitos por camada</h3>
          <div className="help-formats-grid" style={{ marginBottom: 6 }}>
            <div className="help-formats-card">
              <h4>SoundFont</h4>
              <div className="chips"><FormatChip accent>.sf2</FormatChip><FormatChip accent>.sf3</FormatChip></div>
            </div>
            <div className="help-formats-card">
              <h4>Banco Yamaha DX7</h4>
              <div className="chips"><FormatChip accent>.syx</FormatChip></div>
            </div>
            <div className="help-formats-card">
              <h4>Amostra única (sampler)</h4>
              <div className="chips">
                <FormatChip>.wav</FormatChip><FormatChip>.aiff/.aif</FormatChip><FormatChip>.flac</FormatChip>
                <FormatChip>.ogg</FormatChip><FormatChip>.mp3</FormatChip>
              </div>
            </div>
            <div className="help-formats-card">
              <h4>Nord Piano Library</h4>
              <div className="chips"><FormatChip accent>.npno</FormatChip></div>
            </div>
            <div className="help-formats-card">
              <h4>Nord Sample Library</h4>
              <div className="chips">
                <FormatChip accent>.nsmp</FormatChip><FormatChip accent>.nsmp3</FormatChip><FormatChip accent>.nsmp4</FormatChip>
              </div>
            </div>
            <div className="help-formats-card">
              <h4>Kontakt (legado)</h4>
              <div className="chips"><FormatChip accent>.nki</FormatChip></div>
            </div>
            <div className="help-formats-card">
              <h4>Logic EXS24 (novidade)</h4>
              <div className="chips"><FormatChip accent>.exs</FormatChip></div>
            </div>
            <div className="help-formats-card">
              <h4>SFZ (formato aberto)</h4>
              <div className="chips"><FormatChip accent>.sfz</FormatChip></div>
            </div>
            <div className="help-formats-card">
              <h4>MRQ Instrument (leve)</h4>
              <div className="chips"><FormatChip accent>.mrqi</FormatChip></div>
            </div>
          </div>
          <div className="help-callout warn">
            <b>Correção de estabilidade — SoundFont (.sf2/.sf3) grande demais fechava o programa:</b> o motor de
            SoundFont do Rack roda dentro de um WebAssembly com um teto de memória fixo; um arquivo <code>.sf2</code>{' '}
            muito grande (ex.: um piano "hiper-realista" de várias centenas de MB) podia estourar esse teto e fechar
            o programa inteiro sem aviso, em vez de só mostrar um erro. Agora, arquivos acima de ~400MB são recusados
            com um erro claro (em vez de travar o app) — se o seu SoundFont for grande assim, converta-o pra{' '}
            <code>.mrq</code> no <b>Conversor de Instrumentos</b> primeiro (ele lê o SoundFont com um decodificador
            nativo, sem esse teto de memória) e carregue o <code>.mrq</code> resultante na camada: mesmo som, sem
            esse risco.
          </div>
          <div className="help-callout warn">
            <b>Correção de estabilidade — SoundFont (.sf2) de QUALQUER tamanho podia fechar o programa:</b> depois do
            ajuste acima, alguns <code>.sf2</code> continuaram fechando o programa mesmo bem abaixo de 400MB — a causa
            era outra: o FluidSynth (o motor que o Rack usa pra tocar SoundFont) tem um bug conhecido numa versão mais
            antiga e rejeita o arquivo inteiro de forma fatal ao encontrar certos metadados extras que editores
            modernos de SoundFont (ex.: Polyphone) costumam gravar — mesmo sendo um arquivo 100% válido. Dentro do
            WebAssembly usado por este app, isso podia derrubar a janela inteira sem deixar nenhum rastro no log. Agora
            o MRQ remove esses metadados extras do arquivo (sem alterar o som, só informações como "feito com tal
            programa") antes de entregá-lo pro motor de SoundFont — se o seu <code>.sf2</code> fechava o programa
            mesmo sendo pequeno, teste de novo nesta versão. Se ainda assim fechar, use o <code>.mrq</code> via{' '}
            <b>Conversor de Instrumentos</b> (caminho totalmente separado, não afetado por esse bug) como alternativa.
          </div>
          <div className="help-callout warn">
            <b>Sobre o suporte a .nki:</b> o MRQ decodifica de verdade os patches <b>Kontakt 1 a 4</b> não criptografados
            (amostras/timbres — sem o motor de scripts do Kontakt). Patches protegidos por criptografia, ou salvos em
            versões 4.2.2 ou mais novas do Kontakt, não são suportados — o app mostra um erro claro nesses casos em
            vez de carregar algo incorreto.
          </div>
          <div className="help-callout">
            <b>Novidade — suporte a .exs (Logic EXS24):</b> o MRQ agora lê de verdade instrumentos <b>EXS24</b> da
            Apple/Logic Pro (<code>.exs</code>) — diferente do Kontakt, a Apple nunca criptografou esse formato, então
            o mapeamento de zonas (tecla/velocidade, afinação, ganho, pan) é decodificado por completo, igual é feito
            hoje com <code>.nki</code>. É suportado quando o instrumento referencia arquivos de amostra externos
            (<code>.wav</code>/<code>.aif</code> soltos ao lado do <code>.exs</code> ou numa biblioteca) — o caso mais
            comum em bibliotecas EXS24 "clássicas". Instrumentos gerados pelo <b>Auto Sampler</b> do Logic, que
            embutem todas as amostras dentro de um único arquivo de áudio consolidado, não são suportados — o Rack diz
            exatamente isso em vez de tocar algo quebrado. Scripts, efeitos e filtro/envelope do EXS24 também não são
            transferidos (só o mapeamento de amostras, que é o que o Rack realmente toca). Pra usar: carregue o
            <code>.exs</code> numa camada do Rack normalmente, ou converta-o pra <code>.mrqi</code>/.mrq no{' '}
            <b>Conversor de Instrumentos</b> (ver abaixo).
          </div>
          <div className="help-callout">
            <b>Novidade — formato .mrqi (instrumento leve do Rack):</b> depois de carregar um instrumento Kontakt
            (<code>.nki</code>) numa camada, abra o painel <b>"Editar"</b> dessa camada e clique no botão com o ícone
            de seta pra baixo, no canto superior esquerdo do painel (ao lado do botão de resetar), pra converter o
            instrumento pro formato <code>.mrqi</code> — escolha onde salvar na janela que abrir. Diferente do
            <code>.nki</code> original (que precisa reler e redecodificar cada amostra WAV do disco toda vez que a
            camada carrega), um <code>.mrqi</code> já guarda o áudio pronto pra tocar dentro de um único arquivo — por
            isso ele abre bem mais rápido nas próximas vezes. Pra usar: carregue o <code>.mrqi</code> gerado em
            qualquer camada do Rack, do mesmo jeito que carregaria qualquer outro instrumento (botão
            <b>"Carregar"</b>). O conteúdo musical (mapeamento de notas, velocidade, afinação, timbres) é o mesmo do
            instrumento original — só a forma de guardar o áudio muda.
          </div>
          <div className="help-callout warn">
            <b>Quer usar um instrumento do Kontakt 5, 6, 7 ou 8?</b> O formato desses arquivos é criptografado pela
            Native Instruments e não existe forma legítima de lê-lo de fora do Kontakt — nenhum app consegue isso sem
            usar sua cópia licenciada do programa. O caminho seguro e gratuito é: (1) abra o instrumento no seu
            próprio Kontakt; (2) se as amostras forem <code>.ncw</code>, use <b>Files → Batch Resave → Uncompressed
            WAV/AIF</b> (função oficial do Kontakt) pra gerar <code>.wav</code> comuns; (3) use o <b>Creator
            Tools / Instrument Editor</b> do Kontakt pra rodar um script de exportação pra SFZ (existem scripts
            prontos e gratuitos, inclusive um da Chicken Systems, que leem os grupos/zonas do instrumento carregado
            e geram o texto <code>.sfz</code>) — isso usa só a API oficial de script do Kontakt, não quebra nenhuma
            proteção; (4) carregue o <code>.sfz</code> resultante numa camada do Rack normalmente. Scripts, efeitos e
            interface customizada do Kontakt não são transferidos nesse processo — só o mapeamento de
            amostras/timbres, que é o que o Rack toca.
          </div>

          <h3 style={{ fontSize: 13.5, marginTop: 18 }}>Configurando cada camada</h3>
          <ol>
            <li>Clique em <b>"Carregar"</b> no cartão da camada e escolha o arquivo do instrumento no seu computador.</li>
            <li>
              Se o arquivo tiver múltiplos sons dentro (ex.: um SoundFont com vários instrumentos), escolha o
              desejado em <b>Instrumento</b>.
            </li>
            <li><b>Caráter</b> aplica uma coloração rápida ao timbre (predefinições de EQ/filtro).</li>
            <li>O fader vertical ajusta o volume da camada; <b>M</b>/<b>S</b> no cabeçalho mudam/isolam a camada.</li>
            <li>O <b>X</b> remove o instrumento carregado daquela camada.</li>
          </ol>

          <h3 style={{ fontSize: 13.5, marginTop: 18 }}>Ajustes avançados ("Editar")</h3>
          <div className="help-grid-2">
            <div>
              <p>Clicar em <b>"Editar"</b> abre o painel completo de ajustes daquela camada:</p>
              <ul>
                <li><b>Nota inicial/final</b> — a faixa de teclas do teclado físico que essa camada responde (dá pra "aprender" tocando as duas teclas extremas), útil pra dividir o teclado em zonas (graves = baixo, agudos = cordas, por exemplo).</li>
                <li><b>Oitava</b> e <b>Canal MIDI</b> — transposição e filtro de canal de entrada.</li>
                <li><b>Pan</b> — posição estéreo da camada.</li>
                <li><b>Nota raiz da amostra</b> — só no formato "amostra única": em que nota o som original foi gravado.</li>
                <li><b>Envelope</b> (Attack/Decay/Release) e <b>Filtro</b> (cutoff) — processamento de som por camada.</li>
                <li><b>Escolher foto / Foto padrão</b> — personaliza a capa do cartão da camada com uma imagem própria.</li>
                <li>O botão de reset (seta circular) no topo volta envelope/filtro/EQ/drive/pan pro padrão.</li>
              </ul>
            </div>
            <Figure src="help-rack-editar.png" alt="Painel de ajustes de uma camada do Rack" caption="Faixa de notas, envelope, filtro, EQ, drive e foto personalizada da camada." />
          </div>

          <h3 style={{ fontSize: 13.5, marginTop: 18 }}>Novidade — Envelope com Decay, e Modo de voz (Poly/Mono/Legato/Glide)</h3>
          <p>
            O <b>Envelope</b> agora tem três estágios — <b>Attack</b>, <b>Decay</b> e <b>Release</b> — em vez de só
            Attack/Release: depois do ataque, o som desce sozinho até um nível interno de sustentação no tempo
            definido em Decay (0 = pula essa etapa, igual ao comportamento de antes). Logo abaixo, a seção{' '}
            <b>"Modo de voz"</b> controla como a camada reage a notas sobrepostas:
          </p>
          <ul>
            <li><b>Play mode — Poly</b>: cada nota toca numa voz independente (acordes normais, o padrão de sempre).</li>
            <li>
              <b>Play mode — Mono</b>: só uma nota soa por vez nesta camada (clássico pra baixo, lead ou sopro/corda
              solo) — tocar uma nota nova corta a anterior e segue a prioridade da última nota tocada (se você soltar
              a nota de cima, a camada volta pra nota de baixo que ainda estiver segurada, igual um sintetizador mono
              de verdade).
            </li>
            <li>
              <b>Legato</b> (só tem efeito em modo Mono): se uma nota nova chegar sem soltar a anterior, a camada{' '}
              <b>não reataca o envelope</b> — em vez disso desliza a afinação da mesma voz até a nota nova, no tempo
              definido em <b>Glide</b>. Em instrumentos SoundFont (.sf2/.sf3) o deslizamento fica limitado a ±2
              semitons (a faixa de pitch bend padrão do formato); nos demais formatos não há esse limite.
            </li>
          </ul>

          <h3 style={{ fontSize: 13.5, marginTop: 18 }}>Novidade — Equalizador paramétrico de 6 bandas</h3>
          <p>
            Substitui o antigo EQ de 3 bandas por um equalizador de verdade, com 6 bandas fixas — <b>Corte grave</b>{' '}
            (highpass), <b>Prateleira grave</b>, <b>Sino 1</b>, <b>Sino 2</b>, <b>Prateleira aguda</b> e{' '}
            <b>Corte agudo</b> (lowpass) — cada uma com Frequência, Ganho (exceto nos cortes, que só têm Q) e Q, mais
            um interruptor individual de liga/desliga. O gráfico mostra a curva de resposta real (a mesma matemática
            que o navegador usa pra processar o áudio, calculada ao vivo pelos filtros de verdade, não um desenho
            aproximado):
          </p>
          <ul>
            <li><b>Arraste um ponto</b> no gráfico pra mudar a frequência (e o ganho, nas bandas que têm ganho) daquela banda.</li>
            <li><b>Gire o scroll</b> com o mouse sobre um ponto pra ajustar o Q (largura/inclinação) daquela banda.</li>
            <li>
              <b>Spectrum: Post</b> sobrepõe ao gráfico o espectro de frequência real do áudio desta camada, medido
              depois do EQ — ajuda a ver exatamente onde o som tem energia antes de decidir onde cortar/realçar.
            </li>
          </ul>

          <h3 style={{ fontSize: 13.5, marginTop: 18 }}>Novidade — Compressor (Amount), Tremolo, Chorus e Delay com Sync/Ping-pong</h3>
          <ul>
            <li>
              <b>Compressor</b> ganhou um controle único, <b>Amount</b>, que ajusta threshold/razão/ganho de
              compensação juntos (quanto mais alto, mais compressão), além de <b>Attack</b>/<b>Release</b> próprios,
              um botão <b>Fast</b> (liga um ataque/soltura bem rápidos fixos — modo "limitador" — e desativa os
              knobs Attack/Release enquanto estiver ligado) e um medidor <b>GR</b> (redução de ganho) mostrando
              quanto ele está atuando agora, ao vivo.
            </li>
            <li>
              <b>Tremolo</b> (novo): modula o volume periodicamente — <b>Rate</b> (velocidade), <b>Depth</b>{' '}
              (intensidade) e <b>Stereo</b> (soma um pouco do mesmo LFO ao pan da camada, pra um efeito de "auto-pan"
              junto com a variação de volume).
            </li>
            <li>
              <b>Chorus</b> (novo): engrossa/alarga o timbre com uma modulação sutil de afinação — um controle só,{' '}
              <b>Mix</b>, do seco até bem encorpado.
            </li>
            <li>
              <b>Delay</b> ganhou <b>Sync</b> (o tempo do eco segue o <b>BPM</b> do rack — ajustável no MASTER — em
              vez de milissegundos fixos, com divisões de 1/16 a 1/2, incluindo pontuadas e tercinas),{' '}
              <b>Ping-pong</b> (o eco alterna entre os canais esquerdo/direito a cada repetição, em vez de ficar
              sempre no mesmo lado), <b>Analog</b> (caráter de eco de fita: satura levemente cada repetição e
              adiciona uma oscilação sutil de afinação, como uma fita de verdade com variação de velocidade do
              motor), <b>Filter</b> (escurece/afina/deixa tipo-rádio cada repetição: Off/Low/High/Band) e{' '}
              <b>Tap</b> (clique no ritmo da música 2 vezes ou mais pra ajustar o Tempo do eco por batida, em vez de
              girar o knob — desliga o Sync automaticamente, já que aí o tempo vira manual).
            </li>
          </ul>
          <p className="help-callout">
            <b>Reverb por camada</b> chama o controle de envio de <b>"Amount"</b> (mesmo campo de sempre, só com nome
            igual ao de plugins conhecidos) — o reverb em si é um retorno <b>compartilhado por todas as 8 camadas</b>{' '}
            (não dá pra ter uma "sala" diferente em cada uma ao mesmo tempo sem pesar demais no processador), e mora
            na coluna <b>MASTER</b>, dentro do módulo <b>Reverb</b>. Esse módulo foi reconstruído do zero como um{' '}
            <b>reverb algorítmico tipo plate</b> (arquitetura de Dattorro — predelay, difusão de entrada e um
            "tanque" com duas metades moduladas cruzadas entre si, a mesma base técnica por trás de plugins como o
            Valhalla VintageVerb), no lugar do reverb por resposta impulsiva (convolução) de versões anteriores —
            pensado pra ter mais corpo e "punch" em caixas de som (PA), com os seguintes controles:
          </p>
          <ul>
            <li>
              <b>Mode</b>: lista com 6 tipos de espaço (<b>Room, Stage, Hall, Booth, Plate, Spring</b> — clique num
              da lista e depois em <b>SELECT</b> pra aplicar). Cada um ajusta de uma vez os knobs de{' '}
              <b>Size/Diffusion/Damping/Mod</b> pra um ponto de partida típico daquele espaço — depois disso, todos
              esses knobs continuam livres pra ajustar na mão, igual nos plugins de referência.
            </li>
            <li>
              <b>Mix</b> (retorno geral, era "Amount"), <b>Predelay</b> (atraso antes da cauda começar, separa o
              ataque seco do início do reverb) e <b>Decay</b> (tempo de decaimento da cauda, em segundos).
            </li>
            <li>
              <b>Shape: Size</b> (tamanho do "tanque" interno — espaço maior/menor) e <b>Attack</b> (mistura um tap
              mais cedo/direto da difusão de entrada com a cauda cheia — mais Attack = ataque mais rápido/denso).
            </li>
            <li>
              <b>Diffusion: Early</b> (difusão na entrada, antes do tanque — borra o transiente de entrada) e{' '}
              <b>Late</b> (difusão dentro do próprio tanque — controla se a cauda soa mais "eco" ou mais lisa/densa).
            </li>
            <li>
              <b>Damping: HighFreq</b> (corta agudo dentro do tanque — controla a velocidade com que os agudos somem
              da cauda) e <b>BassMult</b> (multiplicador do tempo de decaimento dos graves em relação ao Decay geral
              — acima de 1x os graves "seguram" mais, abaixo somem mais rápido).
            </li>
            <li>
              <b>Mod: Rate/Depth</b> (um LFO sutil modulando o tanque por dentro — evita colorações metálicas e dá
              vida/movimento à cauda, técnica clássica de reverbs de plate).
            </li>
            <li>
              <b>EQ: LowCut/HighCut</b> no retorno final (diferente do Damping, que só afeta a velocidade de
              decaimento dos agudos dentro do tanque — o EQ aqui é o brilho/peso geral do retorno).
            </li>
            <li>
              <b>Color</b>: <b>1970s</b> acrescenta uma saturação bem sutil dentro do loop do tanque (o "warmth" de
              reverbs de hardware/plate antigos) e <b>Modern</b> deixa o loop limpo/linear.
            </li>
          </ul>
          <p>
            O campo <b>BPM</b> (usado pelos delays com Sync ligado) fica logo abaixo desse módulo, na mesma coluna.
          </p>

          <h3 style={{ fontSize: 13.5, marginTop: 18 }}>Teclado MIDI físico, latência e teclado virtual</h3>
          <p>
            Com a aba Rack aberta, a barra superior mostra a pílula de status do <b>teclado MIDI</b>. Clicando nela
            você escolhe o dispositivo conectado, a <b>curva de velocidade</b> (linear/suave/dura), uma{' '}
            <b>transposição global</b>, liga/desliga o <b>pedal de sustain</b> e ajusta o <b>tamanho do buffer de
            áudio</b> — buffers menores respondem mais rápido ao toque (menos latência) porém exigem mais do
            processador; buffers maiores são mais estáveis mas com mais atraso. O painel mostra a latência real
            medida, não só a solicitada.
          </p>
          <p>
            A tira <b>"Teclado virtual"</b>, na parte de baixo da tela, é tocável de verdade (não é só um visor) —
            dá pra tocar com o mouse, pelo teclado do computador, ou pelo teclado MIDI físico ao mesmo tempo, e as
            três formas acendem as teclas em tempo real. Também mostra (quando configurado) a faixa de notas de
            cada camada embaixo do teclado. Controles disponíveis (clique no cabeçalho pra minimizar a tira):
          </p>
          <ul>
            <li>
              <b>Clique/arraste nas teclas</b> — toca a nota embaixo do mouse; a <b>altura vertical do clique</b>{' '}
              dentro da tecla define a força/velocity (clicar perto do topo = forte, perto da base = fraco), igual
              um teclado sensível ao toque. Arrastar o botão pressionado de uma tecla pra outra faz glissando (desliza
              a nota sem precisar soltar e clicar de novo).
            </li>
            <li>
              <b>Digitação musical pelo teclado do computador</b> — clique uma vez na área das teclas pra "armar"
              (aparece um contorno colorido) e toque com <kbd>A S D F G H J K L</kbd> (teclas brancas),{' '}
              <kbd>W E T Y U O P</kbd> (pretas) e <kbd>Z</kbd>/<kbd>X</kbd> pra descer/subir uma oitava — mesmo mapa
              do "Musical Typing" do GarageBand. Só funciona com o foco nessa área (clicado nela antes), pra não
              conflitar com os atalhos globais do app (espaço, setas, <kbd>L</kbd> de loop etc.).
            </li>
            <li>
              <b>Curva de velocidade</b> (linear/suave/dura) — mesmo ajuste do teclado MIDI físico (painel da pílula
              acima), com uma mini curva desenhada ao lado; muda a força calculada tanto pro MIDI físico quanto pro
              clique do mouse e pela digitação musical, porque é o mesmo ajuste salvo nas configurações.
            </li>
            <li>
              <b>TOM</b> — régua vertical de pitch bend (dobra de afinação); arrasta pra cima/baixo enquanto toca e
              volta sozinha ao centro ao soltar, igual a roda de pitch bend de um teclado de verdade. Afeta todas as
              camadas, independente do canal MIDI configurado em cada uma.
            </li>
            <li>
              <b>MOD</b> — régua vertical de vibrato; ao contrário do TOM, ela <b>não volta</b> sozinha — fica na
              posição em que foi solta, controlando a intensidade de um vibrato aplicado por cima do TOM.
            </li>
            <li>
              <b>OITAVA +</b>/<b>OITAVA -</b> — sobe/desce uma oitava (12 semitons) a mesma transposição global do
              controle "Transposição global" da coluna Master; o indicador no meio mostra a nota mais grave do
              teclado após a transposição (ex.: <code>A0</code>).
            </li>
            <li>
              <b>PÂNICO</b> — equivalente ao botão "Parar notas" da coluna Master e à tecla <kbd>Esc</kbd>: corta
              instantaneamente qualquer nota travada (física, por clique ou por digitação) e zera o TOM.
            </li>
            <li>
              <b>Linha de status</b> (rodapé da tira) — mostra o motor de áudio, a taxa de amostragem real, o
              tamanho do buffer configurado e se o motor está ativo, só informativo.
            </li>
          </ul>
          <p>
            Ao lado da pílula "Áudio OK", uma pílula roxa mostra em tempo real o <b>acorde</b> formado por todas as
            notas tocadas agora (juntando as notas de todas as camadas e canais MIDI), na nomenclatura de{' '}
            <b>cifra brasileira</b> (ex.: sétima maior = <code>C7M</code>, não "Cmaj7"). Reconhece tríades, sétimas
            (7, 7M, m7, m(7M), m7(b5), dim7), sus2/sus4, 6ª, 6/9, 9ª, 9M, m9, add9, 11ª, 13ª, dominantes alteradas
            (7(b5), 7(#5), 7(b9), 7(#9)), diminuto, aumentado, power chords e inversões (mostradas como "Acorde/Baixo",
            ex.: <code>C/E</code>). A pílula tem tamanho fixo e fica sempre visível — só o texto do acorde dentro
            dela muda, pra não "balançar" a barra de título a cada nota tocada (a largura foi aumentada nesta versão
            pra caber até o pior caso, ex.: <code>C#7M(#11)/C#</code>, sem cortar). Pode ser desligada em{' '}
            <b>"Mostrar acorde detectado"</b>, no mesmo painel do teclado MIDI físico descrito acima.
          </p>
          <p>
            <b>Novidade:</b> esse mesmo acorde agora também é transmitido ao vivo pro(s) celular(es) conectado(s) via{' '}
            <b>Controle remoto</b> (ver seção <i>Controle remoto</i> abaixo) — todo mundo da banda vê o mesmo acorde
            na tela do próprio aparelho, não só quem está no computador com o Rack aberto.
          </p>

          <h3 style={{ fontSize: 13.5, marginTop: 18 }}>Reverb, compressor e delay por camada</h3>
          <p>
            Além do reverb geral do MASTER (quantidade de retorno), cada camada tem seu próprio <b>envio de reverb</b>{' '}
            (quanto dela entra no barramento compartilhado — ligado e em 100% por padrão, igual sempre foi), um{' '}
            <b>compressor</b> (controle único <b>Amount</b>, mais Attack/Release e um medidor GR) e um{' '}
            <b>delay/eco</b> (tempo ou Sync, realimentação, mistura seco/molhado e Ping-pong) — tudo no painel
            "Editar" de cada camada, nos módulos abaixo do Drive.
          </p>

          <h3 style={{ fontSize: 13.5, marginTop: 18 }}>Novidade — visual de rack de verdade (knobs) e 5 novos efeitos</h3>
          <p>
            O painel "Editar" de cada camada foi reorganizado pra parecer um <b>rack de pedais/plugins de verdade</b>:
            cada efeito agora é um "módulo" com cantos arredondados, parafusos decorativos nos cantos e um{' '}
            <b>LED liga/desliga</b> no cabeçalho (clique nele pra ativar/desativar o efeito), no lugar da antiga grade
            corrida de controles. Os ajustes numéricos viraram <b>knobs giratórios</b> (como um plugin de DAW ou um
            pedal de efeito real) em vez de barras deslizantes simples:
          </p>
          <ul>
            <li><b>Arraste pra cima/baixo</b> em cima de um knob pra aumentar/diminuir o valor (quanto mais você arrasta, mais ele muda — não importa se o mouse sai de cima do desenho redondo, continue segurando e arrastando).</li>
            <li><b>Duplo-clique</b> num knob volta ele pro valor padrão de fábrica daquele parâmetro.</li>
            <li><b>Scroll do mouse</b> em cima de um knob faz um ajuste fino, passo a passo.</li>
          </ul>
          <p className="help-callout">
            <b>Correção</b>: um bug fazia o knob "travar" depois de mover só 1 pixel dentro do mesmo arraste (dava
            pra soltar e pegar de novo pra continuar ajustando, mas não dava pra fazer um arraste longo contínuo) —
            já corrigido; agora qualquer knob do Rack acompanha o mouse do início ao fim do gesto.
          </p>
          <p>
            Essa reorganização trouxe junto <b>5 efeitos novos por camada</b>, que não existiam antes — cada um no seu
            próprio módulo, entre o Compressor e o Delay:
          </p>
          <ul>
            <li>
              <b>Gate</b> (porta de ruído): silencia automaticamente o sinal sempre que ele cai abaixo do{' '}
              <b>Threshold</b> — útil em captações/amostras com chiado ou ruído de fundo constante. <b>Attack</b>{' '}
              controla a rapidez com que a porta abre quando o som volta, <b>Release</b> a rapidez com que ela fecha
              no silêncio; o medidor mostra "Aberto"/"Fechado" em tempo real.
            </li>
            <li>
              <b>Phaser</b>: quatro filtros em cascata modulados por um LFO lento, dando o giro/"swoosh" clássico de
              pedal de phaser — <b>Rate</b> (velocidade do giro), <b>Depth</b> (intensidade da modulação) e{' '}
              <b>Mix</b> (seco/efeito).
            </li>
            <li>
              <b>Flanger</b>: delay bem curto modulado com realimentação, som metálico/"jato de avião" — <b>Rate</b>,{' '}
              <b>Depth</b>, <b>Feedback</b> (quanto mais alto, mais metálico/ressonante) e <b>Mix</b>.
            </li>
            <li>
              <b>Lo-Fi</b> (bitcrusher): reduz de propósito a resolução do áudio — <b>Bits</b> (quanto menor, mais
              "quadrado"/digital o som) e <b>Rate</b> (taxa de amostragem reduzida; quanto menor, mais abafado/retrô),
              mais <b>Mix</b>.
            </li>
            <li>
              <b>Shimmer</b> (redesenhado com todos os controles de plugins de referência como o Valhalla Shimmer):
              um <b>pitch shifter dentro do próprio loop de realimentação</b> de uma rede de difusão/delay (não um
              deslocamento seguido de reverb — o shifter faz parte do loop, é isso que dá a textura etérea
              característica). É diferente do Reverb normal da camada (que é grave/tipo "sala"): aqui o efeito é
              todo autocontido nesta camada, sem usar o barramento de reverb compartilhado do MASTER. Controles:
              <ul>
                <li><b>Mix</b> (seco/efeito) e <b>Feedback</b> (realimentação do loop — quanto maior, mais longa a cauda e mais evidente o deslocamento de afinação).</li>
                <li><b>Shift</b>: -12 a +12 semitons — o clássico "shimmer" é +12 (uma oitava acima) com Feedback alto; valores negativos descem a afinação.</li>
                <li><b>Diffusion</b>: dois allpasses dentro do loop — baixo soa mais "eco repetindo", alto vira uma cauda lisa e densa.</li>
                <li><b>Size</b>: um delay extra dentro do loop — dá sensação de tamanho de espaço, independente do Feedback.</li>
                <li><b>Low Cut/High Cut</b>: filtros passa-alta/passa-baixa dentro do loop (o antigo "Tone" virou High Cut) — tiram grave/agudo da cauda a cada repetição.</li>
                <li><b>Mod Rate/Mod Depth</b>: um LFO sutil modulando o loop — dá movimento/vida à cauda, evita soar estático.</li>
                <li><b>Reverb Mode</b>: Mono (loop centralizado, artefato de pitch mais evidente/"cru") ou Stereo (soma um 2º canal decorrelacionado — cauda mais larga e suave).</li>
                <li><b>Pitch Mode</b>: Single (desloca só na direção do Shift — clássico Eno/Lanois) ou Dual (desloca pra cima E pra baixo ao mesmo tempo — mais denso/sinfônico).</li>
                <li><b>Color</b>: atalhos Dark/Bright que ajustam Low Cut e High Cut juntos (equivalente ao Escuro/Claro do Reverb MASTER, só que para a cauda do Shimmer).</li>
              </ul>
            </li>
          </ul>

          <h3 style={{ fontSize: 13.5, marginTop: 18 }}>Oitavador por camada</h3>
          <p>
            No painel "Editar" de cada camada (abaixo do Delay), o <b>oitavador</b> dobra toda nota tocada{' '}
            <b>nessa camada</b> numa oitava <b>abaixo</b>, <b>acima</b> ou <b>ambas</b>, com um volume relativo
            ajustável — útil pra engrossar o timbre dela (ex.: dar um "sub" por baixo de um piano) sem precisar
            duplicar manualmente o instrumento numa segunda camada transposta. É independente por camada: pode ligar
            numa e deixar as outras de fora.
          </p>

          <h3 style={{ fontSize: 13.5, marginTop: 18 }}>Arpejador por camada</h3>
          <p>
            O Rack agora tem <b>8 camadas</b> (antes eram 6, depois 7) — cada camada nova vem com as mesmas opções de
            todas as outras, incluindo o módulo <b>Arpejador</b>, o último do painel "Editar" (depois do Oitavador).
            Isso vale até pra <b>CAMADA 08 · PAD</b> (a camada de pads coloridos): por fora ela parece um instrumento
            diferente, mas o botão <b>Editar</b> abre o mesmo painel completo das outras 7, com Caráter, EQ,
            Compressor, Delay, Oitavador e Arpejador. Esse
            módulo liga um sequenciador: em vez de cada nota segurada soar normalmente, elas alimentam um "pool" que
            o arpejador dispara uma a uma (ou todas juntas, no modo Acorde) num ritmo fixo. Enquanto ele estiver{' '}
            <b>ligado</b>, o modo de voz da camada (Poly/Mono/Legato) e o Oitavador por camada não têm efeito — é o
            arpejador quem decide quais notas soam e quando.
          </p>
          <ul>
            <li>
              <b>Padrão</b> (select no topo do módulo): <b>Subindo</b>/<b>Descendo</b> percorrem as notas seguradas
              (+ oitavas extras) da mais grave pra mais aguda ou o contrário; <b>Sobe-desce</b>/<b>Desce-sobe</b> vão
              e voltam sem repetir a nota do topo/base; <b>Ordem tocada</b> segue a ordem em que você pressionou as
              teclas (não reordena por altura); <b>Aleatório</b> sorteia uma nota do conjunto a cada passo;{' '}
              <b>Acorde</b> toca todas as notas seguradas juntas a cada passo, como uma batida rítmica.
            </li>
            <li>
              <b>Sync</b> (botão com LED): quando ligado, a velocidade segue o <b>BPM</b> do Rack na divisão de
              compasso escolhida ao lado (1/4 até 1/32, com variantes em tercina); quando desligado, aparece um knob{' '}
              <b>Rate</b> (Hz) pra ajustar a velocidade livremente, sem depender do BPM.
            </li>
            <li>
              <b>Hold</b> (botão com LED, modo "latch"): quando ligado, o arpejador continua tocando o acorde mesmo
              depois de você soltar as teclas — toque um conjunto de notas novo pra substituir o anterior, ou
              desligue o Hold pra voltar ao normal (precisa segurar as teclas pra ouvir).
            </li>
            <li><b>Oitavas</b>: quantas oitavas acima das notas seguradas o arpejador percorre (1 a 4).</li>
            <li>
              <b>Gate</b>: por quanto tempo de cada passo a nota soa antes de ser cortada — baixo soa mais
              "picotado"/staccato, no máximo (100%) a nota quase não solta até o próximo passo.
            </li>
            <li>
              <b>Swing</b>: alterna passos mais longos/curtos pra dar um balanço (feel) às subdivisões, sem mudar a
              velocidade média geral.
            </li>
          </ul>

          <h3 style={{ fontSize: 13.5, marginTop: 18 }}>Transposição global no MASTER</h3>
          <p>
            A coluna MASTER também tem um controle de <b>transposição global</b> (±24 semitons) — o mesmo das
            configurações de MIDI do teclado físico (ícone de piano na barra de título), só que acessível direto na
            tela do Rack. Afeta toda nota antes de chegar em qualquer camada.
          </p>

          <h3 style={{ fontSize: 13.5, marginTop: 18 }}>Mapeamento de controles por MIDI CC</h3>
          <p>
            No painel de MIDI do Rack (ícone de piano na barra de título), a seção <b>"Mapear controles (CC)"</b>{' '}
            deixa associar botões/faders físicos do seu teclado controlador a ações do Rack: volume e transposição
            do MASTER, e por camada — volume, mudo, solo e oitavador. Clique em "Aprender" e mexa o controle físico
            — faders mandam o valor contínuo (0-127) direto pro parâmetro; botões alternam liga/desliga a cada
            toque.
          </p>

          <h3 style={{ fontSize: 13.5, marginTop: 18 }}>Cenas do Rack (snapshots por Program Change)</h3>
          <p>
            Salve a configuração completa das 8 camadas (instrumentos, volumes, master, reverb) como uma{' '}
            <b>Cena do Rack</b> em <b>"Salvar cena atual"</b>. Cada cena salva fica associada a um número de{' '}
            <b>Program Change</b> do teclado físico — ou seja, dá pra trocar o "patch" inteiro do Rack ao vivo
            apertando um botão de PC no teclado, sem tocar no mouse.
          </p>
          <p>
            A coluna <b>MASTER</b> reúne o volume geral do Rack, um envio de <b>reverb</b> compartilhado e o botão{' '}
            <b>"Parar notas"</b> (pânico manual).
          </p>
          <p>
            Por fim, dentro da própria aba Rack existe um <b>painel de Música</b> minimizável, com o transporte
            (tocar/pausar/parar) e o roteiro de partes da música atualmente aberta no Setlist — assim quem está
            tocando os instrumentos do Rack ao vivo também consegue comandar a faixa de apoio sem trocar de aba.
          </p>
        </section>

        {/* ---------------- CONVERSOR DE INSTRUMENTOS ---------------- */}
        <section className="help-section" id="conversor">
          <SectionHead
            icon={Replace}
            title="Conversor de instrumentos (.mrq)"
            purpose="Converter um instrumento de outro formato (Kontakt, EXS24, SoundFont...) pro formato leve e nativo .mrq, fora do Rack"
          />
          <div className="help-callout">
            <b>Só na versão Tauri do MRQ</b> (ícone <code>Conversor de instrumentos</code> na barra lateral, abaixo do
            Rack) — na versão Electron legada essa tela não aparece.
          </div>
          <p>
            Diferente de carregar um instrumento direto numa camada do Rack, o Conversor serve pra transformar o
            arquivo original (<code>.nki</code>, <code>.exs</code>, <code>.sf2</code>/<code>.sf3</code>,{' '}
            <code>.npno</code>, <code>.nsmp</code>, <code>.syx</code> ou uma amostra solta) num arquivo{' '}
            <code>.mrq</code> — o formato nativo do MRQ, que já guarda o áudio decodificado pronto pra tocar (abre
            bem mais rápido depois, igual o <code>.mrqi</code> do Rack) e pode ser redistribuído sem depender do
            programa original.
          </p>
          <ol>
            <li>Clique em <b>"Escolher arquivos..."</b> e selecione um ou vários instrumentos.</li>
            <li>
              O inspetor mostra o que foi lido de verdade do arquivo: presets/grupos/zonas, amostras únicas, faixa de
              notas/velocidade e, na aba <b>Compatibilidade</b>, uma lista honesta do que é{' '}
              <b>Preservado</b> (lido e convertido fielmente), <b>Aproximado</b> (convertido com alguma limitação
              documentada) e <b>Não suportado</b> (recursos do formato original que o conversor não reimplementa,
              como scripts/efeitos/motor de modulação) — nunca omitido.
            </li>
            <li>
              Se faltar alguma amostra (arquivo <code>.nki</code>/<code>.exs</code> que referencia um <code>.wav</code>{' '}
              que não está do lado), o item mostra quantas não foram encontradas — clique no ícone de pasta pra
              apontar a pasta raiz da biblioteca e tentar resolver.
            </li>
            <li>
              <b>Novidade — Editor de Mapeamento:</b> antes de converter, clique em{' '}
              <b>"Editar mapeamento"</b> na pré-visualização do instrumento pra abrir uma tela cheia, parecida com o
              editor de mapas do Kontakt: lista de grupos (clique pra filtrar quais zonas aparecem), a grade de zonas
              coloridas alinhada sobre um teclado, e um formulário por zona pra ajustar <b>nota raiz</b> (com o nome da
              nota ao vivo), <b>afinação</b> (cents), <b>faixa de teclas</b> (grave/aguda), <b>faixa de velocity</b>,{' '}
              <b>volume</b> e <b>pan</b>. Dá pra clicar direto numa tecla do teclado desenhado pra definir a nota raiz
              ou os limites da zona, em vez de digitar o número MIDI. "Restaurar zona" desfaz só a zona atual;
              "Reverter tudo" descarta todas as edições feitas na tela.
            </li>
            <li>Clique em <b>"Converter para .mrq"</b> e escolha onde salvar.</li>
          </ol>
          <div className="help-callout">
            <b>As edições do Editor de Mapeamento entram de verdade no arquivo exportado</b> para instrumentos vindos
            de <code>.syx</code>, <code>.nki</code> e <code>.exs</code> — o <code>.mrq</code> salvo já sai com a nota
            raiz/afinação/faixas/volume/pan que você ajustou na tela, não é só uma visualização. Para os demais
            formatos (SF2/SF3, NPNO/NSMP, amostra solta, captura de áudio do Kontakt), a edição ainda funciona na
            tela e pode ser revisada antes de converter, mas por enquanto fica só durante aquela sessão — uma versão
            futura vai estender a gravação de verdade pra esses formatos também. O recorte do início/fim de cada
            amostra ("quanto da amostra toca"), loop e fade ainda não estão nesta tela — ficam para uma próxima
            etapa.
          </div>
          <Figure
            src="help-converter-mapping-editor.png"
            alt="Editor de Mapeamento aberto no Conversor de Instrumentos, mostrando grupos, zonas coloridas sobre um teclado e o formulário de edição de uma zona selecionada"
            caption="Novidade — Editor de Mapeamento: grupos, grade de zonas sobre o teclado e edição de nota raiz/afinação/faixas/volume/pan por zona, antes de converter."
          />
          <Figure
            src="help-converter-exs.png"
            alt="Conversor de Instrumentos com um instrumento Logic EXS24 (.exs) importado, mostrando presets, grupos, zonas e faixa de notas"
            caption="Novidade — .exs (Logic EXS24) no Conversor: o mesmo inspetor já usado para .nki/.sf2/.syx, agora também lendo EXS24."
          />
          <Figure
            src="help-converter-exs-compat.png"
            alt="Aba Compatibilidade do inspetor, mostrando o que foi preservado, aproximado e não suportado na conversão de um .exs"
            caption="A aba Compatibilidade nunca esconde limitação: aqui, o que o conversor de .exs preserva, aproxima e não suporta."
          />
        </section>

        {/* ---------------- CONTROLE REMOTO ---------------- */}
        <section className="help-section" id="remoto">
          <SectionHead icon={Smartphone} title="Controle remoto pelo celular" purpose="Controlar o transporte da música a partir de um navegador no celular, na mesma rede Wi-Fi" />
          <div className="help-grid-2">
            <div>
              <p>
                Liga um pequeno servidor local (sem precisar de internet, só a mesma rede Wi-Fi do computador) que
                você acessa pelo navegador do celular pra tocar/pausar/pular partes de longe — útil pra quem opera o
                som de fora do palco ou quer liberar as mãos de quem está no instrumento.
              </p>
              <ol>
                <li>Abra <b>Ajustes → Remoto</b> e deixe <b>"Controle pelo celular"</b> como <b>Ligado</b>.</li>
                <li>Confira a <b>porta</b> (padrão 8787) e defina um <b>PIN</b> de 4 dígitos pra evitar acesso indevido.</li>
                <li>No celular, conectado na mesma rede, escaneie o <b>QR code</b> ou digite o endereço mostrado.</li>
              </ol>
              <div className="help-callout warn">
                O celular precisa estar na <b>mesma rede local</b> do computador (mesmo roteador/Wi-Fi). Em redes de
                evento com "isolamento de clientes" ativado, o celular pode não conseguir enxergar o computador — nesse
                caso use um roteador próprio ou ponto de acesso dedicado para o show.
              </div>
            </div>
            <Figure src="help-settings-remote.png" alt="Configuração do controle remoto com QR code" caption="Porta, PIN e QR code pra abrir o controle remoto no navegador do celular." />
          </div>
          <p>
            <b>Novidade:</b> a tela do controle remoto agora também mostra, bem grande, o <b>acorde ao vivo</b>
            detectado no Rack de instrumentos (quando houver) — como todos os celulares conectados recebem o mesmo
            estado, cada músico da banda pode ter o próprio aparelho mostrando o acorde atual sem precisar olhar pra
            um só monitor central.
          </p>
        </section>

        {/* ---------------- OSC / MRQ SYNC ---------------- */}
        <section className="help-section" id="osc">
          <SectionHead icon={Radio} title="OSC / MRQ Sync" purpose="Duas tecnologias novas: ponte OSC com software externo de produção, e sincronismo entre instâncias do MRQ na rede" />
          <div className="help-grid-2">
            <div>
              <h3 style={{ fontSize: 13.5, marginTop: 0 }}>Ponte OSC (Open Sound Control)</h3>
              <p>
                OSC é o protocolo usado por softwares de produção ao vivo — <b>QLab</b>, <b>Resolume</b>,{' '}
                <b>TouchOSC</b>, consoles de iluminação — pra trocar comandos de transporte e automação pela rede.
                Em <b>Ajustes → OSC / Sync</b>, ligue a ponte e configure:
              </p>
              <ul>
                <li><b>Porta de escuta</b>: onde o MRQ recebe mensagens OSC de fora (ex.: de um TouchOSC).</li>
                <li><b>Host/porta de destino</b>: pra onde o MRQ envia seus próprios eventos.</li>
              </ul>
              <p>O MRQ <b>envia</b> automaticamente, sempre que o estado muda:</p>
              <table className="help-shortcuts">
                <tbody>
                  <tr><td><code>/mrq/transport/play</code></td><td>música começou a tocar</td></tr>
                  <tr><td><code>/mrq/transport/stop</code></td><td>música parou</td></tr>
                  <tr><td><code>/mrq/part</code> <i>(i, s)</i></td><td>mudou de parte — índice e nome</td></tr>
                  <tr><td><code>/mrq/tempo</code> <i>(f)</i></td><td>BPM atual</td></tr>
                  <tr><td><code>/mrq/key</code> <i>(s)</i></td><td>tom atual</td></tr>
                </tbody>
              </table>
              <p>além de qualquer <b>cue de palco</b> configurado numa parte (ver aba Arranjar). O MRQ <b>recebe</b>:</p>
              <table className="help-shortcuts">
                <tbody>
                  <tr><td><code>/mrq/play</code>, <code>/mrq/pause</code>, <code>/mrq/stop</code></td><td>transporte</td></tr>
                  <tr><td><code>/mrq/next</code>, <code>/mrq/prev</code></td><td>pula parte seguinte/anterior</td></tr>
                  <tr><td><code>/mrq/jump</code> <i>(i)</i></td><td>pula pra parte de número N (1-based)</td></tr>
                </tbody>
              </table>

              <h3 style={{ fontSize: 13.5, marginTop: 18 }}>MRQ Sync</h3>
              <p>
                Transmite tocando/parado, tom e BPM por broadcast UDP pra outras instâncias do MRQ na mesma rede local
                — ex.: o notebook do baterista mostrando o andamento de quem está liderando a música no teclado,
                sem precisar perguntar em voz alta. Escolha o papel em <b>Ajustes → OSC / Sync</b>:
              </p>
              <ul>
                <li><b>Líder</b>: transmite o próprio estado pra rede.</li>
                <li><b>Seguidor</b>: recebe e <b>só exibe</b> (pílula "🔗 Líder" na barra de título) — nunca controla a reprodução daquele computador sozinho, por segurança ao vivo.</li>
              </ul>
              <div className="help-callout">
                O MRQ Sync <b>não</b> é o protocolo Ableton Link (sincronismo de fase de batida sample-accurate entre
                DAWs) — é um relay de estado mais simples, pensado só pra múltiplas instâncias do MRQ na mesma rede,
                deliberadamente sem forçar transporte automaticamente numa máquina a partir da outra.
              </div>
            </div>
          </div>
        </section>

        {/* ---------------- MODO PALCO ---------------- */}
        <section className="help-section" id="palco">
          <SectionHead icon={Monitor} title="Modo Palco" purpose="Tema de alto contraste e fontes maiores para telas em ambientes com pouca luz" />
          <p>
            O botão <b>"Palco"</b>, sempre visível na barra superior, alterna um tema de alto contraste com textos
            maiores — pensado pra ler a tela de relance durante uma apresentação com pouca luz no ambiente, sem
            precisar entrar em nenhum menu de ajustes.
          </p>
        </section>

        {/* ---------------- BACKUP ---------------- */}
        <section className="help-section" id="backup">
          <SectionHead icon={Database} title="Backup" purpose="Exportar e restaurar toda a biblioteca e as configurações do app" />
          <div className="help-grid-2">
            <div>
              <p>
                Em <b>Ajustes → Backup</b> você exporta um arquivo <FormatChip>.json</FormatChip> com toda a
                biblioteca (músicas, tons, roteiros/arranjos, favoritas, anotações) e as configurações do app. Ele{' '}
                <b>não inclui os arquivos de áudio em si</b> — só os caminhos e metadados — pra manter o arquivo
                pequeno e rápido de transportar.
              </p>
              <p>
                Pra restaurar num outro computador, importe o <FormatChip>.json</FormatChip> e, em seguida,
                reimporte as pastas das multitracks naquele computador (os caminhos de pasta são específicos de cada
                máquina).
              </p>
            </div>
            <Figure src="help-settings-backup.png" alt="Exportar e restaurar backup" caption="Exportação/restauração de backup em .json — biblioteca e configurações, sem os áudios." />
          </div>
        </section>

        {/* ---------------- ATUALIZAÇÕES ---------------- */}
        <section className="help-section" id="atualizacoes">
          <SectionHead icon={RefreshCw} title="Atualizações automáticas" purpose="O app se atualiza sozinho — sem precisar baixar e reinstalar manualmente" />
          <div className="help-grid-2">
            <div>
              <p>
                O MRQ verifica novas versões automaticamente em segundo plano (ao abrir e depois a cada 4 horas).
                Quando encontra uma, já baixa sozinho, sem pedir nada — e assim que termina, aparece uma pílula{' '}
                <b>"Atualização pronta — instalar"</b> piscando direto na barra do título. Clicar nela instala e
                reinicia na hora.
              </p>
              <p>
                Se preferir não clicar, não precisa: na próxima vez que você simplesmente fechar o app normalmente,
                ele já instala a versão baixada sozinho antes de fechar — não tem "baixar e instalar do zero" toda
                vez, é tudo automático. Suas músicas, tons e configurações são preservados entre versões.
              </p>
              <p>
                Em <b>Ajustes → Atualização</b> também dá pra forçar uma verificação manual com{' '}
                <b>"Verificar agora"</b> e conferir a versão instalada.
              </p>
            </div>
            <Figure src="help-settings-update.png" alt="Painel de atualizações e versão instalada" caption="Versão instalada, verificação manual de atualizações e acesso ao log de diagnóstico." />
          </div>
          <div className="help-callout warn">
            <b>No Mac, o Gatekeeper pode bloquear a primeira abertura</b> com uma mensagem do tipo <i>"não é possível
            abrir porque vem de um desenvolvedor não identificado"</i> ou <i>"o app está danificado e deve ser movido
            para o Lixo"</i>. Isso acontece com qualquer app baixado fora da App Store que não tenha certificado pago
            da Apple — não é um problema de versão do macOS nem de ser Intel ou Apple Silicon, e acontece até em Macs
            novos. Pra abrir mesmo assim: <b>clique com o botão direito (ou Control+clique) no ícone do app → "Abrir"
            → confirme "Abrir"</b> na caixa de diálogo (em vez de dar duplo-clique normal). Se ainda aparecer
            "danificado", abra o <b>Terminal</b> e rode (ajustando o caminho se necessário):{' '}
            <code>xattr -cr "/Applications/MRQ - Multitracks Play.app"</code>. Esse passo só é necessário na primeira
            instalação de cada versão baixada manualmente — as atualizações automáticas depois disso não pedem isso de novo.
          </div>
        </section>

        {/* ---------------- CASOS DE USO ---------------- */}
        <section className="help-section" id="casos-de-uso">
          <SectionHead icon={GraduationCap} title="Como usar: banda ao vivo x estudo/prática" purpose="Dois jeitos de tirar proveito do mesmo programa" />
          <div className="help-usecases">
            <div className="help-usecase-card">
              <h3><Guitar size={15} /> Tocando com a banda / show / culto</h3>
              <ul>
                <li>Monte a <b>Cena</b> com a ordem das músicas do evento.</li>
                <li>Configure <b>Saídas</b> pra mandar click/guia só pro fone dos músicos e a banda pra PA.</li>
                <li>Marque faixas fixas x que seguem o <b>Tom</b>, pra poder transpor na hora sem susto.</li>
                <li>Use <b>Arranjar</b> pra pular direto entre partes ao vivo (ou mapear teclas MIDI em <b>MIDI/Pad</b>).</li>
                <li>Ligue o <b>Rack</b> se algum músico for reforçar teclado/cordas tocando ao vivo por cima da faixa.</li>
                <li>Ative o <b>Modo Palco</b> pra ler a tela num ambiente escuro, e o <b>Controle remoto</b> se precisar operar de longe.</li>
              </ul>
            </div>
            <div className="help-usecase-card">
              <h3><KeyboardMusicIcon size={15} /> Estudando / ensaiando sozinho</h3>
              <ul>
                <li>Em <b>Faixas</b>, isole (solo) o instrumento que você está estudando.</li>
                <li>Use o <b>Modo Ensaio</b> (aba Tempo) pra tocar um trecho difícil mais devagar, sem perder o BPM salvo.</li>
                <li>Acompanhe a <b>Cifra</b>, que transpõe sozinha se você mudar o tom pra praticar em outra tonalidade.</li>
                <li>Marque as <b>partes</b> da música em Arranjar pra treinar só o Refrão ou só a Ponte em loop.</li>
                <li>Conecte um teclado MIDI e use o <b>Rack</b> pra praticar um timbre específico (piano, cordas, etc.) junto com a faixa.</li>
              </ul>
            </div>
          </div>
        </section>

        {/* ---------------- ATALHOS ---------------- */}
        <section className="help-section" id="atalhos">
          <SectionHead icon={Timer} title="Atalhos de teclado" purpose="Operar o essencial sem tirar as mãos do teclado" />
          <table className="help-shortcuts">
            <tbody>
              <tr><td><kbd>Espaço</kbd></td><td>Tocar / pausar</td></tr>
              <tr><td><kbd>← / →</kbd></td><td>Parte anterior / próxima</td></tr>
              <tr><td><kbd>L</kbd></td><td>Ligar/desligar loop da parte ativa</td></tr>
              <tr><td><kbd>Esc</kbd></td><td>Parar (ou "pânico" de notas, dentro do Rack)</td></tr>
              <tr><td><kbd>1</kbd>–<kbd>9</kbd></td><td>Pular direto pra N-ésima parte do roteiro</td></tr>
              <tr><td><kbd>Ctrl+Z</kbd></td><td>Desfazer (tela Arranjar)</td></tr>
              <tr><td><kbd>Ctrl+Shift+Z</kbd></td><td>Refazer (tela Arranjar)</td></tr>
            </tbody>
          </table>
        </section>

        {/* ---------------- SUPORTE ---------------- */}
        <section className="help-section" id="suporte">
          <SectionHead icon={Info} title="Suporte e diagnóstico" purpose="O que fazer quando algo não carrega ou não soa como esperado" />
          <p>
            Toda vez que uma faixa não carrega, o motivo técnico fica registrado automaticamente. Em{' '}
            <b>Ajustes → Atualização → "Abrir pasta de logs"</b> você encontra o arquivo <code>mrq-debug.log</code> —
            é esse arquivo que deve ser enviado ao suporte ao relatar um problema, pois ele descreve exatamente o que
            o app tentou fazer e onde falhou.
          </p>
          <div className="help-callout">
            Esta mesma tela de Ajuda está sempre disponível pelo ícone de interrogação, ao lado da engrenagem de
            Ajustes, na barra lateral — volte aqui sempre que precisar relembrar como algum recurso funciona.
          </div>
        </section>
      </div>
    </div>
  );
}
