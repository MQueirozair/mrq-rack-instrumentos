import { useEffect, useRef, useState } from 'react';
import {
  AudioWaveform,
  Check,
  CheckSquare,
  ChevronDown,
  Copy,
  FileText,
  GripVertical,
  Infinity as InfinityIcon,
  LayoutTemplate,
  Magnet,
  Merge,
  Mic,
  Pencil,
  Split,
  Square,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import type { ArrangementStep, PartType, Song, SongPart } from '../../shared/types';
import { PART_COLORS } from '../../shared/types';
import { useStore } from '../state/useStore';

const PART_TYPES = Object.keys(PART_COLORS) as PartType[];
const PICKUP_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: 'não' },
  { value: 1, label: '1 tempo antes' },
  { value: 2, label: '2 tempos antes' },
  { value: 3, label: '3 tempos antes' },
  { value: 4, label: '4 tempos antes' },
  { value: 6, label: '6 tempos antes' },
  { value: 8, label: '8 tempos antes' },
];

/** "12 compassos · 0:24" — ajuda a notar de cara uma parte suspeitamente curta
 *  (provável sobra de uma detecção automática que separou demais). */
function formatPartDuration(startBar: number, endBar: number, bpm: number, timeSigNum: number): string {
  const bars = Math.max(0, endBar - startBar);
  const secPerBar = (60 / Math.max(1, bpm)) * timeSigNum;
  const totalSec = Math.round(bars * secPerBar);
  const mm = Math.floor(totalSec / 60);
  const ss = String(totalSec % 60).padStart(2, '0');
  return `${bars} compasso${bars === 1 ? '' : 's'} · ${mm}:${ss}`;
}

/** Selo de origem da marcação: ajuda a saber rápido quais partes vale a pena
 *  conferir com mais cuidado (as que vieram só da forma de onda) e quais já
 *  foram confirmadas pela própria locução da faixa guia. Ferramenta nova. */
function DetectionBadge({ source }: { source?: SongPart['detectionSource'] }) {
  if (source === 'speech') {
    return (
      <span className="detect-badge speech" title="Reconhecida pela locução da faixa guia — alta confiança">
        <Mic size={11} />
      </span>
    );
  }
  if (source === 'audio') {
    return (
      <span className="detect-badge audio" title="Sugerida só pela forma de onda (sem locução reconhecida) — confira os limites">
        <AudioWaveform size={11} />
      </span>
    );
  }
  return null;
}

/** Monta um texto simples com a ordem das partes, pra colar num grupo de
 *  WhatsApp ou imprimir pra quem não usa o app (ferramenta nova). */
function buildRoteiroText(song: Song, steps: ArrangementStep[], versionName: string): string {
  const lines = [
    `${song.title} — ${versionName}`,
    `Tom: ${song.currentKey} · BPM: ${song.currentBpm} · Compasso: ${song.timeSignatureNum}/${song.timeSignatureDen}`,
    '',
  ];
  let n = 0;
  for (const step of steps) {
    const part = song.parts.find((p) => p.id === step.partId);
    if (!part) continue;
    n += 1;
    const rep = step.repeat === 'infinite' ? ' (repete até sair)' : step.repeat > 1 ? ` (x${step.repeat})` : '';
    lines.push(`${n}. ${part.name}${rep}`);
  }
  return lines.join('\n');
}

