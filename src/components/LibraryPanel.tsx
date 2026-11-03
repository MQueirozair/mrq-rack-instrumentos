import { useState } from 'react';
import { Plus, Star } from 'lucide-react';
import { useStore } from '../state/useStore';
import { formatTime } from '../lib/format';

export default function LibraryPanel() {
  const library = useStore((s) => s.library);
  const currentSong = useStore((s) => s.currentSong);
  const loadingSongTitle = useStore((s) => s.loadingSongTitle);
  const selectSong = useStore((s) => s.selectSong);
  const deleteSong = useStore((s) => s.deleteSong);
  const importSongFromFolder = useStore((s) => s.importSongFromFolder);
  const toggleFavorite = useStore((s) => s.toggleFavorite);
  const [query, setQuery] = useState('');
  const [onlyFavorites, setOnlyFavorites] = useState(false);

  const songs = library.songs
    .filter((s) => s.title.toLowerCase().includes(query.toLowerCase()))
    .filter((s) => !onlyFavorites || s.favorite)
    // favoritas primeiro, pra achar rápido as músicas mais usadas
    .sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite));

  return (
    <div className="secondary-panel">
      <div className="secondary-header">
        <h2>Biblioteca</h2>
        <button className="icon-btn" title="Importar pasta de multitracks" onClick={() => importSongFromFolder()}><Plus size={18} /></button>
      </div>
      <div className="secondary-body">
        <input
          className="search-box"
          placeholder="Buscar música…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          className={`btn ghost favorites-filter-btn ${onlyFavorites ? 'active' : ''}`}
          title="Mostrar só as músicas favoritas"
          onClick={() => setOnlyFavorites((v) => !v)}
        >
          <Star size={13} fill={onlyFavorites ? 'currentColor' : 'none'} /> Só favoritas
        </button>
        {songs.length === 0 && (
          <div style={{ color: 'var(--text-2)', fontSize: 13, padding: 10 }}>
            {onlyFavorites ? 'Nenhuma música favoritada ainda.' : 'Nenhuma música ainda. Clique em "+" para importar a pasta de uma multitrack.'}
          </div>
        )}
        {songs.map((song) => (
          <div
            key={song.id}
            className={`song-list-item ${currentSong?.id === song.id ? 'selected' : ''}`}
            onClick={() => selectSong(song.id)}
          >
            <div className="title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button
                className="favorite-star-btn"
                title={song.favorite ? 'Remover dos favoritos' : 'Marcar como favorita'}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleFavorite(song.id);
                }}
              >
                <Star size={14} fill={song.favorite ? '#f2c84b' : 'none'} color={song.favorite ? '#f2c84b' : 'var(--text-2)'} />
              </button>
              {song.title}
              {loadingSongTitle === song.title && <span className="spinner-sm" title="Abrindo…" />}
            </div>
            <div className="meta">
              Tom {song.currentKey} · {song.currentBpm} BPM
              {song.durationSec ? ` · ${formatTime(song.durationSec)}` : ''} · {song.tracks.length} faixas
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                className="btn danger"
                style={{ padding: '2px 8px', fontSize: 11 }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Remover "${song.title}" da biblioteca? Os arquivos de áudio não serão apagados.`)) {
                    deleteSong(song.id);
                  }
                }}
              >
                Remover
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
