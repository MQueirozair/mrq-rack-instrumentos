import { useCallback, useEffect, useRef, useState } from 'react';
import { Magnet, ZoomOut } from 'lucide-react';
import type { Song } from '../../shared/types';

interface Props {
  song: Song;
  currentBar: number;
  editable?: boolean;
  onSeekBar: (bar: number) => void;
  onCreateRange?: (startBar: number, endBar: number) => void;
}

const TOTAL_BARS_PADDING = 4;
/** quando o ímã está desligado, a seleção ainda "encaixa" em frações de compasso (1/4) em vez de ficar 100% livre */
const FREE_SNAP_STEP = 0.25;
const ZOOM_MIN = 1;
const ZOOM_MAX = 12;
const ZOOM_WHEEL_FACTOR = 1.18;

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/**
 * Desenho em 2 camadas (canvas separados) para manter a tela fluida durante a
 * reprodução: antes, TUDO (forma de onda, até ~1200 barras de pico, linhas de
 * compasso, faixas coloridas de parte, textos) era redesenhado do zero a cada
 * tick do motor de áudio (~25x por segundo) — e redimensionar um <canvas>
 * (mesmo para o mesmo valor) força o navegador a realocar o bitmap inteiro,
 * o que piora ainda mais isso. Isso deixava a interface visivelmente lenta e
 * consumindo CPU à toa bem na hora de tocar ao vivo.
 * Agora: a camada de FUNDO (estática: forma de onda, grade, cores de parte,
 * nomes das partes, números) só é redesenhada quando a música/seleção/zoom
 * muda; a camada da FRENTE (o traço do cursor de reprodução) é a única
 * redesenhada a cada tick, e o redimensionamento do canvas só acontece
 * quando o tamanho realmente mudou.
 *
 * Zoom: a roda do mouse (scroll) dá zoom horizontal centrado no cursor —
 * igual a um editor de forma de onda de DAW — e o conteúdo passa a rolar
 * dentro de um contêiner com overflow horizontal quando ampliado.
 */
