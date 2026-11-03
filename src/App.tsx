import { useEffect, useState } from 'react';
import { useStore } from './state/useStore';
import TitleBar from './components/TitleBar';
import IconRail from './components/IconRail';
import LibraryPanel from './components/LibraryPanel';
import SetlistPanel from './components/SetlistPanel';
import PlayerShell from './components/PlayerShell';
import TempoPanel from './components/TempoPanel';
import OutputsPanel from './components/OutputsPanel';
import KeyPanel from './components/KeyPanel';
import GuideVoicePanel from './components/GuideVoicePanel';
import MidiPanel from './components/MidiPanel';
import SettingsModal from './components/SettingsModal';
import MidiBridge from './components/MidiBridge';
import InstrumentRack from './components/InstrumentRack';
import InstrumentConverter from './components/InstrumentConverter';
import HelpPanel from './components/HelpPanel';
import TeleprompterOverlay from './components/TeleprompterOverlay';

export default function App() {
  const ready = useStore((s) => s.ready);
  const init = useStore((s) => s.init);
  const nav = useStore((s) => s.nav);
  const currentSong = useStore((s) => s.currentSong);
  const loadingSongTitle = useStore((s) => s.loadingSongTitle);
  const toasts = useStore((s) => s.toasts);
  const dismissToast = useStore((s) => s.dismissToast);
  const importSongFromFolder = useStore((s) => s.importSongFromFolder);
  const settings = useStore((s) => s.settings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const teleprompterOpen = useStore((s) => s.teleprompterOpen);
  const setTeleprompterOpen = useStore((s) => s.setTeleprompterOpen);

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

  const showSecondary = nav === 'library' || nav === 'setlist';
  const showSidePanel = ['tempo', 'outputs', 'key', 'guide', 'midi'].includes(nav) && currentSong;

  return (
    <div className={`app-shell ${settings.stageMode ? 'stage-mode' : ''}`}>
      <TitleBar />
      <MidiBridge />
      <div className="main-body">
        <IconRail onOpenSettings={() => setSettingsOpen(true)} />
        {showSecondary && (nav === 'library' ? <LibraryPanel /> : <SetlistPanel />)}
        <div className="content-area">
          <div className="content-main">
            {nav === 'rack' ? (
              <InstrumentRack />
            ) : nav === 'converter' ? (
              <InstrumentConverter />
            ) : nav === 'help' ? (
              <HelpPanel />
            ) : loadingSongTitle ? (
              <div className="empty-state">
                <div className="spinner" />
                <h3>Abrindo "{loadingSongTitle}"…</h3>
                <p>Carregando as faixas de áudio. Músicas com muitas faixas grandes podem levar alguns segundos.</p>
              </div>
            ) : currentSong ? (
              <PlayerShell song={currentSong} />
            ) : (
              <div className="empty-state">
                <h3>Nenhuma música aberta</h3>
                <p>Importe a pasta de uma multitrack para começar a tocar.</p>
                <button className="btn primary" onClick={() => importSongFromFolder()}>Importar pasta de multitracks</button>
              </div>
            )}
          </div>
          {showSidePanel && currentSong && (
            <div className="content-side">
              {nav === 'tempo' && <TempoPanel song={currentSong} onOpenSettings={() => setSettingsOpen(true)} />}
              {nav === 'outputs' && <OutputsPanel song={currentSong} />}
              {nav === 'key' && <KeyPanel song={currentSong} />}
              {nav === 'guide' && <GuideVoicePanel song={currentSong} />}
              {nav === 'midi' && <MidiPanel />}
            </div>
          )}
        </div>
      </div>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {teleprompterOpen && currentSong && <TeleprompterOverlay song={currentSong} onClose={() => setTeleprompterOpen(false)} />}

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
