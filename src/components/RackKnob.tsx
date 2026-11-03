import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Knob giratório estilo "hardware" (plugin de DAW/rack físico) — arraste pra
 * cima/baixo pra mudar o valor (como um knob de verdade respondendo ao
 * movimento vertical do mouse, não ao giro visual), duplo-clique reseta pro
 * `defaultValue`, scroll do mouse faz ajuste fino. Usado em todos os módulos
 * de efeito do painel "Editar" de uma camada (ver InstrumentRack.tsx) no
 * lugar dos antigos <input type="range"> simples.
 */
export default function RackKnob({
  label,
  value,
  min,
  max,
  step = 0.001,
  defaultValue,
  unit = '',
  format,
  onChange,
  size = 'md',
  accent = '#4fc3dc',
  disabled = false,
  bipolar = false,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** valor restaurado com duplo-clique — se omitido, usa `min`. */
  defaultValue?: number;
  unit?: string;
  /** formata o valor exibido abaixo do knob; por padrão mostra `value` arredondado + unidade. */
  format?: (v: number) => string;
  onChange: (v: number) => void;
  size?: 'sm' | 'md';
  /** cor de destaque do ponteiro/arco de valor (combina com a cor da camada ou do módulo). */
  accent?: string;
  disabled?: boolean;
  /** true = o "zero" fica no meio do arco (ex.: pan, feedback com polaridade) em vez de no início. */
  bipolar?: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startY: number; startValue: number } | null>(null);
  const px = size === 'sm' ? 36 : 46;

  const clamp = useCallback((v: number) => Math.min(max, Math.max(min, v)), [min, max]);

  // Guarda sempre a versão mais recente de min/max/step/onChange numa ref —
  // ATUALIZADA EM TODO RENDER (sem lista de dependências), mas LIDA só dentro
  // dos listeners de pointermove/pointerup abaixo. Isso existe por causa de um
  // bug real encontrado: como `onChange` normalmente é uma arrow function
  // nova a cada render do componente-pai, o antigo `onPointerMove` (um
  // useCallback com `onChange` na lista de dependências) trocava de
  // identidade assim que o PRIMEIRO pointermove do arraste disparava
  // onChange() (-> re-render do pai -> nova função). O useEffect de limpeza
  // (que reagia a essa troca de identidade) então removia do `window` o
  // listener registrado em startDrag — mas nada o registrava de novo — e o
  // knob parava de responder depois de mover só 1 pixel, pro resto daquele
  // arraste (só "destravava" num novo mousedown). Lendo tudo de uma ref
  // estável em vez de depender da identidade do callback, onPointerMove e
  // stopDrag agora NUNCA trocam de identidade, então os listeners registrados
  // em startDrag sobrevivem ao arraste inteiro até o pointerup de verdade.
  const liveRef = useRef({ min, max, step, onChange });
  useEffect(() => {
    liveRef.current = { min, max, step, onChange };
  });

  const onPointerMove = useCallback((e: PointerEvent) => {
    if (!dragRef.current) return;
    const { min, max, step, onChange } = liveRef.current;
    const dy = dragRef.current.startY - e.clientY;
    // ~140px de arrasto cobre a faixa inteira — sensibilidade parecida com knobs de plugin de verdade
    const range = max - min;
    const clampLive = (v: number) => Math.min(max, Math.max(min, v));
    const next = clampLive(dragRef.current.startValue + (dy / 140) * range);
    const snapped = step > 0 ? Math.round(next / step) * step : next;
    onChange(clampLive(snapped));
  }, []);

  const stopDrag = useCallback(() => {
    dragRef.current = null;
    setDragging(false);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', stopDrag);
  }, [onPointerMove]);

  function startDrag(e: React.PointerEvent) {
    if (disabled) return;
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startValue: value };
    setDragging(true);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stopDrag);
  }

  useEffect(() => {
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stopDrag);
    };
  }, [onPointerMove, stopDrag]);

  function onWheel(e: React.WheelEvent) {
    if (disabled) return;
    e.preventDefault();
    const delta = (e.deltaY < 0 ? 1 : -1) * Math.max(step, (max - min) / 200);
    onChange(clamp(value + delta));
  }

  function onDoubleClick() {
    if (disabled) return;
    onChange(clamp(defaultValue ?? min));
  }

  const fraction = clamp(value - min) / (max - min || 1);
  // arco de -135° a +135° (270° de curso), igual à maioria dos knobs de plugin
  const angle = -135 + fraction * 270;
  const zeroFraction = bipolar ? clamp((defaultValue ?? (min + max) / 2) - min) / (max - min || 1) : 0;
  const zeroAngle = -135 + zeroFraction * 270;
  const displayValue = format ? format(value) : `${Math.round(value * 100) / 100}${unit}`;

  // arco SVG do valor atual (do zero/início até o ponteiro)
  const r = px / 2 - 4;
  const cx = px / 2;
  const cy = px / 2;
  function polar(deg: number) {
    const rad = (deg - 90) * (Math.PI / 180);
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }
  const startA = bipolar ? zeroAngle : -135;
  const p0 = polar(startA);
  const p1 = polar(angle);
  const largeArc = Math.abs(angle - startA) > 180 ? 1 : 0;
  const sweep = angle > startA ? 1 : 0;

  return (
    <div
      className={`rack-knob ${disabled ? 'disabled' : ''} ${dragging ? 'dragging' : ''}`}
      // Os handlers de interação ficam aqui, no <div> que envolve o <svg> —
      // não no próprio <svg> — porque o Chrome resolve hit-test de ponteiro
      // sobre conteúdo SVG aninhado (que forma seu próprio contexto de
      // empilhamento) de volta pro elemento HTML "hospedeiro" mais próximo
      // nesse cenário específico; um onPointerDown/onWheel/onDoubleClick
      // colocado diretamente no <svg> simplesmente não dispara de forma
      // confiável (testado e confirmado: o evento nativo chega aqui no div,
      // não no svg, mesmo clicando bem no centro do desenho).
      onPointerDown={startDrag}
      onWheel={onWheel}
      onDoubleClick={onDoubleClick}
      role="slider"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
    >
      <svg width={px} height={px} viewBox={`0 0 ${px} ${px}`} className="rack-knob-dial" aria-hidden="true">
        <circle cx={cx} cy={cy} r={r} className="rack-knob-track" />
        <path
          d={`M ${p0.x} ${p0.y} A ${r} ${r} 0 ${largeArc} ${sweep} ${p1.x} ${p1.y}`}
          className="rack-knob-arc"
          style={{ stroke: accent }}
        />
        <circle cx={cx} cy={cy} r={r * 0.62} className="rack-knob-body" />
        <line
          x1={cx}
          y1={cy}
          x2={cx + r * 0.52 * Math.sin((angle * Math.PI) / 180)}
          y2={cy - r * 0.52 * Math.cos((angle * Math.PI) / 180)}
          className="rack-knob-pointer"
          style={{ stroke: accent }}
        />
      </svg>
      <div className="rack-knob-value">{displayValue}</div>
      <div className="rack-knob-label">{label}</div>
    </div>
  );
}
