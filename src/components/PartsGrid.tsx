import { Repeat } from 'lucide-react';
import type { Song } from '../../shared/types';

interface Props {
  song: Song;
  activePartId: string | null;
  pendingPartId: string | null;
  loopActive: boolean;
  onJump: (partId: string) => void;
  onToggleLoop: () => void;
}

export default function PartsGrid({ song, activePartId, pendingPartId, loopActive, onJump, onToggleLoop }: Props) {
  return (
    <div className="parts-grid">
      <button
        className={`loop-btn ${loopActive ? 'active' : ''}`}
        style={{ gridColumn: 6, gridRow: '1 / span 2' }}
        title="Repetir a parte ativa"
        onClick={onToggleLoop}
      >
        <Repeat size={17} />
      </button>
      {song.parts.map((part, i) => (
        <button
          key={part.id}
          className={`part-btn ${part.id === activePartId ? 'active' : ''} ${part.id === pendingPartId ? 'pending' : ''}`}
          style={{ background: part.color }}
          onClick={() => onJump(part.id)}
        >
          <span className="idx">{i + 1}</span>
          {part.name}
        </button>
      ))}
    </div>
  );
}
