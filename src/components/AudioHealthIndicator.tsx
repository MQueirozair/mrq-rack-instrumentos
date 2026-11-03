import { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { engine } from '../audio/engineInstance';
import { useStore } from '../state/useStore';

/**
 * "Monitor de saúde do áudio": fica de olho em estouros/falhas do motor de
 * áudio (buffer underrun, AudioContext suspenso sozinho pelo SO, travadas)
 * ENQUANTO a música está tocando, e avisa na hora com uma pílula bem visível
 * na barra de título — em vez do operador só perceber um problema de áudio
 * ao vivo pelo ouvido, no meio do culto/show, sem saber se foi o computador,
 * o driver de som ou algum outro aplicativo roubando o processador.
 *
 * Como detecta (sem mexer em nada do motor de reprodução em si — só
 * observa, nunca interfere): a cada quadro, compara quanto tempo passou no
 * relógio da própria música (`AudioContext.currentTime`, que o navegador
 * SEMPRE avança no ritmo real da placa de som) contra quanto tempo passou no
 * relógio de parede (`performance.now()`). Se o áudio tocando avançou bem
 * menos que o tempo real (ex.: o processo travou um instante, o SO suspendeu
 * o contexto), ou se `ctx.state` deixou de ser `"running"` sozinho, contamos
 * como um "soluço". Pequenas variações (jitter normal de alguns ms) são
 * toleradas; só acende com uma folga real perdida.
 */
export default function AudioHealthIndicator() {
  const isPlaying = useStore((s) => s.engineState.isPlaying);
  const [glitches, setGlitches] = useState(0);
  const [visible, setVisible] = useState(false);
  const hideTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    let lastWall = performance.now();
    let lastAudio = engine.ctx.currentTime;
    function tick() {
      const wall = performance.now();
      const audio = engine.ctx.currentTime;
      const dWall = (wall - lastWall) / 1000;
      const dAudio = audio - lastAudio;
      lastWall = wall;
      lastAudio = audio;
      // só avalia em janelas "normais" de quadro (ignora o 1º tick depois de
      // uma pausa longa da aba, que não é um soluço de áudio de verdade).
      const isGlitch = dWall > 0.05 && dWall < 2 && (dAudio < dWall * 0.5 || engine.ctx.state !== 'running');
      if (isGlitch) {
        setGlitches((g) => g + 1);
        setVisible(true);
        if (hideTimer.current) window.clearTimeout(hideTimer.current);
        hideTimer.current = window.setTimeout(() => setVisible(false), 8000);
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying]);

  useEffect(() => {
    if (!isPlaying) {
      setGlitches(0);
      setVisible(false);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    }
  }, [isPlaying]);

  if (!visible) return null;
  return (
    <div
      className="pill audio-health-warning"
      title={`Possível falha/soluço no áudio detectada (${glitches}x) — pode ser o computador sobrecarregado, outro programa usando o processador, ou o driver de som. Verifique antes de continuar.`}
    >
      <AlertTriangle size={12} />
      <span>Soluço de áudio ({glitches})</span>
    </div>
  );
}
