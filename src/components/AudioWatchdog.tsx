import { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useStore } from '../state/useStore';

const CHECK_MS = 700;
/** se a posição não avançar nada por mais que isso enquanto "tocando", soa o alarme */
const STALL_THRESHOLD_MS = 1600;

/**
 * Fica de olho, em segundo plano, se a reprodução realmente está avançando
 * enquanto diz que está tocando. Sem isso, se o motor de áudio travasse no
 * meio de um culto (ex.: dispositivo de saída caiu, contexto de áudio
 * suspendeu sozinho), o único jeito de perceber seria o silêncio — o
 * operador só descobriria tarde demais. Não mexe em nada sozinho: só avisa.
 */
export default function AudioWatchdog() {
  const [stalled, setStalled] = useState(false);
  const lastSecRef = useRef(0);
  const lastChangeAtRef = useRef(Date.now());

  useEffect(() => {
    const id = setInterval(() => {
      const { engineState } = useStore.getState();
      if (!engineState.isPlaying) {
        setStalled(false);
        lastSecRef.current = engineState.realSeconds;
        lastChangeAtRef.current = Date.now();
        return;
      }
      if (Math.abs(engineState.realSeconds - lastSecRef.current) > 0.03) {
        lastSecRef.current = engineState.realSeconds;
        lastChangeAtRef.current = Date.now();
        if (stalled) setStalled(false);
      } else if (Date.now() - lastChangeAtRef.current > STALL_THRESHOLD_MS) {
        if (!stalled) setStalled(true);
      }
    }, CHECK_MS);
    return () => clearInterval(id);
  }, [stalled]);

  if (!stalled) return null;
  return (
    <div className="audio-watchdog" title="A posição não está avançando enquanto o player diz que está tocando. Verifique a saída de áudio/dispositivo.">
      <AlertTriangle size={14} /> Áudio travado?
    </div>
  );
}
