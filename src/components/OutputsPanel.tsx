import type { Song } from '../../shared/types';
import { useStore } from '../state/useStore';
import { pairIndexLabel } from '../audio/AudioEngine';

export default function OutputsPanel({ song }: { song: Song }) {
  const setTrackOutput = useStore((s) => s.setTrackOutput);
  const settings = useStore((s) => s.settings);
  const pairCount = Math.max(1, Math.floor(settings.outputChannelCount / 2));
  const options = Array.from({ length: pairCount }, (_, i) => i);

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>Saídas</h3>
      <p style={{ color: 'var(--text-2)', fontSize: 12, marginTop: -8 }}>
        Escolha para onde vai cada faixa. Pares (1/2, 3/4…) tocam em estéreo. Isso usa os canais do seu
        dispositivo de áudio multicanal, configurado em Ajustes → Áudio.
      </p>
      <div className="rows-panel">
        {song.tracks.map((track) => (
          <div className="row" key={track.id}>
            <span className="name">{track.name}</span>
            <select
              value={track.output}
              onChange={(e) => setTrackOutput(track.id, e.target.value)}
            >
              {options.map((i) => (
                <option key={i} value={`stereo-${i * 2 + 1}-${i * 2 + 2}`}>
                  {pairIndexLabel(i)}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}
