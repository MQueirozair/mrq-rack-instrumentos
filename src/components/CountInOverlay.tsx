import type { EngineState } from '../audio/AudioEngine';

/**
 * Contador de entrada em números grandes, no centro da tela, pulsando a cada
 * batida — complementa o texto pequeno "ENTRADA N" que já existe no cabeçalho,
 * dando um aviso bem visível de longe (ex.: músico olhando de trás do palco)
 * de quantas batidas faltam para o som começar.
 */
export default function CountInOverlay({ engineState }: { engineState: EngineState }) {
  if (!engineState.isCountingIn) return null;
  return (
    <div className="count-in-overlay" aria-hidden>
      <div className="count-in-number" key={engineState.countInBeatsLeft}>
        {engineState.countInBeatsLeft}
      </div>
    </div>
  );
}
