import { ArrowRight } from 'lucide-react';
import { useStore } from '../state/useStore';

/**
 * Cartão fixo com a próxima música da cena (nome, tom, BPM), visível o tempo
 * todo enquanto uma cena está em reprodução — antes só existia a marquinha
 * "A SEGUIR" na lista da aba Setlist, que fica escondida assim que o operador
 * troca de aba. Some sozinho quando não há cena ativa ou a atual não tem uma
 * próxima música.
 */
export default function NextSongPreview() {
  const library = useStore((s) => s.library);
  const activeSceneId = useStore((s) => s.activeSceneId);
  const currentSong = useStore((s) => s.currentSong);

  const scene = library.scenes.find((s) => s.id === activeSceneId);
  if (!scene || !currentSong) return null;
  const idx = scene.items.findIndex((it) => it.songId === currentSong.id);
  if (idx === -1) return null;
  const nextItem = scene.items[idx + 1];
  if (!nextItem) return null;
  const nextSong = library.songs.find((s) => s.id === nextItem.songId);
  if (!nextSong) return null;

  return (
    <div className="next-song-preview" title="Próxima música da cena atual">
      <ArrowRight size={13} />
      <span className="next-song-label">A seguir</span>
      <strong>{nextSong.title}</strong>
      <span className="next-song-meta">Tom {nextItem.key} · {nextItem.bpm} BPM</span>
    </div>
  );
}
