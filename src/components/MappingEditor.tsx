/**
 * Editor de Mapeamento — tela de AJUSTES de verdade (edita, não só
 * inspeciona) do MRQ Instrument Converter, no estilo da tela
 * Mapping/Zone de editores de sampler conhecidos (grupos + grade de zonas
 * sobre um teclado + painel da zona selecionada). Abre por um botão a
 * partir de QUALQUER item já inspecionado na fila (todos os formatos
 * aceitos pelo conversor passam por `inspectAny` e chegam aqui com o MESMO
 * `MrqInstrumentModel`, então esta tela nunca precisa saber de qual formato
 * veio o instrumento).
 *
 * O que dá pra editar aqui (tudo metadado do `MrqZone`, nunca os bytes de
 * áudio): tecla raiz, afinação (cents), faixa de tecla, faixa de
 * velocity, volume e pan — por zona. As edições ficam numa cópia local do
 * modelo (nunca mexem no item da fila até clicar em "Salvar edições").
 *
 * HONESTIDADE SOBRE QUANDO AS EDIÇÕES REALMENTE VÃO PRO .mrq FINAL: pra
 * três dos formatos aceitos (.syx DX7, .nki Kontakt, .exs Logic EXS24) a
 * conversão já roda inteiramente no WebView e monta o `MrqInstrumentModel`
 * localmente antes de chamar `mrqBuilderBegin` — pra esses, o modelo
 * editado aqui é usado de verdade na conversão (ver `overrideInstrument`
 * em converterFormats.ts/nkiImport.ts/exsImport.ts/syxImport.ts). Pros
 * demais formatos (SF2/SF3, NPNO/NSMP, WAV/AIFF/FLAC/MP3/OGG) a conversão
 * inteira roda num único comando Rust opaco (`mrq_convert_*_to_mrq`) que
 * reconstrói o modelo do zero a partir do arquivo de origem — ainda não
 * aceita receber de volta um modelo editado. Em vez de fingir que as
 * edições valem pra esses formatos também (o que seria mentir pro
 * usuário), a tela avisa isso claramente no banner do topo e o botão de
 * salvar continua funcionando (guarda as edições pra quando o suporte do
 * backend existir), mas a conversão de hoje usa o mapeamento original
 * nesses casos.
 */
import { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, History, RotateCcw, Save, X } from 'lucide-react';
import type { MrqGroup, MrqInstrumentModel, MrqPreset, MrqZone } from '../audio/rack/mrqFormat';
import { midiNoteName, noteNameToMidi } from '../audio/rack/midiNoteNames';

export interface MappingEditorProps {
  fileName: string;
  formatLabel: string;
  instrument: MrqInstrumentModel;
  canPersist: boolean;
  persistNote: string;
  onClose: () => void;
  onSave: (edited: MrqInstrumentModel) => void;
}

interface ZoneRef {
  key: string;
  presetIdx: number;
  groupIdx: number;
  zoneIdx: number;
  preset: MrqPreset;
  group: MrqGroup;
  zone: MrqZone;
}

function cloneInstrumentModel(instrument: MrqInstrumentModel): MrqInstrumentModel {
  return JSON.parse(JSON.stringify(instrument)) as MrqInstrumentModel;
}

function hashHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}
function groupColor(groupId: string): string {
  return `hsl(${hashHue(groupId)}, 60%, 55%)`;
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

// Teclado de referência (mesmo recorte de 88 teclas já usado no resto do
// app — Rack e Inspetor de Instrumentos) pra alinhar as barras de zona.
const KEY_LO = 21; // A0
const KEY_HI = 108; // C8
const WHITE_W = 13;
const BLACK_W = 8;
const WHITE_H = 46;
const BLACK_H = 29;
function isWhiteKey(note: number): boolean {
  return ![1, 3, 6, 8, 10].includes(((note % 12) + 12) % 12);
}

export default function MappingEditor({ fileName, formatLabel, instrument, canPersist, persistNote, onClose, onSave }: MappingEditorProps) {
  const original = useMemo(() => instrument, [instrument]);
  const [model, setModel] = useState<MrqInstrumentModel>(() => cloneInstrumentModel(instrument));
  const [dirty, setDirty] = useState(false);
  const [presetIdx, setPresetIdx] = useState(0);
  const [groupFilterIdx, setGroupFilterIdx] = useState<number | null>(null);
  const [selectedZoneKey, setSelectedZoneKey] = useState<string | null>(null);
  const [pianoTarget, setPianoTarget] = useState<'root' | 'loKey' | 'hiKey' | null>(null);

  const preset = model.presets[presetIdx] as MrqPreset | undefined;

  const zoneRefs: ZoneRef[] = useMemo(() => {
    if (!preset) return [];
    const out: ZoneRef[] = [];
    preset.groups.forEach((group, groupIdx) => {
      if (groupFilterIdx !== null && groupIdx !== groupFilterIdx) return;
      group.zones.forEach((zone, zoneIdx) => {
        out.push({ key: `${presetIdx}::${groupIdx}::${zoneIdx}`, presetIdx, groupIdx, zoneIdx, preset, group, zone });
      });
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, presetIdx, groupFilterIdx, model]);

  const selected = zoneRefs.find((z) => z.key === selectedZoneKey) ?? null;

  const keyLayout = useMemo(() => {
    let whiteIndex = 0;
    const layout = new Map<number, { x: number; white: boolean }>();
    for (let note = KEY_LO; note <= KEY_HI; note += 1) {
      if (isWhiteKey(note)) {
        layout.set(note, { x: whiteIndex * WHITE_W, white: true });
        whiteIndex += 1;
      } else {
        layout.set(note, { x: whiteIndex * WHITE_W - BLACK_W / 2, white: false });
      }
    }
    return { layout, totalWidth: whiteIndex * WHITE_W };
  }, []);

  function xForNote(note: number): number {
    const clamped = clamp(note, KEY_LO, KEY_HI);
    const entry = keyLayout.layout.get(clamped);
    return entry?.x ?? 0;
  }
  function widthForNote(note: number): number {
    const clamped = clamp(note, KEY_LO, KEY_HI);
    return keyLayout.layout.get(clamped)?.white ? WHITE_W : BLACK_W;
  }

  function mutateZone(ref: ZoneRef, patch: Partial<MrqZone>) {
    setModel((prev) => {
      const next = cloneInstrumentModel(prev);
      const zone = next.presets[ref.presetIdx].groups[ref.groupIdx].zones[ref.zoneIdx];
      Object.assign(zone, patch);
      return next;
    });
    setDirty(true);
  }

  function resetZone(ref: ZoneRef) {
    const originalZone = original.presets[ref.presetIdx]?.groups[ref.groupIdx]?.zones[ref.zoneIdx];
    if (!originalZone) return;
    mutateZone(ref, { ...originalZone });
  }

  function resetAll() {
    setModel(cloneInstrumentModel(original));
    setDirty(false);
  }

  function handlePianoClick(note: number) {
    if (!selected || !pianoTarget) return;
    if (pianoTarget === 'root') mutateZone(selected, { rootNote: clamp(note, 0, 127) });
    else if (pianoTarget === 'loKey') {
      const hi = selected.zone.hiKey;
      mutateZone(selected, { loKey: Math.min(note, hi), hiKey: Math.max(note, hi) });
    } else if (pianoTarget === 'hiKey') {
      const lo = selected.zone.loKey;
      mutateZone(selected, { hiKey: Math.max(note, lo), loKey: Math.min(note, lo) });
    }
  }

  return (
    <div className="mapping-editor-overlay">
      <div className="mapping-editor-panel">
        <div className="mapping-editor-header">
          <div className="mapping-editor-title">
            <h3>Editor de Mapeamento</h3>
            <span className="mapping-editor-filename">{fileName}</span>
            <span className="mapping-editor-format-badge">{formatLabel}</span>
          </div>
          <div className="mapping-editor-header-actions">
            <button className="btn ghost small" onClick={resetAll} disabled={!dirty} title="Descartar todas as edições e voltar ao mapeamento original">
              <RotateCcw size={13} /> Reverter tudo
            </button>
            <button
              className="btn primary small"
              onClick={() => {
                onSave(model);
                setDirty(false);
              }}
            >
              <Save size={13} /> Salvar edições
            </button>
            <button className="mapping-editor-close" onClick={onClose} title="Fechar">
              <X size={18} />
            </button>
          </div>
        </div>

        <div className={`mapping-editor-persist-banner ${canPersist ? 'ok' : 'warn'}`}>{persistNote}</div>

        {model.presets.length > 1 && (
          <div className="mapping-editor-preset-row">
            <label>Preset</label>
            <select
              value={presetIdx}
              onChange={(e) => {
                setPresetIdx(Number(e.target.value));
                setGroupFilterIdx(null);
                setSelectedZoneKey(null);
              }}
            >
              {model.presets.map((p, i) => (
                <option key={p.id} value={i}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="mapping-editor-body">
          <div className="mapping-editor-groups">
            <h4>Grupos</h4>
            <button
              className={`mapping-editor-group-row ${groupFilterIdx === null ? 'active' : ''}`}
              onClick={() => setGroupFilterIdx(null)}
            >
              Todos os grupos
            </button>
            {preset?.groups.map((g, i) => (
              <button
                key={g.id}
                className={`mapping-editor-group-row ${groupFilterIdx === i ? 'active' : ''}`}
                onClick={() => setGroupFilterIdx((prev) => (prev === i ? null : i))}
              >
                <span className="mrq-swatch" style={{ background: groupColor(g.id) }} />
                {g.name} <span className="mapping-editor-group-count">({g.zones.length})</span>
              </button>
            ))}
          </div>

          <div className="mapping-editor-grid-area">
            <div className="mapping-editor-grid-legend">
              <div className="mapping-editor-grid-legend-spacer" />
              {zoneRefs.map((ref, i) => (
                <button
                  key={ref.key}
                  className={`mapping-editor-zone-legend ${selected?.key === ref.key ? 'selected' : ''}`}
                  onClick={() => setSelectedZoneKey(ref.key)}
                >
                  <span className="mrq-swatch" style={{ background: groupColor(ref.group.id) }} />
                  Zona {i + 1}
                </button>
              ))}
              {zoneRefs.length === 0 && <p className="mrq-tab-hint">Nenhuma zona neste grupo.</p>}
            </div>
            <div className="mapping-editor-grid-scroll">
              <div className="mapping-editor-grid-inner" style={{ width: keyLayout.totalWidth + 2 }}>
                <div className="mapping-editor-bars">
                  {zoneRefs.map((ref) => {
                    const left = xForNote(ref.zone.loKey);
                    const right = xForNote(ref.zone.hiKey) + widthForNote(ref.zone.hiKey);
                    return (
                      <div key={ref.key} className="mapping-editor-bar-row">
                        <div
                          className={`mapping-editor-bar ${selected?.key === ref.key ? 'selected' : ''}`}
                          style={{ left, width: Math.max(4, right - left), background: groupColor(ref.group.id) }}
                          onClick={() => setSelectedZoneKey(ref.key)}
                          title={`Zona: tecla ${midiNoteName(ref.zone.loKey)}–${midiNoteName(ref.zone.hiKey)}, raiz ${midiNoteName(ref.zone.rootNote)}`}
                        >
                          <span
                            className="mapping-editor-bar-root"
                            style={{ left: Math.max(0, xForNote(ref.zone.rootNote) - left) }}
                            title={`Raiz: ${midiNoteName(ref.zone.rootNote)}`}
                          />
                        </div>
                      </div>
                    );
                  })}
                  {zoneRefs.length === 0 && <div className="mapping-editor-bar-row empty" />}
                </div>
                <svg width={keyLayout.totalWidth + 2} height={WHITE_H + 1} className="mapping-editor-piano">
                  {[...keyLayout.layout.entries()]
                    .filter(([, v]) => v.white)
                    .map(([note, v]) => (
                      <g key={note} onClick={() => handlePianoClick(note)} className={pianoTarget ? 'mapping-piano-hit active' : 'mapping-piano-hit'}>
                        <rect x={v.x} y={0} width={WHITE_W - 1} height={WHITE_H} fill="var(--bg-2)" stroke="var(--border)" />
                        {note % 12 === 0 && (
                          <text x={v.x + 2} y={WHITE_H - 3} fontSize={7} fill="var(--text-2)">
                            {midiNoteName(note)}
                          </text>
                        )}
                      </g>
                    ))}
                  {[...keyLayout.layout.entries()]
                    .filter(([, v]) => !v.white)
                    .map(([note, v]) => (
                      <g key={note} onClick={() => handlePianoClick(note)} className={pianoTarget ? 'mapping-piano-hit active' : 'mapping-piano-hit'}>
                        <rect x={v.x} y={0} width={BLACK_W} height={BLACK_H} fill="#0a0a0c" stroke="#000" />
                      </g>
                    ))}
                </svg>
              </div>
            </div>
          </div>
        </div>

        <div className="mapping-editor-zone-panel">
          {!selected ? (
            <p className="mrq-tab-hint">Selecione uma zona na grade acima (ou numa das barras) pra editar tecla raiz, afinação, faixas e volume/pan.</p>
          ) : (
            <ZoneEditForm selected={selected} onChange={(patch) => mutateZone(selected, patch)} onReset={() => resetZone(selected)} pianoTarget={pianoTarget} setPianoTarget={setPianoTarget} />
          )}
        </div>
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  suffix,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  suffix?: string;
}) {
  return (
    <div className="mapping-editor-field">
      <label>{label}</label>
      <div className="mapping-editor-field-input">
        <input
          type="number"
          value={Number.isFinite(value) ? value : 0}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)));
          }}
        />
        {suffix && <span className="mapping-editor-field-suffix">{suffix}</span>}
      </div>
    </div>
  );
}

function ZoneEditForm({
  selected,
  onChange,
  onReset,
  pianoTarget,
  setPianoTarget,
}: {
  selected: ZoneRef;
  onChange: (patch: Partial<MrqZone>) => void;
  onReset: () => void;
  pianoTarget: 'root' | 'loKey' | 'hiKey' | null;
  setPianoTarget: (v: 'root' | 'loKey' | 'hiKey' | null) => void;
}) {
  const { zone, group, preset } = selected;
  return (
    <div className="mapping-editor-zone-form">
      <div className="mapping-editor-zone-form-header">
        <span>
          {preset.name} / {group.name} · amostra <code>{zone.sampleId}</code>
        </span>
        <div className="mapping-editor-piano-target">
          <span>Clique no teclado define:</span>
          {(['root', 'loKey', 'hiKey'] as const).map((t) => (
            <button
              key={t}
              className={`btn ghost small ${pianoTarget === t ? 'on' : ''}`}
              onClick={() => setPianoTarget(pianoTarget === t ? null : t)}
            >
              {t === 'root' ? 'Nota raiz' : t === 'loKey' ? 'Tecla grave' : 'Tecla aguda'}
            </button>
          ))}
        </div>
        <button className="btn ghost small" onClick={onReset} title="Restaurar esta zona pro valor original">
          <History size={12} /> Restaurar zona
        </button>
      </div>
      <div className="mapping-editor-zone-form-grid">
        <NumberField label={`Nota raiz (${midiNoteName(zone.rootNote)})`} value={zone.rootNote} min={0} max={127} onChange={(v) => onChange({ rootNote: v })} />
        <NumberField label="Afinação" value={zone.tuneCents} min={-2400} max={2400} onChange={(v) => onChange({ tuneCents: v })} suffix="cents" />
        <NumberField label={`Tecla grave (${midiNoteName(zone.loKey)})`} value={zone.loKey} min={0} max={zone.hiKey} onChange={(v) => onChange({ loKey: v })} />
        <NumberField label={`Tecla aguda (${midiNoteName(zone.hiKey)})`} value={zone.hiKey} min={zone.loKey} max={127} onChange={(v) => onChange({ hiKey: v })} />
        <NumberField label="Velocity mínima" value={zone.loVel} min={0} max={zone.hiVel} onChange={(v) => onChange({ loVel: v })} />
        <NumberField label="Velocity máxima" value={zone.hiVel} min={zone.loVel} max={127} onChange={(v) => onChange({ hiVel: v })} />
        <NumberField label="Volume" value={zone.volumeDb} min={-96} max={12} step={0.1} onChange={(v) => onChange({ volumeDb: v })} suffix="dB" />
        <NumberField label="Pan" value={zone.pan} min={-1} max={1} step={0.01} onChange={(v) => onChange({ pan: v })} suffix="(-1 esq · +1 dir)" />
      </div>
    </div>
  );
}

/** Converte um nome de nota digitado (ex.: "C3") num número MIDI, usado só
 *  como utilitário pra outros pontos desta tela que queiram aceitar texto
 *  em vez de número — hoje os campos usam `<input type="number">` puro,
 *  mas a função fica exportada pronta pra uma eventual troca pra um campo
 *  de texto com nome de nota. */
export function parseNoteFieldInput(raw: string): number | null {
  return noteNameToMidi(raw);
}
