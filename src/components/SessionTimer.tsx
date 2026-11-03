import { useEffect, useState } from 'react';
import { RotateCcw, Timer } from 'lucide-react';

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * Cronômetro de ensaio/sessão: começa a contar sozinho quando o app abre e
 * fica visível na barra de título o tempo todo. Clique no ícone de
 * "reiniciar" pra zerar na hora que o ensaio realmente começar (ex.: depois
 * de terminar de afinar e testar o som).
 */
export default function SessionTimer() {
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="pill session-timer" title="Tempo decorrido desde que o app foi aberto (clique no ícone para zerar)">
      <Timer size={12} />
      <span className="session-timer-value">{formatElapsed(now - startedAt)}</span>
      <button
        className="session-timer-reset"
        title="Zerar cronômetro"
        onClick={(e) => {
          e.stopPropagation();
          setStartedAt(Date.now());
        }}
      >
        <RotateCcw size={11} />
      </button>
    </div>
  );
}
