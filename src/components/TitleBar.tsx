import { useEffect, useState } from 'react';
import { Minus, Monitor, Square, X, Download } from 'lucide-react';
import { useStore } from '../state/useStore';
import SessionTimer from './SessionTimer';
import RackMidiPanel from './RackMidiPanel';
import ChordIndicator from './ChordIndicator';
import AudioHealthIndicator from './AudioHealthIndicator';
import { engine } from '../audio/engineInstance';
import { rackEngine } from '../audio/rack/RackEngine';

export default function TitleBar() {
  const engineState = useStore((s) => s.engineState);
  const nav = useStore((s) => s.nav);
  const [audioOk, setAudioOk] = useState(true);

  // Antes disso, "Áudio OK" era um texto fixo (nunca virava "Sem áudio" de
  // verdade, nem que o áudio estivesse morto) — ver histórico. Agora checa
  // de fato: o motor principal (multitrack, sempre ativo) e o motor do Rack
  // (só relevante se já foi usado nesta sessão — `rackEngine.getSampleRate()
  // === null` quer dizer "ainda não iniciou", o que NÃO é um erro, só quer
  // dizer que o usuário não abriu o Rack ainda). Clicar na pílula quando ela
  // estiver em "Sem áudio" tenta reativar os dois contextos — clique do
  // usuário é exatamente o gesto que os navegadores exigem pra isso.
  useEffect(() => {
    function check() {
      const mainOk = engine.ctx.state === 'running';
      const rackStarted = rackEngine.getSampleRate() !== null;
      const rackOk = !rackStarted || rackEngine.isRunning();
      setAudioOk(mainOk && rackOk);
    }
    check();
    const id = window.setInterval(check, 1000);
    return () => window.clearInterval(id);
  }, []);

  function tryResumeAudio() {
    engine.ctx.resume().catch(() => {});
    if (rackEngine.getSampleRate() !== null) rackEngine.resume().catch(() => {});
  }
  const [remoteInfo, setRemoteInfo] = useState<{ port: number; enabled: boolean } | null>(null);
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const syncLeaderState = useStore((s) => s.syncLeaderState);
  const [updateStatus, setUpdateStatus] = useState<{
    status: string;
    version?: string;
    percent?: number;
  }>({ status: 'idle' });

  useEffect(() => {
    window.api.remote.getInfo().then(setRemoteInfo).catch(() => {});
  }, [settings.remote.port, settings.remote.enabled]);

  // Indicador de atualização "na barra": o download em si já roda sozinho em
  // segundo plano (ver tauriBridge.ts) — isso aqui só torna visível o
  // progresso e, principalmente, dá um jeito de instalar com 1 clique assim
  // que terminar, sem precisar abrir Ajustes → Atualização pra descobrir.
  useEffect(() => {
    const off = window.api.update?.onStatus((payload) => setUpdateStatus(payload));
    return () => off?.();
  }, []);

  return (
    <div className="titlebar">
      <div className="titlebar-brand">
        <img src={`${import.meta.env.BASE_URL}app-icon-64.png`} alt="MRQ" />
        <div>
          <div className="name">MRQ</div>
          <div className="tag">MULTITRACKS PLAY</div>
        </div>
      </div>

      <div className="titlebar-mid">
        <div
          className="pill"
          onClick={audioOk ? undefined : tryResumeAudio}
          style={audioOk ? undefined : { cursor: 'pointer' }}
          title={audioOk ? undefined : 'O motor de áudio parece suspenso (o sistema operacional pode ter pausado sozinho) — clique pra tentar reativar.'}
        >
          <span className={`dot ${audioOk ? '' : 'off'}`} />
          {audioOk ? 'Áudio OK' : 'Sem áudio (clique p/ reativar)'}
        </div>
        {nav === 'rack' && settings.rack.chordDisplayEnabled && <ChordIndicator />}
        <div className="pill">
          <span className={`dot ${remoteInfo?.enabled ? '' : 'off'}`} />
          Remoto {remoteInfo?.enabled ? `:${remoteInfo.port}` : 'desligado'}
        </div>
        {engineState.isPlaying && <div className="pill" style={{ color: 'var(--accent)' }}>▶ Tocando</div>}
        <AudioHealthIndicator />
        {settings.sync.enabled && settings.sync.role === 'follower' && syncLeaderState && (
          <div className="pill" title="Estado recebido do Líder via MRQ Sync (só exibição, não controla sua reprodução)">
            🔗 Líder: {syncLeaderState.isPlaying ? '▶' : '■'} {syncLeaderState.bpm || '-'} BPM · {syncLeaderState.key}
          </div>
        )}
        {updateStatus.status === 'downloading' && (
          <div className="pill update-pill-downloading" title="Baixando a atualização sozinho, em segundo plano">
            <Download size={12} /> Atualizando {Math.round(updateStatus.percent ?? 0)}%
          </div>
        )}
        {updateStatus.status === 'downloaded' && (
          <button
            type="button"
            className="pill update-pill-ready"
            onClick={() => window.api.update.install()}
            title={`Versão ${updateStatus.version ?? ''} já baixada — clique pra instalar e reiniciar agora (ou só feche o app depois, que ele instala sozinho)`}
          >
            <Download size={12} /> Atualização pronta — instalar
          </button>
        )}
        {nav === 'rack' && <RackMidiPanel />}
        <SessionTimer />
        <button
          className={`pill stage-mode-toggle ${settings.stageMode ? 'on' : ''}`}
          title="Modo Palco: tema de alto contraste e fontes maiores, pra telas com pouca luz"
          onClick={() => updateSettings({ stageMode: !settings.stageMode })}
        >
          <Monitor size={12} /> Palco
        </button>
      </div>

      <div className="win-controls">
        <button onClick={() => window.api.window.minimize()} title="Minimizar"><Minus size={15} /></button>
        <button onClick={() => window.api.window.maximize()} title="Maximizar"><Square size={13} /></button>
        <button className="close" onClick={() => window.api.window.close()} title="Fechar"><X size={15} /></button>
      </div>
    </div>
  );
}

