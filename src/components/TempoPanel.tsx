import { useMemo, useState } from 'react';
import type { Song } from '../../shared/types';
import { useStore } from '../state/useStore';
import { engine } from '../audio/engineInstance';
import { TapTempo } from '../lib/tapTempo';

const PRACTICE_SPEEDS = [50, 60, 70, 80, 90, 100];

export default function TempoPanel({ song, onOpenSettings }: { song: Song; onOpenSettings: () => void }) {
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const updateCurrentSong = useStore((s) => s.updateCurrentSong);
  const setBpm = useStore((s) => s.setBpm);
  const engineState = useStore((s) => s.engineState);
  const toggleLoopActivePart = useStore((s) => s.toggleLoopActivePart);
  const setPracticeLoopAction = useStore((s) => s.setPracticeLoop);
  const clearPracticeLoopAction = useStore((s) => s.clearPracticeLoop);
  const [practicePercent, setPracticePercent] = useState<number | null>(null);
  const tapTempo = useMemo(() => new TapTempo(), []);
  const [tapBpm, setTapBpm] = useState<number | null>(null);
  const [tapCount, setTapCount] = useState(0);
  const [markA, setMarkA] = useState<number | null>(null);

  /** "Tap tempo": cada clique alimenta a média móvel de TapTempo (src/lib/tapTempo.ts);
   *  a partir da 2ª batida já mostramos um BPM provisório, e só aplicamos à música
   *  (setBpm, que já grava no currentBpm e avisa o motor) quando o usuário confirma —
   *  evita que um clique isolado/errado mude o andamento da música sem querer. */
  function handleTap() {
    const bpm = tapTempo.tap();
    setTapCount((c) => c + 1);
    setTapBpm(bpm);
  }

  function applyTapBpm() {
    if (tapBpm) setBpm(Math.round(tapBpm));
    tapTempo.reset();
    setTapBpm(null);
    setTapCount(0);
  }

  /** Entra/sai do modo ensaio: toca a parte ativa em loop numa velocidade reduzida,
   *  SEM alterar o BPM salvo da música (ao sair, volta pro BPM normal sozinho). */
  function setPractice(percent: number | null) {
    setPracticePercent(percent);
    if (percent === null) {
      engine.setBpm(song.currentBpm);
      return;
    }
    if (!engineState.loopActivePart) toggleLoopActivePart();
    engine.setBpm(Math.round((song.currentBpm * percent) / 100));
  }

  return (
    <div>
      <div className="field-row">
        <div>
          <div className="label">Modo Ensaio</div>
          <div className="hint">Toca a parte ativa em loop numa velocidade reduzida, pra estudar antes do culto (não altera o BPM salvo).</div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
        {PRACTICE_SPEEDS.map((p) => (
          <button
            key={p}
            className={`btn ${practicePercent === p ? 'primary' : ''}`}
            onClick={() => setPractice(practicePercent === p ? null : p)}
          >
            {p}%
          </button>
        ))}
        {practicePercent !== null && (
          <button className="btn ghost" onClick={() => setPractice(null)}>Sair do ensaio</button>
        )}
      </div>

      <div className="field-row">
        <div>
          <div className="label">Loop A/B (ensaio de trecho)</div>
          <div className="hint">
            Marque A no início do trecho difícil e B no fim (compasso atual: {Math.floor(engineState.currentBar)}) —
            o MRQ martela só esse pedaço em loop até você desativar. Independente do loop da parte inteira.
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {engineState.practiceLoop ? (
            <>
              <span className="hint" style={{ fontWeight: 700, color: 'var(--text-1)' }}>
                Compassos {Math.floor(engineState.practiceLoop.startBar)}–{Math.floor(engineState.practiceLoop.endBar)}
              </span>
              <button className="btn ghost" onClick={() => { clearPracticeLoopAction(); setMarkA(null); }}>Desativar loop A/B</button>
            </>
          ) : (
            <>
              <button className="btn" onClick={() => setMarkA(engineState.currentBar)}>
                {markA === null ? 'Marcar A' : `A = ${Math.floor(markA)}`}
              </button>
              <button
                className="btn primary"
                disabled={markA === null}
                onClick={() => {
                  if (markA === null) return;
                  const b = engineState.currentBar;
                  setPracticeLoopAction(Math.min(markA, b), Math.max(markA, b));
                }}
              >
                Marcar B e ativar
              </button>
            </>
          )}
        </div>
      </div>

      <h3 style={{ marginTop: 0 }}>Tempo</h3>

      <div className="field-row">
        <div>
          <div className="label">BPM e compasso</div>
          <div className="hint">
            {song.currentBpm} BPM · {song.timeSignatureNum}/{song.timeSignatureDen} · {Math.round((song.durationSec / (60 / song.currentBpm * song.timeSignatureNum)) || 0)} compassos
          </div>
        </div>
        <button className="btn" onClick={onOpenSettings}>Ajustar</button>
      </div>

      <div className="field-row">
        <div>
          <div className="label">Fórmula de compasso</div>
          <div className="hint">Usada para calcular os compassos das partes.</div>
        </div>
        <select
          value={`${song.timeSignatureNum}/${song.timeSignatureDen}`}
          onChange={(e) => {
            const [num, den] = e.target.value.split('/').map(Number);
            updateCurrentSong((s) => ({ ...s, timeSignatureNum: num, timeSignatureDen: den }));
          }}
        >
          {['4/4', '3/4', '6/8', '2/4', '5/4'].map((ts) => (
            <option key={ts} value={ts}>{ts}</option>
          ))}
        </select>
      </div>

      <div className="field-row">
        <div>
          <div className="label">Tap tempo</div>
          <div className="hint">
            Bata no ritmo da música (tecla ou clique) pra calcular o BPM na hora — útil quando não dá pra digitar o
            número de cabeça. Bata pelo menos 2 vezes seguidas; a cada toque dentro de ~2,2s do anterior a média é
            recalculada. Confirme pra aplicar o BPM calculado à música.
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {tapBpm !== null && <span className="hint" style={{ fontWeight: 700, color: 'var(--text-1)' }}>{tapBpm} BPM</span>}
          <button className="btn" onClick={handleTap}>👆 Bater ({tapCount})</button>
          {tapBpm !== null && (
            <>
              <button className="btn primary" onClick={applyTapBpm}>Aplicar</button>
              <button className="btn ghost" onClick={() => { tapTempo.reset(); setTapBpm(null); setTapCount(0); }}>Cancelar</button>
            </>
          )}
        </div>
      </div>

      <div className="field-row">
        <div>
          <div className="label">Dobrar o click</div>
          <div className="hint">Nesta música: toca o metrônomo próprio por cima do click gravado.</div>
        </div>
        <select
          value={settings.click.doubleClick}
          onChange={(e) => updateSettings({ click: { ...settings.click, doubleClick: e.target.value as 'off' | 'on' } })}
        >
          <option value="off">Desligado</option>
          <option value="on">Ligado</option>
        </select>
      </div>
    </div>
  );
}
