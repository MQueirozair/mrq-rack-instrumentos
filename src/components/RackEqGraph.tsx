import { useEffect, useRef, useState } from 'react';
import { RACK_EQ_BAND_LABELS, RACK_EQ_BAND_ROLES } from '../../shared/types';
import type { RackEqBandRole, RackEqBandSettings } from '../../shared/types';
import { rackEngine } from '../audio/rack/RackEngine';

const MIN_FREQ = 20;
const MAX_FREQ = 20000;
const MIN_DB = -24;
const MAX_DB = 18;
const W = 640;
const H = 180;
const LOG_MIN = Math.log10(MIN_FREQ);
const LOG_MAX = Math.log10(MAX_FREQ);

function freqToX(freq: number): number {
  const t = (Math.log10(Math.max(MIN_FREQ, freq)) - LOG_MIN) / (LOG_MAX - LOG_MIN);
  return t * W;
}
function xToFreq(x: number): number {
  const t = Math.min(1, Math.max(0, x / W));
  return Math.pow(10, LOG_MIN + t * (LOG_MAX - LOG_MIN));
}
function dbToY(db: number): number {
  const t = (db - MAX_DB) / (MIN_DB - MAX_DB);
  return Math.min(1, Math.max(0, t)) * H;
}
function yToDb(y: number): number {
  const t = Math.min(1, Math.max(0, y / H));
  return MAX_DB + t * (MIN_DB - MAX_DB);
}

const BAND_COLORS: Record<RackEqBandRole, string> = {
  lowcut: '#9aa0a6',
  lowshelf: '#2fb8c6',
  bell1: '#e0c23c',
  bell2: '#d6455d',
  highshelf: '#8a5fd6',
  highcut: '#6b7280',
};

/**
 * Equalizador paramétrico de 6 bandas por camada, com gráfico interativo
 * (arraste os pontos pra mudar frequência/ganho, scroll pra ajustar o Q) e
 * um analisador de espectro ao vivo sobreposto ("Spectrum: Post") — réplica
 * funcional do print de referência "SLOT FX". A curva desenhada vem direto
 * do BiquadFilterNode.getFrequencyResponse (RackEngine), ou seja, é a
 * resposta real que o áudio está recebendo, não uma aproximação visual.
 */
