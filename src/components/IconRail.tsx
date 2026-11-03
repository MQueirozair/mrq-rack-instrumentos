import { Library, ListMusic, LayoutGrid, AudioWaveform, Timer, FileText, Volume2, Hash, Mic, Piano, Layers, Replace, Settings, HelpCircle } from 'lucide-react';
import type { NavId } from '../state/useStore';
import { useStore } from '../state/useStore';
import { isTauriRuntime } from '../runtimeEnv';

const ITEMS: { id: NavId; icon: typeof Library; label: string }[] = [
  { id: 'library', icon: Library, label: 'Biblioteca' },
  { id: 'setlist', icon: ListMusic, label: 'Lista' },
  { id: 'arrange', icon: LayoutGrid, label: 'Arranjar' },
  { id: 'tracks', icon: AudioWaveform, label: 'Faixas' },
  { id: 'tempo', icon: Timer, label: 'Tempo' },
  { id: 'chord', icon: FileText, label: 'Cifra' },
  { id: 'outputs', icon: Volume2, label: 'Saídas' },
  { id: 'key', icon: Hash, label: 'Tom' },
  { id: 'guide', icon: Mic, label: 'Voz guia' },
  { id: 'midi', icon: Piano, label: 'MIDI' },
  { id: 'rack', icon: Layers, label: 'Rack de instrumentos' },
];

// O MRQ Instrument Converter (import/exporta `.mrq`) só funciona dentro do
// Tauri — ver tauriBridge.ts/mrqFormat.ts. No build Electron legado esse
// item nem aparece, em vez de mostrar uma página que vai quebrar ao abrir o
// seletor de arquivos (ver InstrumentConverter.tsx e o guard equivalente lá
// como segunda camada de defesa).
const CONVERTER_ITEM: { id: NavId; icon: typeof Library; label: string } = {
  id: 'converter',
  icon: Replace,
  label: 'Conversor de instrumentos (.mrq)',
};


export default function IconRail({ onOpenSettings }: { onOpenSettings: () => void }) {
  const nav = useStore((s) => s.nav);
  const setNav = useStore((s) => s.setNav);
  const items = isTauriRuntime() ? [...ITEMS, CONVERTER_ITEM] : ITEMS;

  return (
    <div className="rail">
      {items.map((item) => (
        <button
          key={item.id}
          className={`rail-btn ${nav === item.id ? 'active' : ''}`}
          title={item.label}
          onClick={() => setNav(item.id)}
        >
          <item.icon size={19} strokeWidth={2} />
        </button>
      ))}
      <div className="rail-spacer" />
      <button
        className={`rail-btn ${nav === 'help' ? 'active' : ''}`}
        title="Ajuda / Sobre o MRQ"
        onClick={() => setNav('help')}
      >
        <HelpCircle size={19} strokeWidth={2} />
      </button>
      <button className="rail-btn" title="Configurações" onClick={onOpenSettings}>
        <Settings size={19} strokeWidth={2} />
      </button>
    </div>
  );
}
