import type { Song } from '../../shared/types';
import { useStore } from '../state/useStore';

export default function GuideVoicePanel({ song }: { song: Song }) {
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const setTrackRole = useStore((s) => s.setTrackRole);

  const guideTrack = song.tracks.find((t) => t.role === 'guide');

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>Voz guia</h3>

      <div className="field-row">
        <div>
          <div className="label">Faixa da guia</div>
          <div className="hint">A voz que anuncia as partes da música.</div>
        </div>
        <select
          value={guideTrack?.id ?? ''}
          onChange={(e) => {
            if (!e.target.value) return;
            song.tracks.forEach((t) => {
              if (t.role === 'guide') setTrackRole(t.id, 'other');
            });
            setTrackRole(e.target.value, 'guide');
          }}
        >
          <option value="">Nenhuma</option>
          {song.tracks.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </div>

      <h4>Ao pedir uma parte fora da ordem</h4>
      {[
        { id: 'keep', t: 'Não mexer', d: 'A guia toca como está gravada.' },
        { id: 'mute', t: 'Calar a guia', d: 'Ela não anuncia a parte errada; volta quando a parte pedida chegar.' },
        { id: 'mute-and-announce', t: 'Calar e anunciar a parte pedida', d: 'A guia fala a parte que você pediu, antes de ela entrar.' },
      ].map((opt) => (
        <label className="radio-row" key={opt.id}>
          <input
            type="radio"
            name="guide-behavior"
            checked={settings.guideVoice.outOfOrderBehavior === opt.id}
            onChange={() => updateSettings({ guideVoice: { ...settings.guideVoice, outOfOrderBehavior: opt.id as any } })}
          />
          <div>
            <div className="t">{opt.t}</div>
            <div className="d">{opt.d}</div>
          </div>
        </label>
      ))}
    </div>
  );
}
