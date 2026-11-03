import { useState } from 'react';
import { StickyNote } from 'lucide-react';
import type { Song } from '../../shared/types';
import { useStore } from '../state/useStore';

/**
 * Anotações rápidas por música: lembretes do operador (ex.: "subir o PAD no
 * refrão", "combinado com o baterista: sem repique no final"). Ficam salvas
 * junto com a música na biblioteca, e o ícone acende quando já existe alguma
 * nota, mesmo com o popover fechado.
 */
export default function SongNotes({ song }: { song: Song }) {
  const updateSongNotes = useStore((s) => s.updateSongNotes);
  const [open, setOpen] = useState(false);
  const hasNotes = !!song.notes && song.notes.trim().length > 0;

  return (
    <div className="song-notes-wrap">
      <button
        className={`icon-btn ${hasNotes ? 'active' : ''}`}
        title={hasNotes ? 'Ver/editar anotações desta música' : 'Adicionar uma anotação a esta música'}
        onClick={() => setOpen((v) => !v)}
      >
        <StickyNote size={15} />
      </button>
      {open && (
        <div className="song-notes-popover">
          <textarea
            autoFocus
            placeholder="Anotações sobre esta música (combinados com a banda, lembretes, etc.)…"
            value={song.notes ?? ''}
            onChange={(e) => updateSongNotes(song.id, e.target.value)}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn ghost" style={{ fontSize: 11, padding: '3px 10px' }} onClick={() => setOpen(false)}>
              Fechar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
