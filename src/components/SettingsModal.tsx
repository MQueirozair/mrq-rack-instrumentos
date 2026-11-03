import { useEffect, useRef, useState } from 'react';
import { Download, Upload, Volume2, X } from 'lucide-react';
import QRCode from 'qrcode';
import { useStore } from '../state/useStore';
import { engine, padEngine } from '../audio/engineInstance';
import { pairIndexLabel } from '../audio/AudioEngine';
import type { AppSettings, Library } from '../../shared/types';

type Tab = 'audio' | 'click' | 'pad' | 'remote' | 'osc' | 'speech' | 'account' | 'backup' | 'update' | 'license';

const TABS: { id: Tab; label: string }[] = [
  { id: 'audio', label: 'Áudio' },
  { id: 'click', label: 'Click' },
  { id: 'pad', label: 'Pad' },
  { id: 'remote', label: 'Remoto' },
  { id: 'osc', label: 'OSC / Sync' },
  { id: 'speech', label: 'Reconhecer por voz' },
  { id: 'account', label: 'Conta' },
  { id: 'backup', label: 'Backup' },
  { id: 'update', label: 'Atualização' },
  { id: 'license', label: 'Registro' },
];

/** Formato do arquivo de backup exportado/importado pela aba "Backup". */
interface BackupFile {
  kind: 'mrq-multitracks-play-backup';
  version: 1;
  exportedAt: number;
  appVersion: string;
  library: Library;
  settings: AppSettings;
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('audio');
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const library = useStore((s) => s.library);
  const pushToast = useStore((s) => s.pushToast);
  const backupFileInputRef = useRef<HTMLInputElement>(null);
  const [backupMessage, setBackupMessage] = useState<string | null>(null);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [addresses, setAddresses] = useState<string[]>([]);
  const [qr, setQr] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState('—');
  const [updateStatus, setUpdateStatus] = useState<{
    status: string;
    version?: string;
    percent?: number;
    message?: string;
  }>({ status: 'idle' });
  const [speechModelReady, setSpeechModelReady] = useState<boolean | null>(null);
  const [speechDownloading, setSpeechDownloading] = useState(false);
  const [speechProgress, setSpeechProgress] = useState<{ received: number; total: number } | null>(null);
  const [speechError, setSpeechError] = useState<string | null>(null);

  useEffect(() => {
    navigator.mediaDevices?.enumerateDevices().then((devices) => {
      setOutputs(devices.filter((d) => d.kind === 'audiooutput'));
    });
    window.api.net.localAddresses().then(setAddresses);
    window.api.app?.getVersion().then(setAppVersion);
    const off = window.api.update?.onStatus((payload) => setUpdateStatus(payload));
    return () => off?.();
  }, []);

  useEffect(() => {
    if (tab !== 'remote' || addresses.length === 0) return;
    const url = `http://${addresses[0]}:${settings.remote.port}`;
    QRCode.toDataURL(url, { margin: 1, width: 180 }).then(setQr);
  }, [tab, addresses, settings.remote.port]);

  useEffect(() => {
    if (tab !== 'speech') return;
    window.api.speech.modelReady().then(setSpeechModelReady).catch(() => setSpeechModelReady(false));
  }, [tab]);

  useEffect(() => {
    const off = window.api.speech.onDownloadProgress((p) => setSpeechProgress(p));
    return () => off?.();
  }, []);

  async function handleDownloadSpeechModel() {
    setSpeechDownloading(true);
    setSpeechError(null);
    setSpeechProgress(null);
    try {
      await window.api.speech.downloadModel();
      setSpeechModelReady(true);
      pushToast('Modelo de voz baixado com sucesso.');
    } catch (err) {
      console.error(err);
      setSpeechError('Falha ao baixar o modelo de voz. Confira sua conexão e tente de novo.');
    } finally {
      setSpeechDownloading(false);
      setSpeechProgress(null);
    }
  }

  async function handleDeleteSpeechModel() {
    try {
      await window.api.speech.deleteModel();
      setSpeechModelReady(false);
      pushToast('Modelo de voz removido.');
    } catch (err) {
      console.error(err);
      pushToast('Falha ao remover o modelo de voz.', 'error');
    }
  }