export default function RackEqGraph({
  layerIndex,
  eqEnabled,
  bands,
  onChangeBand,
  onToggleBand,
}: {
  layerIndex: number;
  eqEnabled: boolean;
  bands: RackEqBandSettings[];
  onChangeBand: (bandIndex: number, patch: Partial<RackEqBandSettings>) => void;
  onToggleBand: (bandIndex: number) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [curvePath, setCurvePath] = useState('');
  const [spectrumPath, setSpectrumPath] = useState('');
  const [showSpectrum, setShowSpectrum] = useState(true);
  const dragIndexRef = useRef<number | null>(null);

  useEffect(() => {
    const points = 120;
    const freqs = new Float32Array(points);
    for (let i = 0; i < points; i++) freqs[i] = xToFreq((i / (points - 1)) * W);
    const resp = rackEngine.getEqFrequencyResponseDb(layerIndex, freqs);
    if (!resp) {
      setCurvePath('');
      return;
    }
    let d = '';
    for (let i = 0; i < freqs.length; i++) {
      const x = freqToX(freqs[i]);
      const y = dbToY(Math.max(MIN_DB, Math.min(MAX_DB, resp[i])));
      d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)} `;
    }
    setCurvePath(d);
    // bands/eqEnabled entram só pra recalcular quando o usuário mexe nos controles
    // (o RackEngine já tem o estado real aplicado nos nós no momento do onPatch).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layerIndex, bands, eqEnabled]);

  useEffect(() => {
    if (!showSpectrum) {
      setSpectrumPath('');
      return;
    }
    let raf = 0;
    const points = 130;
    function tick() {
      const data = rackEngine.getEqSpectrumDb(layerIndex);
      if (data && data.length > 0) {
        const sampleRate = rackEngine.getEqSampleRate();
        const binHz = sampleRate / 2 / data.length;
        let d = `M0,${H} `;
        for (let i = 0; i < points; i++) {
          const freq = xToFreq((i / (points - 1)) * W);
          const bin = Math.min(data.length - 1, Math.max(0, Math.round(freq / binHz)));
          const db = data[bin];
          const norm = Math.max(0, Math.min(1, (db + 100) / 100));
          const y = H - norm * H;
          d += `L${freqToX(freq).toFixed(1)},${y.toFixed(1)} `;
        }
        d += `L${W},${H} Z`;
        setSpectrumPath(d);
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [layerIndex, showSpectrum]);

  function clientToLocal(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return { x: ((clientX - rect.left) / rect.width) * W, y: ((clientY - rect.top) / rect.height) * H };
  }

  function handlePointerDown(i: number, e: React.PointerEvent) {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    dragIndexRef.current = i;
  }
  function handlePointerMove(e: React.PointerEvent) {
    const i = dragIndexRef.current;
    if (i === null) return;
    const local = clientToLocal(e.clientX, e.clientY);
    if (!local) return;
    const role = RACK_EQ_BAND_ROLES[i];
    const patch: Partial<RackEqBandSettings> = { freqHz: Math.round(xToFreq(local.x)) };
    if (role !== 'lowcut' && role !== 'highcut') {
      patch.gainDb = Math.round(yToDb(local.y) * 10) / 10;
    }
    onChangeBand(i, patch);
  }
  function handlePointerUp() {
    dragIndexRef.current = null;
  }
  function handleWheel(i: number, e: React.WheelEvent) {
    e.preventDefault();
    const band = bands[i];
    if (!band) return;
    const delta = e.deltaY > 0 ? -0.05 : 0.05;
    onChangeBand(i, { q: Math.max(0.1, Math.min(10, Math.round((band.q + delta) * 100) / 100)) });
  }

  const freqGridLines = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  const dbGridLines = [-18, -12, -6, 0, 6, 12, 18];

  return (
    <div className="rack-eq-graph-wrap">
      <div className="rack-eq-graph-head">
        <span className="rack-eq-graph-title">Equalizador de 6 bandas</span>
        <label className="rack-eq-spectrum-toggle">
          Spectrum
          <select value={showSpectrum ? 'post' : 'off'} onChange={(e) => setShowSpectrum(e.target.value === 'post')}>
            <option value="post">POST</option>
            <option value="off">Desligado</option>
          </select>
        </label>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className={`rack-eq-graph-svg ${eqEnabled ? '' : 'off'}`}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
      >
        {freqGridLines.map((f) => (
          <line key={f} x1={freqToX(f)} x2={freqToX(f)} y1={0} y2={H} className="rack-eq-grid-line" />
        ))}
        {dbGridLines.map((db) => (
          <line key={db} x1={0} x2={W} y1={dbToY(db)} y2={dbToY(db)} className={`rack-eq-grid-line${db === 0 ? ' zero' : ''}`} />
        ))}
        {spectrumPath && <path d={spectrumPath} className="rack-eq-spectrum-fill" />}
        {curvePath && <path d={curvePath} className="rack-eq-curve" fill="none" />}
        {bands.map((band, i) => {
          const role = RACK_EQ_BAND_ROLES[i];
          const isCut = role === 'lowcut' || role === 'highcut';
          const x = freqToX(band.freqHz);
          const y = isCut ? dbToY(0) : dbToY(band.gainDb);
          return (
            <g key={role} opacity={band.enabled ? 1 : 0.35}>
              <circle
                cx={x}
                cy={y}
                r={7}
                className="rack-eq-handle"
                style={{ fill: BAND_COLORS[role] }}
                onPointerDown={(e) => handlePointerDown(i, e)}
                onWheel={(e) => handleWheel(i, e)}
              />
              <text x={x} y={y - 11} className="rack-eq-handle-label">{i + 1}</text>
            </g>
          );
        })}
      </svg>
      <div className="rack-eq-bands-list">
        {bands.map((band, i) => {
          const role = RACK_EQ_BAND_ROLES[i];
          const isCut = role === 'lowcut' || role === 'highcut';
          return (
            <div key={role} className="rack-eq-band-row">
              <button
                type="button"
                className={`rack-eq-band-toggle ${band.enabled ? 'on' : ''}`}
                style={{ borderColor: BAND_COLORS[role] }}
                onClick={() => onToggleBand(i)}
                title={`${i + 1} ${RACK_EQ_BAND_LABELS[role]} — ligar/desligar esta banda`}
              >
                {i + 1}
              </button>
              <span className="rack-eq-band-label">{RACK_EQ_BAND_LABELS[role]}</span>
              <label className="rack-eq-band-field">
                <span>Freq</span>
                <input
                  type="number"
                  min={20}
                  max={20000}
                  value={Math.round(band.freqHz)}
                  onChange={(e) => onChangeBand(i, { freqHz: Number(e.target.value) })}
                />
              </label>
              {!isCut && (
                <label className="rack-eq-band-field">
                  <span>Gain</span>
                  <input
                    type="number"
                    step={0.1}
                    min={-18}
                    max={18}
                    value={band.gainDb}
                    onChange={(e) => onChangeBand(i, { gainDb: Number(e.target.value) })}
                  />
                </label>
              )}
              <label className="rack-eq-band-field">
                <span>Q</span>
                <input
                  type="number"
                  step={0.01}
                  min={0.1}
                  max={10}
                  value={band.q}
                  onChange={(e) => onChangeBand(i, { q: Number(e.target.value) })}
                />
              </label>
            </div>
          );
        })}
      </div>
      <p className="rack-edit-hint">
        Arraste um ponto no gráfico pra mudar frequência (e ganho, exceto nos cortes) · gire o scroll sobre um ponto pra ajustar o Q.
      </p>
    </div>
  );
}
