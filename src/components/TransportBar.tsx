import { Keyboard, Pause, Play, SkipBack, SkipForward, Square } from 'lucide-react';
import { formatTime } from '../lib/format';
import { useStore } from '../state/useStore';
import VisualMetronome from './VisualMetronome';

const SHORTCUTS_HINT = [
  'Atalhos de teclado:',
  'Espaço — Tocar / Pausar',
  '← / → — Parte anterior / próxima',
  'L — Ligar/desligar loop da parte ativa',
  'Esc — Parar',
].join('\n');

export default function TransportBar() {
  const engineState = useStore((s) => s.engineState);
  const play = useStore((s) => s.play);
  const pause = useStore((s) => s.pause);
  const stop = useStore((s) => s.stop);
  const jumpRelative = useStore((s) => s.jumpRelative);
  const currentSong = useStore((s) => s.currentSong);

  return (
    <div className="transport-row">
      <VisualMetronome engineState={engineState} beatsPerBar={currentSong?.timeSignatureNum ?? 4} />
      <div style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-2)', fontSize: 13 }}>
        {formatTime(engineState.realSeconds)}
      </div>
      <div className="spacer" />
      <button className="transport-btn" title="Parte anterior" onClick={() => jumpRelative(-1)}><SkipBack size={13} /></button>
      <button className="transport-btn" title="Parar" onClick={() => stop()}><Square size={12} /></button>
      <button className="transport-btn play" title="Tocar" onClick={() => play()}><Play size={16} /></button>
      <button className="transport-btn" title="Pausar" onClick={() => pause()}><Pause size={13} /></button>
      <button className="transport-btn" title="Próxima parte" onClick={() => jumpRelative(1)}><SkipForward size={13} /></button>
      <div className="spacer" />
      <div style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-2)', fontSize: 13 }}>
        -{formatTime(Math.max(0, engineState.realTotalSeconds - engineState.realSeconds))}
      </div>
      <button className="icon-btn" title={SHORTCUTS_HINT} style={{ marginLeft: 6 }}>
        <Keyboard size={15} />
      </button>
    </div>
  );
}
