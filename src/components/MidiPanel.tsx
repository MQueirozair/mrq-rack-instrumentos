import { useState } from 'react';
import { PART_COLORS } from '../../shared/types';
import type { MidiBinding, PartType } from '../../shared/types';
import { useStore } from '../state/useStore';
import { armLearn, cancelLearn, isSupported } from '../midi/midiController';

const PART_TYPES = Object.keys(PART_COLORS) as PartType[];

const GLOBAL_ACTIONS: { action: string; label: string }[] = [
  { action: 'transport:play', label: 'Tocar / Pausar' },
  { action: 'transport:stop', label: 'Parar' },
  { action: 'transport:prev', label: 'Parte anterior' },
  { action: 'transport:next', label: 'Próxima parte' },
  { action: 'transport:loop', label: 'Alternar loop da parte' },
  { action: 'pad:toggle', label: 'Pad contínuo: ligar/desligar' },
];

export default function MidiPanel() {
  const settings = useStore((s) => s.settings);
  const addMidiBinding = useStore((s) => s.addMidiBinding);
  const removeMidiBinding = useStore((s) => s.removeMidiBinding);
  const [learningKey, setLearningKey] = useState<string | null>(null);

  function bindingLabel(predicate: (b: MidiBinding) => boolean) {
    const b = settings.midiBindings.find(predicate);
    if (!b) return 'sem tecla';
    return `${b.type === 'note' ? 'Nota' : 'CC'} ${b.number} · ch${b.channel}`;
  }

  function learn(key: string, onLearned: (msg: { type: 'note' | 'cc'; channel: number; number: number }) => void) {
    setLearningKey(key);
    armLearn((msg) => {
      setLearningKey(null);
      onLearned(msg);
    });
  }

  if (!isSupported()) {
    return (
      <div>
        <h3 style={{ marginTop: 0 }}>MIDI</h3>
        <p style={{ color: 'var(--text-2)', fontSize: 13 }}>
          Este navegador/ambiente não expôs a Web MIDI API. Em Windows e Mac, o Electron normalmente suporta —
          confira se o app tem permissão de acesso a dispositivos MIDI.
        </p>
      </div>
    );
  }

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>Teclas por tipo de parte</h3>
      <p className="hint" style={{ color: 'var(--text-2)', fontSize: 12, marginTop: -8 }}>
        Clique num tipo e aperte a tecla do controlador. Em qualquer música, essa tecla vai para a próxima parte
        daquele tipo (ou repete a última, se não houver mais à frente).
      </p>
      <div className="rows-panel">
        {PART_TYPES.map((type) => {
          const key = `partType:${type}`;
          return (
            <div className="row" key={type}>
              <span className="name">
                <span style={{ width: 10, height: 10, borderRadius: 3, background: PART_COLORS[type], display: 'inline-block' }} />
                {type}
              </span>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: 'var(--text-2)' }}>
                  {learningKey === key ? 'aperte uma tecla…' : bindingLabel((b) => b.action === 'partType' && b.partType === type)}
                </span>
                <button
                  className="btn"
                  onClick={() =>
                    learn(key, (msg) => {
                      removeMidiBinding((b) => b.action === 'partType' && b.partType === type);
                      addMidiBinding({ action: 'partType', partType: type, ...msg });
                    })
                  }
                >
                  Aprender
                </button>
                <button className="btn ghost" onClick={() => removeMidiBinding((b) => b.action === 'partType' && b.partType === type)}>
                  Limpar
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <h3>Teclas do pad contínuo</h3>
      <p className="hint" style={{ color: 'var(--text-2)', fontSize: 12, marginTop: -8 }}>
        Clique numa função e aperte a tecla do controlador. Vale com ou sem música aberta.
      </p>
      <div className="rows-panel">
        {GLOBAL_ACTIONS.map(({ action, label }) => (
          <div className="row" key={action}>
            <span className="name">{label}</span>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: 'var(--text-2)' }}>
                {learningKey === action ? 'aperte uma tecla…' : bindingLabel((b) => b.action === action)}
              </span>
              <button
                className="btn"
                onClick={() =>
                  learn(action, (msg) => {
                    removeMidiBinding((b) => b.action === action);
                    addMidiBinding({ action, ...msg });
                  })
                }
              >
                Aprender
              </button>
              <button className="btn ghost" onClick={() => removeMidiBinding((b) => b.action === action)}>
                Limpar
              </button>
            </div>
          </div>
        ))}
      </div>
      {learningKey && (
        <button className="btn danger" onClick={() => { cancelLearn(); setLearningKey(null); }}>
          Cancelar aprendizado
        </button>
      )}
    </div>
  );
}