  function testOutput(pairIndex: number, side: 'L' | 'R') {
    const ctx = engine.ctx;
    const channelCount = Math.max(2, settings.outputChannelCount);
    const merger = ctx.createChannelMerger(channelCount);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.3;
    osc.frequency.value = 880;
    osc.connect(gain);
    const channel = pairIndex * 2 + (side === 'L' ? 0 : 1);
    gain.connect(merger, 0, Math.min(channel, channelCount - 1));
    merger.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.35);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Ajustes</h2>
          <button className="icon-btn" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="modal-body">
          <div className="modal-tabs">
            {TABS.map((t) => (
              <button key={t.id} className={`modal-tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
          <div className="modal-pane">
            {tab === 'audio' && (
              <div>
                <div className="field-row">
                  <div className="label">Dispositivo de saída</div>
                  <select
                    value={settings.outputDeviceId ?? ''}
                    onChange={(e) => updateSettings({ outputDeviceId: e.target.value || null })}
                  >
                    <option value="">Padrão do sistema</option>
                    {outputs.map((o) => (
                      <option key={o.deviceId} value={o.deviceId}>{o.label || 'Dispositivo de áudio'}</option>
                    ))}
                  </select>
                </div>
                <div className="field-row">
                  <div className="label">Canais de saída do dispositivo</div>
                  <select
                    value={settings.outputChannelCount}
                    onChange={async (e) => {
                      const n = parseInt(e.target.value, 10);
                      await updateSettings({ outputChannelCount: n });
                      await engine.setChannelCount(n);
                    }}
                  >
                    {[2, 4, 6, 8, 16].map((n) => (
                      <option key={n} value={n}>{n} canais ({n / 2} pares estéreo)</option>
                    ))}
                  </select>
                </div>
                <div className="field-row">
                  <div className="label">Taxa de amostragem</div>
                  <div className="hint">{engine.ctx.sampleRate.toLocaleString('pt-BR')} Hz</div>
                </div>
                <h4>Testar saídas</h4>
                {Array.from({ length: Math.floor(settings.outputChannelCount / 2) }, (_, i) => (
                  <div className="field-row" key={i}>
                    <div className="label">{pairIndexLabel(i)}</div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn" onClick={() => testOutput(i, 'L')}><Volume2 size={14} style={{ marginRight: 4 }} />Esquerda</button>
                      <button className="btn" onClick={() => testOutput(i, 'R')}><Volume2 size={14} style={{ marginRight: 4 }} />Direita</button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {tab === 'click' && (
              <div>
                <div className="field-row">
                  <div>
                    <div className="label">Contagem de entrada</div>
                    <div className="hint">Antes de a música entrar.</div>
                  </div>
                  <select
                    value={settings.click.countInBars}
                    onChange={(e) => updateSettings({ click: { ...settings.click, countInBars: parseInt(e.target.value, 10) } })}
                  >
                    <option value={0}>Sem contagem</option>
                    <option value={1}>1 compasso</option>
                    <option value={2}>2 compassos</option>
                  </select>
                </div>
                <div className="field-row">
                  <div>
                    <div className="label">Som do click</div>
                    <div className="hint">Gerado pelo programa.</div>
                  </div>
                  <select
                    value={settings.click.sound}
                    onChange={(e) => updateSettings({ click: { ...settings.click, sound: e.target.value as any } })}
                  >
                    <option value="beep">Bipe</option>
                    <option value="click">Clique seco</option>
                    <option value="rimshot">Rimshot</option>
                    <option value="cowbell">Cowbell</option>
                  </select>
                </div>
                <div className="field-row">
                  <div>
                    <div className="label">Acento no tempo 1</div>
                    <div className="hint">Tempo 1 mais agudo e forte.</div>
                  </div>
                  <select
                    value={settings.click.accentFirstBeat ? 'on' : 'off'}
                    onChange={(e) => updateSettings({ click: { ...settings.click, accentFirstBeat: e.target.value === 'on' } })}
                  >
                    <option value="on">Ligado</option>
                    <option value="off">Desligado</option>
                  </select>
                </div>
                <div className="field-row">
                  <div className="label">Volume do click</div>
                  <input
                    type="range" min={-30} max={6} step={1}
                    value={settings.click.volumeDb}
                    onChange={(e) => updateSettings({ click: { ...settings.click, volumeDb: parseFloat(e.target.value) } })}
                  />
                </div>
                <div className="field-row">
                  <div>
                    <div className="label">Saída do click</div>
                    <div className="hint">Para onde vai o bipe de contagem (antes de a música entrar).</div>
                  </div>
                  <select
                    value={settings.click.output}
                    onChange={(e) => updateSettings({ click: { ...settings.click, output: e.target.value } })}
                  >
                    <option value="auto">Automática</option>
                    <option value="stereo-1-2">Estéreo (1/2)</option>
                    <option value="left-1">Esquerda (1)</option>
                    <option value="right-1">Direita (2)</option>
                  </select>
                </div>
              </div>
            )}

            {tab === 'pad' && (
              <div>
                <div className="field-row">
                  <div>
                    <div className="label">Timbre</div>
                    <div className="hint">Pad sintetizado embutido (sem necessidade de arquivos externos).</div>
                  </div>
                  <select value="synth" disabled>
                    <option value="synth">Pad sintetizado</option>
                  </select>
                </div>
                <div className="field-row">
                  <div className="label">Volume do pad</div>
                  <input
                    type="range" min={-30} max={6} step={1}
                    value={settings.pad.volumeDb}
                    onChange={(e) => {
                      const volumeDb = parseFloat(e.target.value);
                      updateSettings({ pad: { ...settings.pad, volumeDb } });
                      padEngine.setVolumeDb(volumeDb);
                    }}
                  />
                </div>
                <div className="field-row">
                  <div>
                    <div className="label">Sair no play</div>
                    <div className="hint">Volta quando a música parar.</div>
                  </div>
                  <select
                    value={settings.pad.exitOnPlay ? 'on' : 'off'}
                    onChange={(e) => updateSettings({ pad: { ...settings.pad, exitOnPlay: e.target.value === 'on' } })}
                  >
                    <option value="on">Ligado</option>
                    <option value="off">Desligado</option>
                  </select>
                </div>
                <div className="field-row">
                  <div>
                    <div className="label">Saída do pad</div>
                    <div className="hint">Com a música ou separada (ex.: só no monitor, sem ir pro FOH).</div>
                  </div>
                  <select
                    value={settings.pad.output === 'stereo-1-2' ? 'with-song' : settings.pad.output}
                    onChange={(e) => updateSettings({ pad: { ...settings.pad, output: e.target.value } })}
                  >
                    <option value="with-song">Com a música</option>
                    <option value="stereo-3-4">Separada (3/4)</option>
                  </select>
                </div>
                <div className="field-row">
                  <div>
                    <div className="label">Subida e descida</div>
                    <div className="hint">Tempo de fade ao ligar, desligar e trocar de tom.</div>
                  </div>
                  <select
                    value={settings.pad.fadeInOutSec}
                    onChange={(e) => updateSettings({ pad: { ...settings.pad, fadeInOutSec: parseFloat(e.target.value) } })}
                  >
                    {[0.5, 1, 1.5, 2, 3, 5].map((s) => (
                      <option key={s} value={s}>{s} s</option>
                    ))}
                  </select>
                </div>
                <div className="field-row">
                  <div>
                    <div className="label">Troca de tom</div>
                    <div className="hint">Tempo do crossfade ao mudar de tom com o pad ligado.</div>
                  </div>
                  <select
                    value={settings.pad.keyChangeCrossfadeSec}
                    onChange={(e) => updateSettings({ pad: { ...settings.pad, keyChangeCrossfadeSec: parseFloat(e.target.value) } })}
                  >
                    {[0.5, 1, 1.5, 2, 3, 5].map((s) => (
                      <option key={s} value={s}>{s} s</option>
                    ))}
                  </select>
                </div>
                <div className="field-row">
                  <div>
                    <div className="label">Emenda da repetição</div>
                    <div className="hint">Ciclo da "respiração" do pad (o timbre não é uma amostra em loop, então isso só dá um leve movimento ao som em vez de ficar estático).</div>
                  </div>
                  <select
                    value={settings.pad.loopCrossfadeSec}
                    onChange={(e) => {
                      const loopCrossfadeSec = parseFloat(e.target.value);
                      updateSettings({ pad: { ...settings.pad, loopCrossfadeSec } });
                      padEngine.setBreatheSeconds(loopCrossfadeSec);
                    }}
                  >
                    {[2, 4, 6, 8, 12].map((s) => (
                      <option key={s} value={s}>{s} s</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {tab === 'remote' && (
              <div>
                <div className="field-row">
                  <div>
                    <div className="label">Controle pelo celular</div>
                    <div className="hint">Abra o endereço abaixo no navegador do celular, na mesma rede.</div>
                  </div>
                  <select
                    value={settings.remote.enabled ? 'on' : 'off'}
                    onChange={(e) => updateSettings({ remote: { ...settings.remote, enabled: e.target.value === 'on' } })}
                  >
                    <option value="on">Ligado</option>
                    <option value="off">Desligado</option>
                  </select>
                </div>
                <div className="field-row">
                  <div className="label">Porta</div>
                  <input
                    type="number"
                    value={settings.remote.port}
                    style={{ width: 100 }}
                    onChange={(e) => updateSettings({ remote: { ...settings.remote, port: parseInt(e.target.value, 10) || 8787 } })}
                  />
                </div>
                <div className="field-row">
                  <div className="label">PIN</div>
                  <input
                    value={settings.remote.pin}
                    style={{ width: 100 }}
                    onChange={(e) => updateSettings({ remote: { ...settings.remote, pin: e.target.value } })}
                  />
                </div>
                {settings.remote.enabled && addresses.length > 0 && (
                  <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginTop: 10 }}>
                    {qr && <img src={qr} alt="QR do controle remoto" style={{ borderRadius: 8 }} />}
                    <div>
                      {addresses.map((a) => (
                        <div key={a} style={{ fontFamily: 'monospace' }}>http://{a}:{settings.remote.port}</div>
                      ))}
                      <div className="hint" style={{ marginTop: 6 }}>Escaneie o QR ou digite o endereço no navegador do celular.</div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {tab === 'osc' && (
              <div>
                <h3 style={{ marginTop: 0 }}>Ponte OSC (show-control externo)</h3>
                <p className="hint">
                  Envia/recebe mensagens OSC (Open Sound Control) por UDP pra integrar o MRQ com software de luz,
                  vídeo ou produção (QLab, Resolume, TouchOSC, consoles de iluminação) — novidade desta versão. O MRQ
                  manda transporte (tocar/parar), tempo e tom automaticamente, além de disparar as "Cues de palco"
                  configuradas em cada parte da música (aba Arranjar). Veja a lista completa de endereços na Ajuda.
                </p>
                <div className="field-row">
                  <div className="label">Ligar ponte OSC</div>
                  <select
                    value={settings.osc.enabled ? 'on' : 'off'}
                    onChange={(e) => updateSettings({ osc: { ...settings.osc, enabled: e.target.value === 'on' } })}
                  >
                    <option value="on">Ligado</option>
                    <option value="off">Desligado</option>
                  </select>
                </div>
                <div className="field-row">
                  <div className="label">Porta de escuta (recebe OSC)</div>
                  <input
                    type="number"
                    value={settings.osc.listenPort}
                    style={{ width: 100 }}
                    onChange={(e) => updateSettings({ osc: { ...settings.osc, listenPort: parseInt(e.target.value, 10) || 9000 } })}
                  />
                </div>
                <div className="field-row">
                  <div className="label">Destino — host</div>
                  <input
                    value={settings.osc.sendHost}
                    style={{ width: 160 }}
                    onChange={(e) => updateSettings({ osc: { ...settings.osc, sendHost: e.target.value } })}
                  />
                </div>
                <div className="field-row">
                  <div className="label">Destino — porta</div>
                  <input
                    type="number"
                    value={settings.osc.sendPort}
                    style={{ width: 100 }}
                    onChange={(e) => updateSettings({ osc: { ...settings.osc, sendPort: parseInt(e.target.value, 10) || 9001 } })}
                  />
                </div>

                <h3>MRQ Sync (sincronismo entre instâncias na mesma rede)</h3>
                <p className="hint">
                  Transmite tocando/parado, tempo e tom por broadcast UDP na rede local pra outras instâncias do MRQ
                  (ex.: o notebook do baterista) — quem está como Seguidor só EXIBE o estado do Líder, nunca controla
                  a reprodução automaticamente (por segurança ao vivo). Não é compatível com Ableton Link.
                </p>
                <div className="field-row">
                  <div className="label">Ligar MRQ Sync</div>
                  <select
                    value={settings.sync.enabled ? 'on' : 'off'}
                    onChange={(e) => updateSettings({ sync: { ...settings.sync, enabled: e.target.value === 'on' } })}
                  >
                    <option value="on">Ligado</option>
                    <option value="off">Desligado</option>
                  </select>
                </div>
                <div className="field-row">
                  <div className="label">Papel</div>
                  <select
                    value={settings.sync.role}
                    onChange={(e) => updateSettings({ sync: { ...settings.sync, role: e.target.value as 'leader' | 'follower' } })}
                  >
                    <option value="leader">Líder (transmite)</option>
                    <option value="follower">Seguidor (recebe)</option>
                  </select>
                </div>
                <div className="field-row">
                  <div className="label">Porta UDP</div>
                  <input
                    type="number"
                    value={settings.sync.port}
                    style={{ width: 100 }}
                    onChange={(e) => updateSettings({ sync: { ...settings.sync, port: parseInt(e.target.value, 10) || 8788 } })}
                  />
                </div>
              </div>
            )}

            {tab === 'speech' && (
              <div>
                <h3 style={{ marginTop: 0 }}>Reconhecimento de partes por voz (beta)</h3>
                <p className="hint">
                  Muitas multitracks/VS trazem, na faixa guia, uma locução anunciando cada parte antes dela começar
                  (ex.: a voz diz "Estrofe" e logo em seguida a estrofe começa de verdade). Ligando essa opção, o
                  botão "Reconhecer partes" (aba Arranjar) passa a OUVIR essa locução com um modelo de voz rodando
                  100% local no seu computador (nenhum áudio é enviado para a internet), em vez de só adivinhar a
                  estrutura pela forma da onda — é mais preciso quando a faixa guia tem locução, e cai sozinho de
                  volta pro método por áudio quando ela não tem.
                </p>
                <div className="field-row">
                  <div className="label">Ligar reconhecimento por voz</div>
                  <select
                    value={settings.speech.enabled ? 'on' : 'off'}
                    onChange={(e) => updateSettings({ speech: { ...settings.speech, enabled: e.target.value === 'on' } })}
                  >
                    <option value="on">Ligado</option>
                    <option value="off">Desligado</option>
                  </select>
                </div>

                <div style={{ marginTop: 14 }}>
                  {speechModelReady === null && <p className="hint">Verificando o modelo de voz…</p>}
                  {speechModelReady === true && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span className="hint">✓ Modelo de voz (~148MB, Português) já baixado e pronto.</span>
                      <button className="btn" onClick={handleDeleteSpeechModel}>Remover modelo</button>
                    </div>
                  )}
                  {speechModelReady === false && !speechDownloading && (
                    <div>
                      <p className="hint">
                        O modelo de voz ainda não foi baixado (download único de ~148MB, feito agora e guardado
                        neste computador).
                      </p>
                      <button className="btn primary" onClick={handleDownloadSpeechModel}>Baixar modelo de voz</button>
                    </div>
                  )}
                  {speechDownloading && (
                    <div>
                      <p className="hint">
                        Baixando modelo de voz…
                        {speechProgress && speechProgress.total > 0
                          ? ` ${Math.round((speechProgress.received / speechProgress.total) * 100)}% (${(speechProgress.received / 1024 / 1024).toFixed(1)}MB / ${(speechProgress.total / 1024 / 1024).toFixed(1)}MB)`
                          : ''}
                      </p>
                      <div style={{ height: 8, borderRadius: 4, background: 'var(--bg-2)', overflow: 'hidden' }}>
                        <div
                          style={{
                            height: '100%',
                            width: speechProgress && speechProgress.total > 0 ? `${Math.round((speechProgress.received / speechProgress.total) * 100)}%` : '10%',
                            background: 'var(--accent)',
                            transition: 'width 0.2s',
                          }}
                        />
                      </div>
                    </div>
                  )}
                  {speechError && <p className="hint" style={{ color: 'var(--danger)' }}>{speechError}</p>}
                </div>
              </div>
            )}

            {tab === 'account' && (
              <div>
                <p className="hint">
                  O MRQ - Multitracks Play funciona totalmente offline, sem conta obrigatória. Suas músicas e
                  configurações ficam só neste computador.
                </p>
              </div>
            )}

            {tab === 'backup' && (
              <div>
                <div className="field-row">
                  <div>
                    <div className="label">Exportar backup</div>
                    <div className="hint">
                      Salva um arquivo .json com a sua biblioteca (músicas, tons, roteiros/arranjos, favoritas,
                      anotações) e as configurações do app. Não inclui os arquivos de áudio em si — só os caminhos e
                      metadados, pra manter o arquivo pequeno.
                    </div>
                  </div>
                  <button
                    className="btn"
                    style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                    onClick={() => {
                      const payload: BackupFile = {
                        kind: 'mrq-multitracks-play-backup',
                        version: 1,
                        exportedAt: Date.now(),
                        appVersion,
                        library,
                        settings,
                      };
                      const stamp = new Date().toISOString().slice(0, 10);
                      downloadJson(`mrq-backup-${stamp}.json`, payload);
                      setBackupMessage('Backup exportado.');
                    }}
                  >
                    <Download size={14} /> Exportar backup (.json)
                  </button>
                </div>

                <div className="field-row" style={{ marginTop: 10 }}>
                  <div>
                    <div className="label">Restaurar backup</div>
                    <div className="hint">
                      Substitui a biblioteca e as configurações atuais pelas do arquivo escolhido. As músicas
                      continuam apontando para as pastas originais de áudio no computador de origem — se for outro
                      computador, reimporte as pastas das multitracks depois.
                    </div>
                  </div>
                  <button
                    className="btn"
                    style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                    onClick={() => backupFileInputRef.current?.click()}
                  >
                    <Upload size={14} /> Restaurar de um arquivo…
                  </button>
                  <input
                    ref={backupFileInputRef}
                    type="file"
                    accept="application/json"
                    style={{ display: 'none' }}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (!file) return;
                      try {
                        const text = await file.text();
                        const parsed = JSON.parse(text) as Partial<BackupFile>;
                        if (!parsed.library?.songs || !Array.isArray(parsed.library.songs) || !parsed.settings) {
                          throw new Error('Arquivo não parece ser um backup válido do MRQ - Multitracks Play.');
                        }
                        const songCount = parsed.library.songs.length;
                        const ok = window.confirm(
                          `Restaurar este backup (${songCount} música(s))? Isso substitui a biblioteca e as configurações atuais.`
                        );
                        if (!ok) return;
                        await window.api.store.saveLibrary(parsed.library);
                        await window.api.store.saveSettings(parsed.settings);
                        useStore.setState({ library: parsed.library, settings: parsed.settings });
                        setBackupMessage('Backup restaurado com sucesso.');
                        pushToast('Backup restaurado.');
                      } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        setBackupMessage(`Erro ao restaurar: ${msg}`);
                        pushToast(`Erro ao restaurar backup: ${msg}`, 'error');
                      }
                    }}
                  />
                </div>

                {backupMessage && (
                  <div className="hint" style={{ marginTop: 12, color: 'var(--text-1)' }}>{backupMessage}</div>
                )}
              </div>
            )}

            {tab === 'update' && (
              <div>
                <div className="field-row">
                  <div className="label">Versão instalada</div>
                  <div className="hint">{appVersion}</div>
                </div>

                <div className="field-row" style={{ marginTop: 10 }}>
                  <div>
                    <div className="label">Atualizações</div>
                    <div className="hint">
                      {updateStatus.status === 'idle' && 'Verificando automaticamente em segundo plano...'}
                      {updateStatus.status === 'checking' && 'Procurando por novas versões...'}
                      {updateStatus.status === 'not-available' && 'Você já está na versão mais recente.'}
                      {updateStatus.status === 'available' &&
                        `Nova versão ${updateStatus.version} encontrada, baixando...`}
                      {updateStatus.status === 'downloading' &&
                        `Baixando atualização... ${Math.round(updateStatus.percent ?? 0)}%`}
                      {updateStatus.status === 'downloaded' &&
                        `Versão ${updateStatus.version} pronta! Clique em "Instalar e reiniciar" para aplicar.`}
                      {updateStatus.status === 'error' && `Erro ao verificar atualização: ${updateStatus.message}`}
                      {updateStatus.status === 'dev' && 'Checagem de atualização desativada em modo de desenvolvimento.'}
                    </div>
                  </div>
                  {updateStatus.status === 'downloaded' ? (
                    <button className="btn primary" onClick={() => window.api.update.install()}>
                      Instalar e reiniciar
                    </button>
                  ) : (
                    <button
                      className="btn"
                      disabled={updateStatus.status === 'checking' || updateStatus.status === 'downloading'}
                      onClick={() => window.api.update.check()}
                    >
                      Verificar agora
                    </button>
                  )}
                </div>

                <div className="field-row" style={{ marginTop: 16, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 16 }}>
                  <div>
                    <div className="label">Log de diagnóstico</div>
                    <div className="hint">
                      Toda vez que uma faixa não carrega, o motivo técnico fica registrado aqui. Se algo der
                      errado, abra esta pasta e envie o arquivo "mrq-debug.log" para o suporte.
                    </div>
                  </div>
                  <button
                    className="btn"
                    onClick={async () => {
                      const path = await window.api.log.reveal();
                      console.log('[log] arquivo em', path);
                    }}
                  >
                    Abrir pasta de logs
                  </button>
                </div>
              </div>
            )}

            {tab === 'license' && (
              <div>
                <p className="hint">Esta versão é de uso livre durante o desenvolvimento do MRQ - Multitracks Play.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
