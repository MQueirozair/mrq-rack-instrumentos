import { useEffect, useState } from 'react';
import { Settings, HelpCircle } from 'lucide-react';
import { useStore } from './state/useStore';
import TitleBar from './components/TitleBar';
import MidiBridge from './components/MidiBridge';
import InstrumentRack from './components/InstrumentRack';
import HelpPanel from './components/HelpPanel';
import SettingsModal from './components/SettingsModal';

/**
 * App.tsx do projeto separado "MRQ Rack de Instrumentos" — ver
 * PROJETO-SEPARADO.md na raiz. Versão enxugada do App.tsx original
 * (extraído de mrq-multitracks-play v0.2.48, que continua intocado):
 * em vez da barra de navegação inteira (biblioteca, setlist, player de
 * multitracks, Conversor, etc.), este app abre DIRETO no Rack de
 * instrumentos virtuais, que é o único propósito deste projeto.
 *
 * <MidiBridge /> foi MANTIDO de propósito (ao contrário do projeto do
 * Conversor): é ele quem chama initMidi() e liga o teclado/controlador
 * MIDI físico aos comandos do Rack (volume/mute/solo/octaver por camada,
 * pânico, etc. — ver os casos "rack:*" dentro dele) — sem ele nenhum
 * controlador MIDI externo funciona, só o teclado virtual na tela.
 *
 * O "Painel de Música" dentro do próprio Rack (RackMusicPanel, dentro de
 * InstrumentRack.tsx) continua referenciando TransportBar/PartsGrid e
 * currentSong/Setlist — ficou inofensivo aqui (sem Biblioteca/Setlist
 * pra carregar uma música, ele só mostra "Nenhuma música carregada").
 * Não vale o risco de editar o arquivo de 2796 linhas do Rack só pra
 * remover esse painel secundário agora.
 */
export default function App() {
  const ready = useStore((s) => s.ready);
  const init = useStore((s) => s.init);
  const toasts = useStore((s) => s.toasts);
  const dismissToast = useStore((s) => s.dismissToast);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    init();
  }, [init]);

  if (!ready) {
    return (
      <div className="app-shell">
        <TitleBar />
        <div className="empty-state" style={{ flex: 1 }}>Carregando…</div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <TitleBar />
      <MidiBridge />
      <div className="main-body">
        <div className="rail">
          <div className="rail-spacer" />
          <button className={`rail-btn ${helpOpen ? 'active' : ''}`} title="Ajuda / Sobre o MRQ" onClick={() => setHelpOpen((v) => !v)}>
            <HelpCircle size={19} strokeWidth={2} />
          </button>
          <button className="rail-btn" title="Configurações" onClick={() => setSettingsOpen(true)}>
            <Settings size={19} strokeWidth={2} />
          </button>
        </div>
        <div className="content-area">
          <div className="content-main">{helpOpen ? <HelpPanel /> : <InstrumentRack />}</div>
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