export default function WaveformCanvas({ song, currentBar, editable, onSeekBar, onCreateRange }: Props) {
  const outerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const bgCanvasRef = useRef<HTMLCanvasElement>(null);
  const fgCanvasRef = useRef<HTMLCanvasElement>(null);
  const lastSizeRef = useRef<{ w: number; h: number; dpr: number } | null>(null);
  const [dragStartBar, setDragStartBar] = useState<number | null>(null);
  const [dragEndBar, setDragEndBar] = useState<number | null>(null);
  const [snap, setSnap] = useState(true);
  const [zoom, setZoom] = useState(1);

  const totalBars = Math.max(
    TOTAL_BARS_PADDING,
    ...song.parts.map((p) => p.endBar),
    Math.ceil(currentBar) + TOTAL_BARS_PADDING
  );

  // zoom volta para "ajustar à largura" quando troca de música (evita herdar
  // um zoom de 6x de uma música pra outra sem querer)
  useEffect(() => {
    setZoom(1);
  }, [song.id]);

  const barFromClientX = useCallback(
    (clientX: number) => {
      const el = fgCanvasRef.current;
      if (!el) return 1;
      const rect = el.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return 1 + frac * (totalBars - 1);
    },
    [totalBars]
  );

  /** Arredonda para o compasso inteiro mais próximo (ímã ligado) ou para 1/4 de compasso (ímã desligado). */
  const snapBar = useCallback(
    (bar: number) => {
      if (snap) return Math.round(bar);
      return Math.round(bar / FREE_SNAP_STEP) * FREE_SNAP_STEP;
    },
    [snap]
  );

  /** Garante que os 2 canvas tenham o tamanho certo (já considerando o zoom), só reallocando o bitmap quando o tamanho de fato mudou. */
  const ensureSize = useCallback((): { width: number; height: number } | null => {
    const outer = outerRef.current;
    const bg = bgCanvasRef.current;
    const fg = fgCanvasRef.current;
    if (!outer || !bg || !fg) return null;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(outer.clientWidth * zoom);
    const height = 120;
    const last = lastSizeRef.current;
    if (!last || last.w !== width || last.h !== height || last.dpr !== dpr) {
      for (const c of [bg, fg]) {
        c.width = width * dpr;
        c.height = height * dpr;
        c.style.width = width + 'px';
        c.style.height = height + 'px';
      }
      // o "stack" precisa de uma largura explícita (não 100%) pra poder ficar
      // mais largo que a área visível e rolar dentro de .waveform-scroll —
      // os canvases são position:absolute e não "esticam" o pai sozinhos.
      if (stackRef.current) {
        stackRef.current.style.width = width + 'px';
        stackRef.current.style.height = height + 'px';
      }
      lastSizeRef.current = { w: width, h: height, dpr };
    }
    return { width, height };
  }, [zoom]);

  const drawStatic = useCallback(() => {
    const size = ensureSize();
    const canvas = bgCanvasRef.current;
    if (!canvas || !size) return;
    const { width, height } = size;
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    // faixas de parte (fundo colorido) + etiqueta com o nome da parte
    for (const part of song.parts) {
      const x1 = ((part.startBar - 1) / (totalBars - 1)) * width;
      const x2 = ((part.endBar - 1) / (totalBars - 1)) * width;
      const segWidth = Math.max(1, x2 - x1);
      ctx.fillStyle = part.color + '33';
      ctx.fillRect(x1, 0, segWidth, height);
      ctx.fillStyle = part.color;
      ctx.fillRect(x1, 0, segWidth, 3);

      // etiqueta (pílula colorida com o nome da parte), só quando há espaço
      // suficiente pra ler algo — com zoom alto quase todo trecho mostra o
      // nome inteiro; com zoom baixo, trunca com reticências.
      if (segWidth > 16) {
        ctx.font = '700 10px Segoe UI';
        const paddingX = 6;
        const maxTextWidth = Math.min(segWidth - 8, 130);
        let label = part.name;
        if (ctx.measureText(label).width > maxTextWidth) {
          while (label.length > 1 && ctx.measureText(label + '…').width > maxTextWidth) {
            label = label.slice(0, -1);
          }
          label = label.length > 0 ? label + '…' : '';
        }
        if (label) {
          const textWidth = ctx.measureText(label).width;
          const pillH = 16;
          const pillW = Math.min(segWidth - 4, textWidth + paddingX * 2);
          const pillX = x1 + 3;
          const pillY = 5;
          roundRectPath(ctx, pillX, pillY, pillW, pillH, 4);
          ctx.fillStyle = part.color;
          ctx.fill();
          roundRectPath(ctx, pillX, pillY, pillW, pillH, 4);
          ctx.fillStyle = '#ffffff22';
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, pillX + paddingX, pillY + pillH / 2 + 0.5);
        }
      }
    }

    // forma de onda
    const peaks = song.waveformPeaks;
    if (peaks && peaks.length > 0) {
      const mid = height / 2;
      ctx.fillStyle = '#f2a93b99';
      const barWidth = Math.max(1, width / peaks.length);
      for (let i = 0; i < peaks.length; i++) {
        const h = Math.max(1, peaks[i] * (height - 20));
        ctx.fillRect(i * barWidth, mid - h / 2, Math.max(1, barWidth - 0.5), h);
      }
    } else {
      ctx.fillStyle = '#8c8f9855';
      ctx.fillRect(0, height / 2 - 1, width, 2);
    }

    // linhas de divisão de compasso: uma linha fina em cada compasso, mais forte a cada 4
    const pxPerBar = width / (totalBars - 1);
    if (pxPerBar >= 3) {
      for (let bar = 1; bar <= totalBars; bar++) {
        const x = ((bar - 1) / (totalBars - 1)) * width;
        const isDownbeat = (bar - 1) % 4 === 0;
        ctx.strokeStyle = isDownbeat ? '#ffffff2e' : '#ffffff12';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, 0);
        ctx.lineTo(Math.round(x) + 0.5, height);
        ctx.stroke();
      }
    }

    // seleção de criação de trecho (modo arranjo)
    if (dragStartBar !== null && dragEndBar !== null) {
      const a = Math.min(dragStartBar, dragEndBar);
      const b = Math.max(dragStartBar, dragEndBar);
      const x1 = ((a - 1) / (totalBars - 1)) * width;
      const x2 = ((b - 1) / (totalBars - 1)) * width;
      ctx.fillStyle = '#ffffff22';
      ctx.fillRect(x1, 0, x2 - x1, height);
      ctx.strokeStyle = '#ffffffaa';
      ctx.strokeRect(x1, 0, x2 - x1, height);
    }

    // marcadores de compasso (número a cada 4)
    ctx.fillStyle = '#9a9da6';
    ctx.font = '10px Segoe UI';
    for (let bar = 1; bar <= totalBars; bar += 4) {
      const x = ((bar - 1) / (totalBars - 1)) * width;
      ctx.fillRect(x, height - 10, 1, 10);
      ctx.fillText(String(bar), x + 2, height - 2);
    }
  }, [ensureSize, song, totalBars, dragStartBar, dragEndBar]);

  const drawPlayhead = useCallback(() => {
    const size = ensureSize();
    const canvas = fgCanvasRef.current;
    if (!canvas || !size) return;
    const { width, height } = size;
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    const px = ((currentBar - 1) / (totalBars - 1)) * width;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(px - 1, 0, 2, height);

    // com zoom aplicado, mantém o cursor de reprodução visível rolando a
    // janela automaticamente quando ele sai da área visível.
    const outer = outerRef.current;
    const scrollEl = scrollRef.current;
    if (outer && scrollEl && zoom > 1.001) {
      const viewStart = scrollEl.scrollLeft;
      const viewEnd = viewStart + outer.clientWidth;
      if (px < viewStart + 4 || px > viewEnd - 40) {
        scrollEl.scrollLeft = Math.max(0, px - outer.clientWidth * 0.2);
      }
    }
  }, [ensureSize, currentBar, totalBars, zoom]);

  // camada estática: só muda quando a música/seleção/zoom muda (não a cada tick)
  useEffect(() => {
    drawStatic();
  }, [drawStatic]);

  // camada do cursor: redesenha rápido (clear + 1 retângulo) a cada tick de reprodução
  useEffect(() => {
    drawPlayhead();
  }, [drawPlayhead]);

  useEffect(() => {
    const onResize = () => {
      drawStatic();
      drawPlayhead();
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [drawStatic, drawPlayhead]);

  // Zoom com a roda do mouse, centrado no ponto onde o cursor está — padrão
  // de editores de forma de onda de DAW. Usa addEventListener nativo (não
  // o onWheel do React) para poder chamar preventDefault() de forma
  // confiável e impedir que a página role verticalmente ao dar zoom.
  useEffect(() => {
    const scrollEl = scrollRef.current;
    const outer = outerRef.current;
    if (!scrollEl || !outer) return;

    function onWheel(e: WheelEvent) {
      if (!scrollEl || !outer) return;
      e.preventDefault();
      const rect = scrollEl.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const oldWidth = outer.clientWidth * zoom;
      const absoluteX = scrollEl.scrollLeft + mouseX;
      const barUnderCursor = 1 + Math.min(1, Math.max(0, absoluteX / oldWidth)) * (totalBars - 1);
      const zoomingIn = e.deltaY < 0;
      let nextZoom = zoomingIn ? zoom * ZOOM_WHEEL_FACTOR : zoom / ZOOM_WHEEL_FACTOR;
      nextZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, nextZoom));
      if (Math.abs(nextZoom - zoom) < 0.001) return;
      setZoom(nextZoom);
      requestAnimationFrame(() => {
        if (!scrollRef.current || !outerRef.current) return;
        const newWidth = outerRef.current.clientWidth * nextZoom;
        const newAbsoluteX = ((barUnderCursor - 1) / (totalBars - 1)) * newWidth;
        scrollRef.current.scrollLeft = newAbsoluteX - mouseX;
      });
    }

    scrollEl.addEventListener('wheel', onWheel, { passive: false });
    return () => scrollEl.removeEventListener('wheel', onWheel);
  }, [zoom, totalBars]);

  return (
    <div className="waveform-wrap" ref={outerRef}>
      {zoom > 1.03 && (
        <button
          className="icon-btn waveform-zoom-btn"
          title={`Zoom ${zoom.toFixed(1)}x — clique para ajustar à largura (role o mouse sobre a forma de onda para dar zoom)`}
          onClick={() => setZoom(1)}
        >
          <ZoomOut size={14} /> {zoom.toFixed(1)}x
        </button>
      )}
      {editable && (
        <button
          className={`icon-btn waveform-snap-btn ${snap ? 'active' : ''}`}
          title={snap ? 'Ímã ligado: seleção encaixa no compasso' : 'Ímã desligado: seleção livre (1/4 de compasso)'}
          onClick={() => setSnap((v) => !v)}
        >
          <Magnet size={14} />
        </button>
      )}
      <div className="waveform-scroll" ref={scrollRef}>
        <div className="waveform-canvas-stack" ref={stackRef}>
          <canvas ref={bgCanvasRef} className="waveform-canvas" />
          <canvas
            ref={fgCanvasRef}
            className="waveform-canvas waveform-canvas-fg"
            onMouseDown={(e) => {
              if (!editable) return;
              setDragStartBar(snapBar(barFromClientX(e.clientX)));
              setDragEndBar(snapBar(barFromClientX(e.clientX)));
            }}
            onMouseMove={(e) => {
              if (!editable || dragStartBar === null) return;
              setDragEndBar(snapBar(barFromClientX(e.clientX)));
            }}
            onMouseUp={() => {
              if (editable && dragStartBar !== null && dragEndBar !== null && onCreateRange) {
                const a = Math.min(dragStartBar, dragEndBar);
                const b = Math.max(dragStartBar, dragEndBar);
                if (b - a >= (snap ? 1 : FREE_SNAP_STEP)) onCreateRange(a, b);
              }
              setDragStartBar(null);
              setDragEndBar(null);
            }}
            onClick={(e) => {
              if (editable) return;
              onSeekBar(Math.round(barFromClientX(e.clientX)));
            }}
          />
        </div>
      </div>
    </div>
  );
}
