import { Power } from 'lucide-react';
import type { Song } from '../../shared/types';
import { useStore } from '../state/useStore';
import { padEngine } from '../audio/engineInstance';

/**
 * Controle do pad contínuo direto no cabeçalho: ligar/desligar + volume +
 * tom atual. Antes isso só existia como uma ação de MIDI (sem nenhum botão
 * na tela) — ou seja, quem não tivesse um pedal/controlador mapeado não
 * conseguia usar o pad de jeito nenhum.
 */
export default function PadWidget({ song }: { song: Song }) {
  const padActive = useStore((s) => s.padActive);
  const togglePad = useStore((s) => s.togglePad);
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);

  return (
    <div className={`pad-widget ${padActive ? 'on' : ''}`} title="Pad contínuo: toca um tom sustentado pra referência de afinação">
      <button className="pad-widget-toggle" onClick={() => togglePad()}>
        <Power size={13} />
        Pad
      </button>
      {padActive && <span className="pad-widget-key">{song.currentKey}</span>}
      <input
        className="pad-widget-slider"
        type="range" min={-30} max={6} step={1}
        value={settings.pad.volumeDb}
        title="Volume do pad"
        onChange={(e) => {
          const volumeDb = parseFloat(e.target.value);
          updateSettings({ pad: { ...settings.pad, volumeDb } });
          padEngine.setVolumeDb(volumeDb);
        }}
      />
    </div>
  );
}
