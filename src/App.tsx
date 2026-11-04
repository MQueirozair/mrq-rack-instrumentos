import { useEffect, useState } from 'react';
import { Settings, HelpCircle } from 'lucide-react';
import { useStore } from './state/useStore';
import TitleBar from './components/TitleBar';
import MidiBridge from './components/MidiBridge';
import InstrumentRack from './components/InstrumentRack';
import MidiPanel from './components/MidiPanel';
import HelpPanel from './components/HelpPanel';
import SettingsModal from './components/SettingsModal';

/**
 * App.tsx do projeto separado "MRQ Rack de Instrumentos" — ver
 * PROJETO-SEPARADO.md na raiz. Versão enxugada do App.tsx original
 * (extraído de mrq-multitracks-play v0.2.48, que continua intocado): em vez
 * da barra de navegação inteira (biblioteca, setlist, player de
 * multitracks, Conversor, etc.), este app abre DIRETO no Rack de
 * instrumentos virtuais, que é o único propósito deste projeto.
 *
 * O painel "Música" que existia dentro do Rack (tocar/pausar a faixa do
 * Setlist sem sair da aba) foi removido de InstrumentRack.tsx, porque
 * dependia do player de multitracks completo (Setlist/Library/PlayerShell)
 * — esse acoplamento ia contra o objetivo de standalone. Quem quiser tocar
 * junto com uma música vai usar o MRQ Multitracks Play2 (outro projeto) e
 * conectar os instrumentos via MIDI/áudio do sistema operacional.
 *
 * MidiBridge foi MANTIDO (ao contrário do Conversor): ele roteia CCs/notas
 * MIDI físicos pros comandos do Rack (volume/mute/solo/octaver por camada,
 * master, pânico) — é funcionalidade central do Rack, não do player.
 *
 * TitleBar, SettingsModal, HelpPanel, MidiPanel e o sistema de toasts foram
 * mantidos como estavam (genéricos/compartilhados) — só a navegação por
 * abas e as telas exclusivas do player/Conversor foram removidas.
 */
export default function App() {
  const ready = useStore((s) => s.ready);
  const init = useStore((s) => s.init);
  const setNav = useStore((s) => s.setNav);
  const settings = useStore((s) => s.settings);
  const toasts = useStore((s) => s.toasts);
  const dismissToast = useStore((s) => s.dismissToast);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidePanel, setSidePanel] = useState<'none' | 'midi' | 'help'>('none');

  useEffect(() => {
    init();
  }, [init]);

  // A TitleBar (mantida igual à do app original) só mostra os controles de
  // MIDI do Rack e o indicador de acorde no topo quando o estado global
  // `nav` é 'rack' (ver TitleBar.tsx) — isso vinha do app original, onde o
  // usuário "entrava" na tela do Rack trocando de aba. Como este projeto
  // abre direto no Rack sem passar pela navegação por abas, `nav` nunca
  // era setado e esses dois indicadores do topo ficavam escondidos pra
  // sempre. Força `nav` pra 'rack' assim que o app carrega, pra ligar os
  // dois de volta.
  useEffect(() => {
    setNav('rack');
  }, [setNav]);

  if (!ready) {
    return (
      <div className="app-shell">
        <TitleBar />
        <div className="empty-state" style={{ flex: 1 }}>Carregando…</div>
      </div>
    );
  }

  return (
    <div className={`app-shell ${settings.stageMode ? 'stage-mode' : ''}`}>
      <TitleBar />
      <MidiBridge />
      <div className="main-body">
        <div className="rail">
          <div className="rail-spacer" />
          <button
            className={`rail-btn ${sidePanel === 'midi' ? 'active' : ''}`}
            title="MIDI (dispositivos, bindings de controle)"
            onClick={() => setSidePanel((v) => (v === 'midi' ? 'none' : 'midi'))}
          >
            MIDI
          </button>
          <button
            className={`rail-btn ${sidePanel === 'help' ? 'active' : ''}`}
            title="Ajuda / Sobre o MRQ"
            onClick={() => setSidePanel((v) => (v === 'help' ? 'none' : 'help'))}
          >
            <HelpCircle size={19} strokeWidth={2} />
          </button>
          <button className="rail-btn" title="Configurações" onClick={() => setSettingsOpen(true)}>
            <Settings size={19} strokeWidth={2} />
          </button>
        </div>
        <div className="content-area">
          <div className="content-main">{sidePanel === 'help' ? <HelpPanel /> : <InstrumentRack />}</div>
          {sidePanel === 'midi' && (
            <div className="content-side">
              <MidiPanel />
            </div>
          )}
        </div>
      </div>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}

      <div className="toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismissToast(t.id)}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}
