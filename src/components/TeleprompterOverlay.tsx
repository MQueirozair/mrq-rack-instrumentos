import { useEffect, useMemo, useRef, useState } from 'react';
import { X, ZoomIn, ZoomOut } from 'lucide-react';
import type { Song } from '../../shared/types';
import { semitoneDistance } from '../../shared/types';
import { transposeChordChart, splitChordSections, isChordLine } from '../lib/chordTranspose';
import { useStore } from '../state/useStore';

/**
 * "Modo Palco — Telão": visualização em TELA CHEIA, texto bem grande, da
 * cifra da música atual, pensada pra ficar num monitor/TV secundário virado
 * pro músico/vocalista durante a apresentação (ao contrário da aba "Cifra",
 * que é um painel compacto de edição dentro da janela principal).
 *
 * Diferente da aba "Cifra": aqui o foco é só leitura à distância — fonte bem
 * maior, alto contraste e rolagem automática até a seção da parte que está
 * tocando agora (casamento pelo nome, ex.: parte "Refrão" do roteiro com a
 * seção "[Refrão]" colada na cifra — não é obrigatório bater 100%: se não
 * achar a seção correspondente, só não rola sozinho, sem travar nada).
 */
export default function TeleprompterOverlay({ song, onClose }: { song: Song; onClose: () => void }) {
  const engineState = useStore((s) => s.engineState);
  const jumpToPart = useStore((s) => s.jumpToPart);
  const [fontScale, setFontScale] = useState(1);
  const containerRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Record<number, HTMLDivElement | null>>({});

  const semis = song.chordChart ? semitoneDistance(song.chordChart.originalKey, song.currentKey) : 0;
  const transposed = useMemo(
    () => (song.chordChart ? transposeChordChart(song.chordChart.raw, semis) : ''),
    [song.chordChart, semis]
  );
  const sections = useMemo(() => splitChordSections(transposed), [transposed]);
  const activePart = song.parts.find((p) => p.id === engineState.activePartId);

  const activeSectionIdx = useMemo(() => {
    if (!activePart) return -1;
    const norm = (s: string) => s.trim().toLowerCase();
    return sections.findIndex((sec) => sec.partName && norm(sec.partName) === norm(activePart.name));
  }, [sections, activePart]);

  useEffect(() => {
    if (activeSectionIdx < 0) return;
    sectionRefs.current[activeSectionIdx]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [activeSectionIdx]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      if (e.key === '+' || e.key === '=') setFontScale((f) => Math.min(2.2, f + 0.1));
      if (e.key === '-') setFontScale((f) => Math.max(0.6, f - 0.1));
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="teleprompter-overlay">
      <div className="teleprompter-topbar">
        <div className="teleprompter-title">{song.title} <span className="teleprompter-meta">— Tom {song.currentKey} · {song.currentBpm} BPM</span></div>
        <div className="teleprompter-parts">
          {song.parts.map((p) => (
            <button
              key={p.id}
              className={`teleprompter-part-chip ${p.id === activePart?.id ? 'active' : ''}`}
              style={{ borderColor: p.color }}
              onClick={() => jumpToPart(p.id)}
            >
              {p.name}
            </button>
          ))}
        </div>
        <div className="teleprompter-controls">
          <button className="icon-btn" title="Diminuir fonte (-)" onClick={() => setFontScale((f) => Math.max(0.6, f - 0.1))}><ZoomOut size={18} /></button>
          <button className="icon-btn" title="Aumentar fonte (+)" onClick={() => setFontScale((f) => Math.min(2.2, f + 0.1))}><ZoomIn size={18} /></button>
          <button className="icon-btn" title="Fechar (Esc)" onClick={onClose}><X size={20} /></button>
        </div>
      </div>
      <div className="teleprompter-body" ref={containerRef} style={{ fontSize: `${fontScale}em` }}>
        {!song.chordChart && (
          <div className="teleprompter-empty">Esta música ainda não tem cifra colada — vá na aba "Cifra" pra adicionar.</div>
        )}
        {sections.map((section, i) => (
          <div
            key={i}
            ref={(el) => { sectionRefs.current[i] = el; }}
            className={`teleprompter-section ${i === activeSectionIdx ? 'active' : ''}`}
          >
            {section.partName && <div className="teleprompter-section-title">{section.partName}</div>}
            {section.lines.map((line, j) => (
              <div key={j} className={isChordLine(line) ? 'teleprompter-line chords' : 'teleprompter-line'}>
                {line || '\u00A0'}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