function PartEditModal({ song, part, onClose }: { song: Song; part: SongPart; onClose: () => void }) {
  const updatePart = useStore((s) => s.updatePart);
  const pickup = part.pickupBeats ?? 0;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function applyPickup(beats: number) {
    // Reconstrói o compasso "nominal" (desfazendo o deslocamento da anacruse
    // anterior, se houver) e aplica o novo deslocamento a partir dele — assim
    // trocar de opção no dropdown é sempre reversível, nunca acumula erro.
    const prevOffset = (part.pickupBeats ?? 0) / song.timeSignatureNum;
    const nominal = Math.round(part.startBar + prevOffset);
    const startBar = Math.max(1, nominal - beats / song.timeSignatureNum);
    updatePart(part.id, { startBar, pickupBeats: beats });
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="part-edit-modal" onClick={(e) => e.stopPropagation()}>
        <div className="part-edit-head">
          <strong>Parte</strong>
          <button className="icon-btn" onClick={onClose}><X size={16} /></button>
        </div>

        <label className="field-label">Nome</label>
        <input
          className="part-edit-input"
          value={part.name}
          onChange={(e) => updatePart(part.id, { name: e.target.value })}
        />

        <label className="field-label">Tipo</label>
        <select
          className="part-edit-input"
          value={part.type}
          onChange={(e) => {
            const type = e.target.value as PartType;
            updatePart(part.id, { type, color: PART_COLORS[type] });
          }}
        >
          {PART_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>

        <label className="field-label">Entra antes do compasso</label>
        <select className="part-edit-input" value={pickup} onChange={(e) => applyPickup(parseInt(e.target.value, 10))}>
          {PICKUP_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <p className="part-edit-hint">
          Use quando a banda já começa a tocar essa parte um pouco antes da cabeça do compasso marcado (anacruse/levada) —
          o início é ajustado automaticamente pra soar no instante certo.
        </p>

        <div className="part-edit-actions">
          <button className="btn primary" onClick={onClose}>Concluído</button>
        </div>
      </div>
    </div>
  );
}

export default function ArrangeEditor({ song }: { song: Song }) {
  const updatePart = useStore((s) => s.updatePart);
  const deletePart = useStore((s) => s.deletePart);
  const mergePartWithNext = useStore((s) => s.mergePartWithNext);
  const splitPart = useStore((s) => s.splitPart);
  const snapPartToBeat = useStore((s) => s.snapPartToBeat);
  const addArrangement = useStore((s) => s.addArrangement);
  const setActiveArrangement = useStore((s) => s.setActiveArrangement);
  const renameArrangement = useStore((s) => s.renameArrangement);
  const deleteArrangement = useStore((s) => s.deleteArrangement);
  const updateArrangementSteps = useStore((s) => s.updateArrangementSteps);
  const ensureEditableArrangement = useStore((s) => s.ensureEditableArrangement);
  const selectedPartIds = useStore((s) => s.selectedPartIds);
  const togglePartSelection = useStore((s) => s.togglePartSelection);
  const selectAllParts = useStore((s) => s.selectAllParts);
  const clearPartSelection = useStore((s) => s.clearPartSelection);
  const bulkDeleteParts = useStore((s) => s.bulkDeleteParts);
  const bulkSetPartType = useStore((s) => s.bulkSetPartType);
  const templates = useStore((s) => s.library.arrangementTemplates ?? []);
  const saveArrangementTemplate = useStore((s) => s.saveArrangementTemplate);
  const applyArrangementTemplate = useStore((s) => s.applyArrangementTemplate);
  const deleteArrangementTemplate = useStore((s) => s.deleteArrangementTemplate);
  const pushToast = useStore((s) => s.pushToast);

  const [mode, setMode] = useState<'marcar' | 'arranjar'>('marcar');
  const [newArrName, setNewArrName] = useState('');
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [cueEditPartId, setCueEditPartId] = useState<string | null>(null);
  const [editingPartId, setEditingPartId] = useState<string | null>(null);
  const [versionMenuOpen, setVersionMenuOpen] = useState(false);
  const [templateMenuOpen, setTemplateMenuOpen] = useState(false);
  const dragIndex = useRef<number | null>(null);

  const activeArrangement = song.arrangements.find((a) => a.id === song.activeArrangementId) ?? null;
  // Roteiro efetivo: o arranjo ativo, ou — se não houver nenhum — a ordem
  // natural das partes gravadas (1 repetição cada), igual ao que toca ao vivo
  // quando nenhuma versão customizada foi criada ainda.
  const virtualSteps: ArrangementStep[] = song.parts.map((p) => ({ partId: p.id, repeat: 1 }));
  const steps = activeArrangement?.steps ?? virtualSteps;
  const editingPart = editingPartId ? song.parts.find((p) => p.id === editingPartId) ?? null : null;

  /**
   * Aplica uma transformação ao roteiro. Se já existe um arranjo/versão
   * ativo, edita direto nele. Se não existe (estamos olhando a ordem
   * original), pergunta se o usuário quer salvar como uma nova versão antes
   * — exatamente como o Trilha faz quando você mexe pela primeira vez no
   * roteiro de uma música ainda "original".
   */
  function applyStepsEdit(transform: (current: ArrangementStep[]) => ArrangementStep[]) {
    if (activeArrangement) {
      updateArrangementSteps(activeArrangement.id, transform(activeArrangement.steps));
      return;
    }
    const suggested = window.prompt(
      'Você está editando a ordem original da música. Para não alterar os arquivos nem a versão original, isso será salvo como uma NOVA versão. Qual o nome dela?',
      'Minha versão'
    );
    if (!suggested || !suggested.trim()) {
      pushToast('Edição cancelada — crie uma versão para mudar o roteiro.', 'error');
      return;
    }
    const id = ensureEditableArrangement(suggested.trim());
    const created = song.arrangements.find((a) => a.id === id);
    const base = created?.steps ?? virtualSteps;
    updateArrangementSteps(id, transform(base));
  }

  function moveStep(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || to >= steps.length) return;
    applyStepsEdit((current) => {
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
    setSelectedIndex(to);
  }

  function duplicateStep(index: number) {
    applyStepsEdit((current) => {
      const next = [...current];
      next.splice(index + 1, 0, { ...next[index] });
      return next;
    });
  }

  function removeStep(index: number) {
    applyStepsEdit((current) => current.filter((_, i) => i !== index));
    setSelectedIndex(null);
  }

  function setStepRepeat(index: number, repeat: number | 'infinite') {
    applyStepsEdit((current) => {
      const next = [...current];
      next[index] = { ...next[index], repeat };
      return next;
    });
  }

  function addStepToEnd(partId: string) {
    applyStepsEdit((current) => [...current, { partId, repeat: 1 }]);
  }

  async function exportRoteiro() {
    const text = buildRoteiroText(song, steps, activeArrangement?.name ?? 'Original (ordem gravada)');
    try {
      await navigator.clipboard.writeText(text);
      pushToast('Roteiro copiado — cole no grupo da banda (WhatsApp, e-mail etc.).');
    } catch {
      window.prompt('Copie o roteiro abaixo:', text);
    }
  }

  return (
    <div className="card arrange-editor">
      <div className="arrange-mode-toggle">
        <button className={`arrange-mode-btn ${mode === 'marcar' ? 'active' : ''}`} onClick={() => setMode('marcar')}>
          <Pencil size={13} /> Marcar
        </button>
        <button className={`arrange-mode-btn ${mode === 'arranjar' ? 'active' : ''}`} onClick={() => setMode('arranjar')}>
          <GripVertical size={13} /> Arranjar
        </button>
      </div>

      {mode === 'marcar' && (
        <>
          <div className="arrange-section-head">
            <strong className="arrange-section-title">Partes marcadas</strong>
            <span className="arrange-count">{song.parts.length}</span>
            <div className="arrange-spacer" />
            <button
              className="btn ghost"
              onClick={() => (selectedPartIds.length > 0 ? clearPartSelection() : selectAllParts())}
              title="Selecionar várias partes pra excluir ou mudar o tipo de uma vez"
            >
              {selectedPartIds.length > 0 ? <CheckSquare size={14} /> : <Square size={14} />}
              {selectedPartIds.length > 0 ? `${selectedPartIds.length} selecionada(s)` : 'Selecionar várias'}
            </button>
          </div>

          {selectedPartIds.length > 0 && (
            <div className="arrange-bulk-bar">
              <span>{selectedPartIds.length} parte(s) selecionada(s)</span>
              <select
                className="arrange-input-type"
                value=""
                onChange={(e) => {
                  if (!e.target.value) return;
                  bulkSetPartType(selectedPartIds, e.target.value as PartType);
                  e.target.value = '';
                }}
              >
                <option value="">Mudar tipo em lote para…</option>
                {PART_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              <button
                className="btn danger"
                onClick={() => {
                  if (window.confirm(`Excluir ${selectedPartIds.length} parte(s) selecionada(s)? Isso também as remove de qualquer roteiro.`)) {
                    bulkDeleteParts(selectedPartIds);
                  }
                }}
              >
                <Trash2 size={13} /> Excluir selecionadas
              </button>
              <button className="btn ghost" onClick={clearPartSelection}>Cancelar</button>
            </div>
          )}

          <div className="arrange-parts-list">
            {song.parts.map((part, partIndex) => {
              const hasCue = !!part.cueOscAddress || !!part.cueMidiProgram;
              const isShort = part.endBar - part.startBar < 4;
              const isLast = partIndex === song.parts.length - 1;
              const isSelected = selectedPartIds.includes(part.id);
              return (
              <div key={part.id}>
                <div className={`arrange-part-row ${isSelected ? 'selected' : ''}`}>
                  <input
                    type="checkbox"
                    className="arrange-row-checkbox"
                    checked={isSelected}
                    onChange={() => togglePartSelection(part.id)}
                    title="Selecionar pra ação em lote"
                  />
                  <span className="arrange-color-dot" style={{ background: part.color }} />
                  <DetectionBadge source={part.detectionSource} />
                  <input
                    className="arrange-input-name"
                    value={part.name}
                    onChange={(e) => updatePart(part.id, { name: e.target.value })}
                  />
                  <select
                    className="arrange-input-type"
                    value={part.type}
                    onChange={(e) => {
                      const type = e.target.value as PartType;
                      updatePart(part.id, { type, color: PART_COLORS[type] });
                    }}
                  >
                    {PART_TYPES.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                  <label className="arrange-inline-label">de</label>
                  <input
                    type="number"
                    className="arrange-input-bar"
                    value={part.startBar}
                    onChange={(e) => updatePart(part.id, { startBar: parseInt(e.target.value, 10) || 1 })}
                  />
                  <label className="arrange-inline-label">até</label>
                  <input
                    type="number"
                    className="arrange-input-bar"
                    value={part.endBar}
                    onChange={(e) => updatePart(part.id, { endBar: parseInt(e.target.value, 10) || 1 })}
                  />
                  <span className={`arrange-part-duration ${isShort ? 'warn' : ''}`} title={isShort ? 'Parte bem curta — confira se não é sobra de uma detecção automática que separou demais' : undefined}>
                    {formatPartDuration(part.startBar, part.endBar, song.currentBpm, song.timeSignatureNum)}
                    {(part.pickupBeats ?? 0) > 0 ? ` · anacruse ${part.pickupBeats}t` : ''}
                  </span>
                  <div className="arrange-spacer" />
                  <button className="icon-btn" title="Editar parte (nome, tipo, anacruse)" onClick={() => setEditingPartId(part.id)}>
                    <Pencil size={14} />
                  </button>
                  <button
                    className="icon-btn"
                    title="Encaixar esta parte no tempo mais próximo (corrige pequenos erros de arraste)"
                    onClick={() => snapPartToBeat(part.id)}
                  >
                    <Magnet size={14} />
                  </button>
                  <button
                    className="icon-btn"
                    title="Dividir esta parte ao meio"
                    onClick={() => splitPart(part.id)}
                  >
                    <Split size={14} />
                  </button>
                  <button
                    className="icon-btn"
                    title="Mesclar com a próxima parte"
                    disabled={isLast}
                    onClick={() => mergePartWithNext(part.id)}
                  >
                    <Merge size={14} />
                  </button>
                  <button
                    className={`icon-btn ${hasCue ? 'active' : ''}`}
                    title="Cue de palco: dispara OSC/MIDI automaticamente quando esta parte entra (luz, vídeo, console externo)"
                    onClick={() => setCueEditPartId(cueEditPartId === part.id ? null : part.id)}
                  >
                    <Zap size={14} />
                  </button>
                  <button className="btn danger" onClick={() => deletePart(part.id)}>Excluir</button>
                </div>
                {cueEditPartId === part.id && (
                  <div className="arrange-cue-row">
                    <label className="arrange-inline-label">Endereço OSC</label>
                    <input
                      placeholder="/light/scene/3"
                      value={part.cueOscAddress ?? ''}
                      onChange={(e) => updatePart(part.id, { cueOscAddress: e.target.value || null })}
                      style={{ width: 160 }}
                    />
                    <label className="arrange-inline-label">MIDI canal</label>
                    <input
                      type="number"
                      min={0}
                      max={15}
                      style={{ width: 60 }}
                      value={part.cueMidiProgram?.channel ?? ''}
                      placeholder="—"
                      onChange={(e) => {
                        const channel = e.target.value === '' ? null : Math.max(0, Math.min(15, parseInt(e.target.value, 10) || 0));
                        updatePart(part.id, {
                          cueMidiProgram: channel === null ? null : { channel, program: part.cueMidiProgram?.program ?? 0 },
                        });
                      }}
                    />
                    <label className="arrange-inline-label">programa</label>
                    <input
                      type="number"
                      min={0}
                      max={127}
                      style={{ width: 60 }}
                      disabled={!part.cueMidiProgram}
                      value={part.cueMidiProgram?.program ?? ''}
                      placeholder="—"
                      onChange={(e) => {
                        if (!part.cueMidiProgram) return;
                        const program = Math.max(0, Math.min(127, parseInt(e.target.value, 10) || 0));
                        updatePart(part.id, { cueMidiProgram: { ...part.cueMidiProgram, program } });
                      }}
                    />
                    <span className="part-edit-hint" style={{ marginLeft: 8 }}>
                      Disparado automaticamente assim que esta parte fica ativa — ver settings.osc e Ajuda.
                    </span>
                  </div>
                )}
              </div>
              );
            })}
          </div>
        </>
      )}

      {mode === 'arranjar' && (
        <div className="arrange-roteiro-block">
          <div className="arrange-roteiro-head">
            <strong className="arrange-section-title">Roteiro / versão</strong>

            <div className="version-switcher">
              <button className="version-switcher-btn" onClick={() => setVersionMenuOpen((v) => !v)}>
                {activeArrangement?.name ?? 'Original'} <ChevronDown size={13} />
              </button>
              {versionMenuOpen && (
                <div className="version-menu" onMouseLeave={() => setVersionMenuOpen(false)}>
                  <button
                    onClick={() => {
                      const name = window.prompt('Nome da nova versão (a partir da versão atual):', 'Minha versão');
                      if (name && name.trim()) addArrangement(name.trim());
                      setVersionMenuOpen(false);
                    }}
                  >
                    Salvar como nova versão…
                  </button>
                  {activeArrangement && (
                    <button
                      onClick={() => {
                        const name = window.prompt('Renomear versão:', activeArrangement.name);
                        if (name && name.trim()) renameArrangement(activeArrangement.id, name.trim());
                        setVersionMenuOpen(false);
                      }}
                    >
                      Renomear esta versão…
                    </button>
                  )}
                  {activeArrangement && (
                    <button
                      className="version-menu-danger"
                      onClick={() => {
                        if (window.confirm(`Excluir a versão "${activeArrangement.name}"? A música original não é afetada.`)) {
                          deleteArrangement(activeArrangement.id);
                        }
                        setVersionMenuOpen(false);
                      }}
                    >
                      Excluir esta versão
                    </button>
                  )}
                  <div className="version-menu-sep" />
                  <div className="version-menu-label">Versões desta música</div>
                  <button
                    className={!song.activeArrangementId ? 'active' : ''}
                    onClick={() => { setActiveArrangement(null); setVersionMenuOpen(false); }}
                  >
                    {!song.activeArrangementId ? <Check size={12} /> : <span className="version-menu-check-spacer" />} Original (ordem gravada)
                  </button>
                  {song.arrangements.map((a) => (
                    <button
                      key={a.id}
                      className={song.activeArrangementId === a.id ? 'active' : ''}
                      onClick={() => { setActiveArrangement(a.id); setVersionMenuOpen(false); }}
                    >
                      {song.activeArrangementId === a.id ? <Check size={12} /> : <span className="version-menu-check-spacer" />} {a.name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button className="btn ghost" onClick={exportRoteiro} title="Copiar a ordem das partes como texto, pra mandar pra banda">
              <FileText size={13} /> Exportar roteiro
            </button>

            <div className="version-switcher">
              <button className="version-switcher-btn" onClick={() => setTemplateMenuOpen((v) => !v)}>
                <LayoutTemplate size={13} /> Modelos <ChevronDown size={13} />
              </button>
              {templateMenuOpen && (
                <div className="version-menu" onMouseLeave={() => setTemplateMenuOpen(false)}>
                  <button
                    onClick={() => {
                      const name = window.prompt('Nome do modelo (ex.: "Louvor padrão"):', '');
                      if (name && name.trim()) saveArrangementTemplate(name.trim());
                      setTemplateMenuOpen(false);
                    }}
                  >
                    Salvar esta estrutura como modelo…
                  </button>
                  {templates.length > 0 && <div className="version-menu-sep" />}
                  {templates.length > 0 && <div className="version-menu-label">Aplicar modelo (como nova versão)</div>}
                  {templates.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => { applyArrangementTemplate(t.id); setTemplateMenuOpen(false); }}
                    >
                      {t.name} ({t.steps.length} passos)
                      <span
                        className="version-menu-delete"
                        onClick={(e) => { e.stopPropagation(); if (window.confirm(`Excluir o modelo "${t.name}"?`)) deleteArrangementTemplate(t.id); }}
                        title="Excluir modelo"
                      >
                        <X size={12} />
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="arrange-roteiro-new">
            <input
              className="arrange-new-name"
              placeholder="nome da nova versão, ex: Culto curto"
              value={newArrName}
              onChange={(e) => setNewArrName(e.target.value)}
            />
            <button
              className="btn"
              onClick={() => {
                if (!newArrName.trim()) return;
                addArrangement(newArrName.trim());
                setNewArrName('');
              }}
            >
              + Nova versão a partir da atual
            </button>
          </div>

          <span className="arrange-hint">
            Arraste <GripVertical size={10} className="arrange-hint-icon" /> para reordenar · clique numa linha e aperte Delete para remover ·
            {' '}<InfinityIcon size={10} className="arrange-hint-icon" /> repete até você desarmar o loop ao vivo
          </span>

          <div
            className="arrange-steps-list"
            tabIndex={0}
            onKeyDown={(e) => {
              if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIndex !== null) {
                e.preventDefault();
                removeStep(selectedIndex);
              }
            }}
          >
            {steps.map((step, i) => {
              const part = song.parts.find((p) => p.id === step.partId);
              if (!part) return null;
              const isInfinite = step.repeat === 'infinite';
              return (
                <div
                  key={`${step.partId}-${i}`}
                  draggable
                  onDragStart={() => { dragIndex.current = i; }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (dragIndex.current !== null) moveStep(dragIndex.current, i);
                    dragIndex.current = null;
                  }}
                  onClick={() => setSelectedIndex(i)}
                  className={`arrange-step-row${selectedIndex === i ? ' selected' : ''}`}
                  style={{ '--step-color': part.color } as React.CSSProperties}
                >
                  <GripVertical size={14} className="arrange-step-grip" />
                  <span className="arrange-step-index">{i + 1}</span>
                  <span className="arrange-color-dot" style={{ background: part.color }} />
                  <span className="arrange-step-name">{part.name}</span>

                  {isInfinite ? (
                    <button
                      className="btn arrange-infinite-btn"
                      title="Repetindo até desativar — clique para voltar ao normal"
                      onClick={(e) => { e.stopPropagation(); setStepRepeat(i, 1); }}
                    >
                      <InfinityIcon size={13} /> até desativar
                    </button>
                  ) : (
                    <>
                      <label className="arrange-inline-label">repetir</label>
                      <input
                        type="number"
                        min={1}
                        value={step.repeat}
                        className="arrange-input-repeat"
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setStepRepeat(i, Math.max(1, parseInt(e.target.value, 10) || 1))}
                      />
                      <button
                        className="icon-btn"
                        title="Repetir esta parte até eu desativar (loop ao vivo)"
                        onClick={(e) => { e.stopPropagation(); setStepRepeat(i, 'infinite'); }}
                      >
                        <InfinityIcon size={13} />
                      </button>
                    </>
                  )}

                  <button className="icon-btn" disabled={i === 0} onClick={(e) => { e.stopPropagation(); moveStep(i, i - 1); }}>↑</button>
                  <button className="icon-btn" disabled={i === steps.length - 1} onClick={(e) => { e.stopPropagation(); moveStep(i, i + 1); }}>↓</button>
                  <button className="icon-btn" title="Duplicar" onClick={(e) => { e.stopPropagation(); duplicateStep(i); }}>
                    <Copy size={13} />
                  </button>
                  <div className="arrange-spacer" />
                  <button className="btn danger" onClick={(e) => { e.stopPropagation(); removeStep(i); }}>
                    <Trash2 size={13} />
                  </button>
                </div>
              );
            })}
            <select
              className="arrange-add-select"
              value=""
              onChange={(e) => {
                if (!e.target.value) return;
                addStepToEnd(e.target.value);
                e.target.value = '';
              }}
            >
              <option value="">+ mais parte…</option>
              {song.parts.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {editingPart && <PartEditModal song={song} part={editingPart} onClose={() => setEditingPartId(null)} />}
    </div>
  );
}
