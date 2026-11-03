import type { Song } from '../../shared/types';
import { useStore } from '../state/useStore';
import PadWidget from './PadWidget';
import AudioWatchdog from './AudioWatchdog';
import SongNotes from './SongNotes';
import NextSongPreview from './NextSongPreview';

const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export default function SongHeader({ song }: { song: Song }) {
  const setKey = useStore((s) => s.setKey);
  const setBpm = useStore((s) => s.setBpm);
  const engineState = useStore((s) => s.engineState);

  const keyIdx = KEYS.indexOf(song.currentKey);
  const step = (delta: number) => {
    const idx = ((keyIdx + delta) % 12 + 12) % 12;
    setKey(KEYS[idx]);
  };

  return (
    <div className="song-header">
      <div>
        <h1 className="song-title" title={song.title}>{song.title}</h1>
        <div className="status-pill">
          {song.originalKey !== song.currentKey && <>original {song.originalKey} · </>}
          {song.tracks.length} faixas
        </div>
        <NextSongPreview />
      </div>
      <div className="song-header-controls">
        <SongNotes song={song} />
        <div className="stepper-field">
          <label>Tom</label>
          <button className="stepper-btn" onClick={() => step(-1)}>–</button>
          <span className="value">{song.currentKey}</span>
          <button className="stepper-btn" onClick={() => step(1)}>+</button>
        </div>
        <div className="stepper-field">
          <label>BPM</label>
          <button className="stepper-btn" onClick={() => setBpm(Math.max(30, song.currentBpm - 1))}>–</button>
          <span className="value">{song.currentBpm}</span>
          <button className="stepper-btn" onClick={() => setBpm(Math.min(260, song.currentBpm + 1))}>+</button>
        </div>
        <div className={`status-pill ${engineState.isPlaying ? 'playing' : ''}`}>
          {engineState.isCountingIn ? `ENTRADA ${engineState.countInBeatsLeft}` : engineState.isPlaying ? 'TOCANDO' : 'PAUSADO'}
        </div>
        <PadWidget song={song} />
        <AudioWatchdog />
      </div>
    </div>
  );
}
