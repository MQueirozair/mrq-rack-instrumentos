import type { EngineState } from '../audio/AudioEngine';

/**
 * Metrônomo visual: uma bolinha que pisca em cada batida, calculada a partir
 * da posição contínua do cursor (engineState.currentBar) — não depende de
 * nenhum relógio novo, só da fração do compasso atual. Pisca mais forte
 * (e maior) no tempo 1 de cada compasso. Útil pra manter o tempo olhando a
 * tela em vez de contar de ouvido, por exemplo com fones isolantes no palco.
 */
export default function VisualMetronome({ engineState, beatsPerBar }: { engineState: EngineState; beatsPerBar: number }) {
  const barFrac = engineState.currentBar - Math.floor(engineState.currentBar);
  const beatInBar = barFrac * beatsPerBar;
  const beatIndex = Math.floor(beatInBar) % Math.max(1, beatsPerBar);
  const beatPhase = beatInBar - Math.floor(beatInBar);
  const isDownbeat = beatIndex === 0;
  const active = engineState.isPlaying || engineState.isCountingIn;
  const opacity = active ? Math.max(0.18, 1 - beatPhase) : 0.18;
  const scale = active ? 1 + (isDownbeat ? 0.55 : 0.3) * (1 - beatPhase) : 1;

  return (
    <div className="visual-metronome" title="Metrônomo visual">
      <div
        className={`visual-metronome-dot ${isDownbeat ? 'downbeat' : ''}`}
        style={{ opacity, transform: `scale(${scale})` }}
      />
    </div>
  );
}
