import type { ReactNode } from 'react';

/**
 * Moldura visual de um "módulo" de efeito do painel "Editar" de uma camada —
 * pensada pra parecer uma unidade de rack/plugin de DAW de verdade: barra de
 * título com LED de ligado/desligado, parafusos decorativos nos cantos, fileira
 * de knobs embaixo. Usado por todos os efeitos (Envelope, EQ, Drive, Reverb,
 * Compressor, Gate, Phaser, Flanger, Tremolo, Chorus, Bitcrusher, Delay,
 * Shimmer, Oitavador) em vez de repetir a mesma marcação em cada um.
 */
export default function RackFxModule({
  title,
  enabled,
  onToggle,
  accent = '#4fc3dc',
  wide = false,
  extra,
  meter,
  hint,
  children,
}: {
  title: string;
  /** omitido = módulo sem interruptor próprio (ex.: Envelope/Modo de voz, que já têm outro controle de "ligado"). */
  enabled?: boolean;
  onToggle?: (v: boolean) => void;
  accent?: string;
  wide?: boolean;
  /** conteúdo extra entre o cabeçalho e os knobs (ex.: select de tipo/modo). */
  extra?: ReactNode;
  /** medidor (VU/GR) mostrado abaixo dos knobs. */
  meter?: ReactNode;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className={`rack-fx-module ${wide ? 'rack-fx-module-wide' : ''} ${enabled ? 'is-on' : ''}`}>
      <div className="rack-fx-screw rack-fx-screw-tl" />
      <div className="rack-fx-screw rack-fx-screw-tr" />
      <div className="rack-fx-module-header">
        <span className="rack-fx-module-title">{title}</span>
        {onToggle && (
          <button
            type="button"
            className={`rack-fx-led-btn ${enabled ? 'on' : ''}`}
            onClick={() => onToggle(!enabled)}
            title={`${title}: ${enabled ? 'ligado' : 'desligado'}`}
          >
            <span className="rack-fx-led" style={enabled ? { background: accent, boxShadow: `0 0 6px ${accent}` } : undefined} />
            {enabled ? 'ON' : 'OFF'}
          </button>
        )}
      </div>
      {extra && <div className="rack-fx-module-extra">{extra}</div>}
      <div className="rack-fx-knob-row">{children}</div>
      {meter}
      {hint && <div className="rack-edit-hint">{hint}</div>}
      <div className="rack-fx-screw rack-fx-screw-bl" />
      <div className="rack-fx-screw rack-fx-screw-br" />
    </div>
  );
}
