import { useRef, useState } from 'react';
import { Bell, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Drum, Guitar, Headphones, Infinity as InfinityIcon, Mic, Mic2, Piano, SlidersHorizontal, Square, Users, X } from 'lucide-react';
import type { Song, TrackRole } from '../../shared/types';
import { useStore } from '../state/useStore';

const ROLE_ICON: Record<TrackRole, typeof Bell> = {
  click: Bell,
  guide: Mic2,
  drums: Drum,
  bass: Guitar,
  guitar: Guitar,
  keys: Piano,
  vocal: Mic,
  choir: Users,
  loop: InfinityIcon,
  other: SlidersHorizontal,
};

export const ROLE_COLOR: Record<TrackRole, string> = {
  click: '#8c8f98',
  guide: '#45708f',
  drums: '#a0304f',
  bass: '#2f8f5a',
  guitar: '#c07a1f',
  keys: '#6b4fa0',
  vocal: '#f2a93b',
  choir: '#7c4fe0',
  loop: '#2d5fa0',
  other: '#5c5c66',
};

/** acima deste nível (0..1) o LED acende vermelho e fica assim por um tempo, mesmo que o sinal já tenha caído */
const CLIP_THRESHOLD = 0.96;
const CLIP_HOLD_MS = 1200;

/**
 * Cada LED assina só o próprio nível no estado global — assim, durante a
 * reprodução (que atualiza a ~25 quadros/segundo), só estes pontinhos
 * re-renderizam, e não a tira de mixagem inteira (faders, botões etc.), que é
 * bem mais cara de redesenhar e não muda a cada quadro.
 */
function PeakLed({ trackId }: { trackId: string }) {
  const level = useStore((s) => s.engineState.trackLevels[trackId] ?? 0);
  const clipUntilRef = useRef(0);
  if (level >= CLIP_THRESHOLD) clipUntilRef.current = Date.now() + CLIP_HOLD_MS;
  const clipping = clipUntilRef.current > Date.now();
  const color = clipping ? '#e0493f' : level > 0.7 ? '#e0b23f' : level > 0.08 ? '#3fae5a' : '#3a3d45';
  return <span className="peak-led" style={{ background: color }} title="Indicador de pico/clipping desta faixa" />;
}

export default function MixerStrip({ song }: { song: Song }) {
  const setTrackVolumeDb = useStore((s) => s.setTrackVolumeDb);
  const setTrackMuted = useStore((s) => s.setTrackMuted);
  const setTrackSolo = useStore((s) => s.setTrackSolo);
  const [soundcheckIndex, setSoundcheckIndex] = useState<number | null>(null);
  // Esconder a mesa de mixagem (preferência local, não é salva) — útil pra
  // ganhar espaço de tela quando não precisa mexer nos faders no momento,
  // igual o botão de minimizar que o teclado virtual do Rack já tinha.
  const [collapsed, setCollapsed] = useState(false);

  function clearAllSolos() {
    for (const t of song.tracks) if (t.solo) setTrackSolo(t.id, false);
  }

  function startSoundcheck() {
    if (song.tracks.length === 0) return;
    clearAllSolos();
    setTrackSolo(song.tracks[0].id, true);
    setSoundcheckIndex(0);
  }

  function stepSoundcheck(delta: number) {
    if (soundcheckIndex === null) return;
    const next = soundcheckIndex + delta;
    if (next < 0 || next >= song.tracks.length) return;
    setTrackSolo(song.tracks[soundcheckIndex].id, false);
    setTrackSolo(song.tracks[next].id, true);
    setSoundcheckIndex(next);
  }

  function exitSoundcheck() {
    clearAllSolos();
    setSoundcheckIndex(null);
  }

  return (
    <>
      <div className="soundcheck-row">
        {soundcheckIndex === null ? (
          <button className="btn ghost soundcheck-toggle" onClick={startSoundcheck} title="Soa cada faixa sozinha, uma de cada vez, pra conferir o som no palco">
            <Headphones size={13} /> Modo prova de som
          </button>
        ) : (
          <div className="soundcheck-active">
            <Headphones size={13} />
            <span>Prova de som:</span>
            <button className="icon-btn" disabled={soundcheckIndex === 0} onClick={() => stepSoundcheck(-1)} title="Faixa anterior">
              <ChevronLeft size={14} />
            </button>
            <strong>{song.tracks[soundcheckIndex]?.name}</strong>
            <span className="soundcheck-count">({soundcheckIndex + 1}/{song.tracks.length})</span>
            <button className="icon-btn" disabled={soundcheckIndex >= song.tracks.length - 1} onClick={() => stepSoundcheck(1)} title="Próxima faixa">
              <ChevronRight size={14} />
            </button>
            <button className="icon-btn" onClick={exitSoundcheck} title="Sair da prova de som (desliga os solos)">
              <X size={14} />
            </button>
          </div>
        )}
      </div>
      <div className="rack-strip-header mixer-strip-header">
        <span className="rack-strip-title">
          <SlidersHorizontal size={14} /> Mesa de mixagem
        </span>
        <button
          className="rack-strip-toggle"
          title={collapsed ? 'Mostrar mesa de mixagem' : 'Minimizar mesa de mixagem'}
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
      </div>
      <div className="mixer-strip-wrap" style={collapsed ? { display: 'none' } : undefined}>
        <div className="mixer-strip">
          {song.tracks.map((track) => {
            const RoleIcon = ROLE_ICON[track.role];
            const dimmed = track.muted || (song.tracks.some((t) => t.solo) && !track.solo);
            return (
            <div
              className={`mixer-channel${dimmed ? ' dimmed' : ''}`}
              key={track.id}
              style={{ '--role-color': ROLE_COLOR[track.role] } as React.CSSProperties}
            >
              <div className="ch-icon"><RoleIcon size={16} /></div>
              <div className="ch-name" title={track.name}>{track.name}</div>
              <div className="ch-sub">
                {track.output.replace('stereo-', '')}
                <PeakLed trackId={track.id} />
              </div>
              <input
                className="mixer-fader"
                type="range"
                min={-60}
                max={12}
                step={0.5}
                value={track.volumeDb}
                onChange={(e) => setTrackVolumeDb(track.id, parseFloat(e.target.value))}
              />
              <div className="mixer-db">{track.volumeDb.toFixed(1)} dB</div>
              <div className="mixer-buttons">
                <button
                  className={track.muted ? 'on mute' : ''}
                  onClick={() => setTrackMuted(track.id, !track.muted)}
                  title="Mudo"
                >
                  M
                </button>
                <button
                  className={track.solo ? 'on solo' : ''}
                  onClick={() => setTrackSolo(track.id, !track.solo)}
                  title="Solo"
                >
                  S
                </button>
              </div>
            </div>
            );
          })}
        </div>
        {/* Fora do contêiner que rola — fica sempre visível, não some quando a
            lista de faixas é mais larga que a tela (é assim que mesas de som
            físicas e apps de playback do gênero tratam o canal master). */}
        <div className="mixer-channel master mixer-master-pinned" style={{ '--role-color': 'var(--accent)' } as React.CSSProperties}>
          <div className="ch-icon"><Square size={14} /></div>
          <div className="ch-name">MASTER</div>
          <div className="ch-sub">&nbsp;</div>
          <input className="mixer-fader" type="range" min={-60} max={12} step={0.5} defaultValue={0} disabled />
          <div className="mixer-db">0.0 dB</div>
        </div>
      </div>
    </>
  );
}

