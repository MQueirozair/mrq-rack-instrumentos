import { useCallback, useEffect, useRef } from 'react';
import { Bell, Drum, Guitar, Infinity as InfinityIcon, Mic, Mic2, Piano, SlidersHorizontal, Users } from 'lucide-react';
import type { Song, TrackRole } from '../../shared/types';
import { useStore } from '../state/useStore';
import { ROLE_COLOR } from './MixerStrip';

const ROLE_ICON: Record<TrackRole, typeof Bell> = {
  click: Bell,
  guide: Mic2,
  drums: Drum,
  bass: Guitar,
  guitar: Guitar,
  keys: Piano,
  vocal: Mic,
  choir: Users,
  loop: InfinityIcon,
  other: SlidersHorizontal,
};

const LANE_HEIGHT = 50;
const TOTAL_BARS_PADDING = 4;

interface Props {
  song: Song;
  currentBar: number;
  onSeekBar: (bar: number) => void;
}

/**
 * Tela "Faixas": mostra a forma de onda de cada arquivo de áudio da
 * multitrack lado a lado, uma trilha por linha, com a mesma régua de
 * compassos e as cores das partes da música ao fundo — como num editor
 * multipista. A forma de onda estática é desenhada uma vez num canvas
 * "offscreen" (em memória) e só recolada (blit) a cada atualização; apenas a
 * linha do cursor de reprodução é redesenhada por cima, o que mantém o
 * desenho leve mesmo com muitas faixas tocando ao mesmo tempo.
 */
export default function TracksView({ song, currentBar, onSeekBar }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  const setTrackMuted = useStore((s) => s.setTrackMuted);
  const setTrackSolo = useStore((s) => s.setTrackSolo);

  const totalBars = Math.max(
    TOTAL_BARS_PADDING,
    ...song.parts.map((p) => p.endBar),
    Math.ceil(currentBar) + TOTAL_BARS_PADDING
  );

  const barFromClientX = useCallback(
    (clientX: number) => {
      const el = canvasRef.current;
      if (!el) return 1;
      const rect = el.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return 1 + frac * (totalBars - 1);
    },
    [totalBars]
  );

  const anySolo = song.tracks.some((t) => t.solo);

  const drawStatic = useCallback(() => {
    const wrap = wrapRef.current;
    const visible = canvasRef.current;
    if (!wrap || !visible) return;
    const dpr = window.devicePixelRatio || 1;
    const width = wrap.clientWidth;
    const height = Math.max(LANE_HEIGHT, LANE_HEIGHT * song.tracks.length);

    let off = offscreenRef.current;
    if (!off) {
      off = document.createElement('canvas');
      offscreenRef.current = off;
    }
    off.width = width * dpr;
    off.height = height * dpr;
    const ctx = off.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    song.tracks.forEach((track, i) => {
      const y = i * LANE_HEIGHT;
      const mid = y + LANE_HEIGHT / 2;
      const dimmed = track.muted || (anySolo && !track.solo);

      // fundo colorido das partes (bem sutil) para orientação visual
      for (const part of song.parts) {
        const x1 = ((part.startBar - 1) / (totalBars - 1)) * width;
        const x2 = ((part.endBar - 1) / (totalBars - 1)) * width;
        ctx.fillStyle = part.color + '22';
        ctx.fillRect(x1, y, Math.max(1, x2 - x1), LANE_HEIGHT);
      }

      const peaks = track.peaks;
      ctx.fillStyle = dimmed ? '#7a7d8855' : ROLE_COLOR[track.role] + 'dd';
      if (peaks && peaks.length > 0) {
        const barWidth = Math.max(1, width / peaks.length);
        for (let p = 0; p < peaks.length; p++) {
          const h = Math.max(1, peaks[p] * (LANE_HEIGHT - 12));
          ctx.fillRect(p * barWidth, mid - h / 2, Math.max(1, barWidth - 0.5), h);
        }
      } else {
        ctx.fillRect(0, mid - 1, width, 2);
      }

      // linha separadora entre faixas
      ctx.strokeStyle = '#ffffff14';
      ctx.beginPath();
      ctx.moveTo(0, y + LANE_HEIGHT - 0.5);
      ctx.lineTo(width, y + LANE_HEIGHT - 0.5);
      ctx.stroke();
    });

    // marcadores de compasso (a cada 4) por cima de tudo, discretos
    ctx.fillStyle = '#5a5d6688';
    ctx.font = '9px Segoe UI';
    for (let bar = 1; bar <= totalBars; bar += 4) {
      const x = ((bar - 1) / (totalBars - 1)) * width;
      ctx.fillText(String(bar), x + 2, 9);
    }

    visible.width = off.width;
    visible.height = off.height;
    visible.style.width = width + 'px';
    visible.style.height = height + 'px';
    blitWithPlayhead();
  }, [song, totalBars, anySolo]);

  const blitWithPlayhead = useCallback(() => {
    const visible = canvasRef.current;
    const off = offscreenRef.current;
    const wrap = wrapRef.current;
    if (!visible || !off || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const width = wrap.clientWidth;
    const height = off.height / dpr;
    const ctx = visible.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, visible.width, visible.height);
    ctx.drawImage(off, 0, 0, off.width, off.height, 0, 0, visible.width, visible.height);
    ctx.scale(dpr, dpr);
    const px = ((currentBar - 1) / (totalBars - 1)) * width;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(px - 1, 0, 2, height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }, [currentBar, totalBars]);

  useEffect(() => {
    drawStatic();
    const onResize = () => drawStatic();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song, totalBars, anySolo]);

  useEffect(() => {
    blitWithPlayhead();
  }, [blitWithPlayhead]);

  return (
    <div className="tracks-view card">
      <div className="tracks-labels">
        {song.tracks.map((track) => {
          const RoleIcon = ROLE_ICON[track.role];
          const dimmed = track.muted || (anySolo && !track.solo);
          return (
            <div
              className={`tracks-label-row${dimmed ? ' dimmed' : ''}`}
              key={track.id}
              style={{ height: LANE_HEIGHT, '--role-color': ROLE_COLOR[track.role] } as React.CSSProperties}
            >
              <span className="tracks-label-icon"><RoleIcon size={13} /></span>
              <span className="tracks-label-name" title={track.name}>{track.name}</span>
              <div style={{ flex: 1 }} />
              <button
                className={track.muted ? 'on mute' : ''}
                title="Mudo"
                onClick={() => setTrackMuted(track.id, !track.muted)}
              >
                M
              </button>
              <button
                className={track.solo ? 'on solo' : ''}
                title="Solo"
                onClick={() => setTrackSolo(track.id, !track.solo)}
              >
                S
              </button>
            </div>
          );
        })}
      </div>
      <div className="tracks-canvas-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className="tracks-canvas"
          onClick={(e) => onSeekBar(Math.round(barFromClientX(e.clientX)))}
        />
      </div>
    </div>
  );
}
