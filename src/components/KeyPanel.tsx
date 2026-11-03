import type { Song } from '../../shared/types';
import { useStore } from '../state/useStore';

export default function KeyPanel({ song }: { song: Song }) {
  const setTrackFollowsKey = useStore((s) => s.setTrackFollowsKey);

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>Tom</h3>
      <p style={{ color: 'var(--text-2)', fontSize: 12, marginTop: -8 }}>
        Escolha quais faixas mudam de tom junto com a música. Click, guia e bateria normalmente ficam fixas.
      </p>
      <div className="rows-panel">
        {song.tracks.map((track) => (
          <div className="row" key={track.id}>
            <span className="name">{track.name}</span>
            <button
              className={`toggle-pill ${track.followsKey ? 'on' : ''}`}
              onClick={() => setTrackFollowsKey(track.id, !track.followsKey)}
            >
              {track.followsKey ? 'Muda de tom' : 'Fica fixa'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
