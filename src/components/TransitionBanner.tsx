import type { EngineState } from '../audio/AudioEngine';
import type { Song } from '../../shared/types';

/**
 * Mostra, acima da barra de transporte:
 *  - quando há uma troca de parte PEDIDA pelo operador (clicou numa parte
 *    diferente da que está tocando): "<Nome> entra em N compassos" — dá a
 *    certeza visual de que o pedido foi recebido e vai respeitar o fim da
 *    parte atual (e não vai cortar ela no meio).
 *  - sempre que der pra prever a próxima parte (mesmo sem pedido manual):
 *    um rótulo discreto "A seguir: <Nome>", que pisca/destaca nos últimos
 *    compassos pra avisar a banda de uma transição automática chegando.
 */
export default function TransitionBanner({ song, engineState }: { song: Song; engineState: EngineState }) {
  const activePart = song.parts.find((p) => p.id === engineState.activePartId);
  if (!activePart || !engineState.isPlaying) return null;

  const barsLeft = Math.max(0, Math.ceil(activePart.endBar - engineState.currentBar));
  const pendingPart = engineState.pendingPartId ? song.parts.find((p) => p.id === engineState.pendingPartId) : null;
  const upcomingPart = !pendingPart && engineState.upcomingPartId
    ? song.parts.find((p) => p.id === engineState.upcomingPartId)
    : null;

  if (!pendingPart && !upcomingPart) return null;

  const imminent = barsLeft <= 2;

  if (pendingPart) {
    return (
      <div className={`transition-banner pending ${imminent ? 'imminent' : ''}`}>
        <strong>{pendingPart.name}</strong> entra em {barsLeft} {barsLeft === 1 ? 'compasso' : 'compassos'}
      </div>
    );
  }

  return (
    <div className={`transition-banner upcoming ${imminent ? 'imminent' : ''}`}>
      A seguir: <strong>{upcomingPart!.name}</strong> {imminent ? `(em ${barsLeft})` : ''}
    </div>
  );
}
