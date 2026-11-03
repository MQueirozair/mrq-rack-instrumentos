import { useMemo, useState } from 'react';
import { Tv } from 'lucide-react';
import type { Song } from '../../shared/types';
import { semitoneDistance } from '../../shared/types';
import { transposeChordChart, isChordLine, splitChordSections } from '../lib/chordTranspose';
import { useStore } from '../state/useStore';

export default function ChordView({ song }: { song: Song }) {
  const setChordChart = useStore((s) => s.setChordChart);
  const jumpToPart = useStore((s) => s.jumpToPart);
  const engineState = useStore((s) => s.engineState);
  const setTeleprompterOpen = useStore((s) => s.setTeleprompterOpen);
  const [editing, setEditing] = useState(!song.chordChart);
  const [draft, setDraft] = useState(song.chordChart?.raw ?? '');

  const semis = song.chordChart ? semitoneDistance(song.chordChart.originalKey, song.currentKey) : 0;
  const transposed = useMemo(
    () => (song.chordChart ? transposeChordChart(song.chordChart.raw, semis) : ''),
    [song.chordChart, semis]
  );
  const sections = useMemo(() => splitChordSections(transposed), [transposed]);
  const activePart = song.parts.find((p) => p.id === engineState.activePartId);

  return (
    <div className="chord-pane">
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => setEditing(true)}>Colar cifra</button>
          {song.chordChart && (
            <button className="btn ghost" onClick={() => setTeleprompterOpen(true)} title="Abrir cifra em tela cheia, pra monitor/TV virado pro músico">
              <Tv size={13} style={{ marginRight: 6 }} />Modo Palco — Telão
            </button>
          )}
          <span style={{ color: 'var(--text-2)', fontSize: 12, alignSelf: 'center' }}>
            {song.chordChart ? `Tom da cifra: ${song.chordChart.originalKey} · Tocando em: ${song.currentKey}` : 'Nenhuma cifra colada ainda'}
          </span>
        </div>

        {editing ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={'Cole aqui a cifra, usando [Nome da parte] para marcar seções.\nEx:\n[Ponte]\n   G        A\nE eu...'}
              style={{ flex: 1, resize: 'none', fontFamily: 'monospace' }}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn primary"
                onClick={() => {
                  setChordChart(draft, song.currentKey);
                  setEditing(false);
                }}
              >
                Salvar cifra (tom atual: {song.currentKey})
              </button>
              <button className="btn ghost" onClick={() => setEditing(false)}>Cancelar</button>
            </div>
          </div>
        ) : (
          <div className="chord-text">
            {sections.map((section, i) => (
              <div key={i}>
                {section.partName && <div className="chord-section-title">{section.partName}</div>}
                {section.lines.map((line, j) => (
                  <div key={j} className={isChordLine(line) ? 'chord-line is-chords' : 'chord-line'}>
                    {line || '\u00A0'}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ width: 300, flexShrink: 0, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, alignContent: 'start' }}>
        {song.parts.map((part, i) => (
          <button
            key={part.id}
            className={`part-btn ${part.id === activePart?.id ? 'active' : ''}`}
            style={{ background: part.color, minHeight: 64 }}
            onClick={() => jumpToPart(part.id)}
          >
            <span className="idx">{i + 1}</span>
            {part.name}
          </button>
        ))}
      </div>
    </div>
  );
}
