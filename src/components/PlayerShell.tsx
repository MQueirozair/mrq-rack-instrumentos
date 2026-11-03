import { useEffect, useMemo, useState } from 'react';
import { Mic, Redo2, Scissors, Undo2 } from 'lucide-react';
import type { PartType, Song } from '../../shared/types';
import { PART_COLORS } from '../../shared/types';
import type { RecognitionSensitivity } from '../audio/PartRecognition';
import { useStore } from '../state/useStore';
import SongHeader from './SongHeader';
import WaveformCanvas from './WaveformCanvas';
import TracksView from './TracksView';
import PartsGrid from './PartsGrid';
import TransportBar from './TransportBar';
import MixerStrip from './MixerStrip';
import ChordView from './ChordView';
import ArrangeEditor from './ArrangeEditor';
import TransitionBanner from './TransitionBanner';
import CountInOverlay from './CountInOverlay';
import { engine } from '../audio/engineInstance';

const PART_TYPES = Object.keys(PART_COLORS) as PartType[];

export default function PlayerShell({ song }: { song: Song }) {
  const nav = useStore((s) => s.nav);
  const engineState = useStore((s) => s.engineState);
  const jumpToPart = useStore((s) => s.jumpToPart);
  const toggleLoopActivePart = useStore((s) => s.toggleLoopActivePart);
  const addPart = useStore((s) => s.addPart);
  const recognizing = useStore((s) => s.recognizing);
  const setPartsFromRecognition = useStore((s) => s.setPartsFromRecognition);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  const play = useStore((s) => s.play);
  const pause = useStore((s) => s.pause);
  const stop = useStore((s) => s.stop);
  const jumpRelative = useStore((s) => s.jumpRelative);
  const deletePartsFromArrangement = useStore((s) => s.deletePartsFromArrangement);

  const [draftRange, setDraftRange] = useState<{ start: number; end: number } | null>(null);
  const [draftName, setDraftName] = useState('Nova parte');
  const [draftType, setDraftType] = useState<PartType>('Verso');
  const [recognitionSensitivity, setRecognitionSensitivity] = useState<RecognitionSensitivity>('normal');

  const isArrange = nav === 'arrange';
  const isChord = nav === 'chord';
  const isTracks = nav === 'tracks';

  // Ctrl+Z / Ctrl+Shift+Z (ou Ctrl+Y) para desfazer/refazer no editor de
  // arranjo — só ativo nessa tela, e ignorado enquanto se digita em um campo.
  useEffect(() => {
    if (!isArrange) return;
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing = target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
      if (typing) return;
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isArrange, undo, redo]);

  // Atalhos de teclado globais de transporte: Espaço (tocar/pausar), setas
  // (parte anterior/próxima), L (loop da parte ativa), Esc (parar). Ficam
  // ativos em qualquer tela (menos enquanto o editor de arranjo está aberto
  // com o foco num campo de texto) — pensado pra operar ao vivo sem precisar
  // alcançar o mouse toda hora.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing = target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      switch (e.key) {
        case ' ':
        case 'Spacebar':
          e.preventDefault();
          if (engine.getState().isPlaying) pause();
          else play();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          jumpRelative(-1);
          break;
        case 'ArrowRight':
          e.preventDefault();
          jumpRelative(1);
          break;
        case 'l':
        case 'L':
          toggleLoopActivePart();
          break;
        case 'Escape':
          stop();
          break;
        default:
          // Dígitos 1 a 9 pulam direto pra N-ésima parte do roteiro (mesma
          // numeração mostrada nos botões da grade de partes), pra trocar de
          // trecho sem precisar olhar pro mouse em apresentações ao vivo.
          if (/^[1-9]$/.test(e.key)) {
            const idx = parseInt(e.key, 10) - 1;
            const part = song.parts[idx];
            if (part) {
              e.preventDefault();
              jumpToPart(part.id);
            }
          }
          break;
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [play, pause, stop, jumpRelative, toggleLoopActivePart, jumpToPart, song.parts]);

  // Trechos da música que ficam dentro da seleção feita arrastando na forma
  // de onda (tela Arranjar) — usado pra oferecer "excluir trecho selecionado"
  // além de "adicionar parte", quando a seleção cobre parte(s) já existentes.
  const overlappingParts = useMemo(() => {
    if (!draftRange) return [];
    return song.parts.filter((p) => p.startBar < draftRange.end && p.endBar > draftRange.start);
  }, [draftRange, song.parts]);

  function seekBar(bar: number) {
    engine.seekToBar(bar);
    const part = song.parts.find((p) => bar >= p.startBar && bar < p.endBar);
    if (part) engine.jumpToPart(part.id, false);
  }

  return (
    <>
      <CountInOverlay engineState={engineState} />
      <SongHeader song={song} />

      {isArrange && (
        <div className="card" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 13 }}>Arranjar partes</strong>
          <span style={{ color: 'var(--text-2)', fontSize: 12 }}>
            Arraste na forma de onda para marcar um trecho novo · clique numa parte na lista abaixo para editar ·
            arraste para reordenar o roteiro · Delete remove o passo selecionado · Ctrl+Z desfaz
          </span>
          <div style={{ flex: 1 }} />
          <button className="icon-btn" disabled={!canUndo} title="Desfazer (Ctrl+Z)" onClick={() => undo()}>
            <Undo2 size={16} />
          </button>
          <button className="icon-btn" disabled={!canRedo} title="Refazer (Ctrl+Shift+Z)" onClick={() => redo()}>
            <Redo2 size={16} />
          </button>
          <select
            className="arrange-input-type"
            style={{ minWidth: 150 }}
            value={recognitionSensitivity}
            disabled={recognizing}
            title="Quantas partes a detecção automática tende a sugerir"
            onChange={(e) => setRecognitionSensitivity(e.target.value as RecognitionSensitivity)}
          >
            <option value="poucas">Sensibilidade: poucas partes</option>
            <option value="normal">Sensibilidade: normal</option>
            <option value="muitas">Sensibilidade: muitas partes</option>
          </select>
          <button className="btn" disabled={recognizing} onClick={() => setPartsFromRecognition(recognitionSensitivity)} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Mic size={14} /> {recognizing ? 'Analisando…' : 'Reconhecer partes (beta)'}
          </button>
        </div>
      )}

      {isChord ? (
        <ChordView song={song} />
      ) : isTracks ? (
        <TracksView song={song} currentBar={engineState.currentBar} onSeekBar={(bar) => seekBar(bar)} />
      ) : (
        <>
          <WaveformCanvas
            song={song}
            currentBar={engineState.currentBar}
            editable={isArrange}
            onSeekBar={(bar) => seekBar(bar)}
            onCreateRange={(start, end) => {
              setDraftRange({ start, end });
            }}
          />

          {draftRange && (
            <div className="card" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <input value={draftName} onChange={(e) => setDraftName(e.target.value)} style={{ width: 160 }} />
              <select value={draftType} onChange={(e) => setDraftType(e.target.value as PartType)}>
                {PART_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              <span style={{ color: 'var(--text-2)', fontSize: 12 }}>
                compassos {draftRange.start}–{draftRange.end}
              </span>
              <div style={{ flex: 1 }} />
              <button
                className="btn primary"
                onClick={() => {
                  addPart({
                    name: draftName,
                    type: draftType,
                    startBar: draftRange.start,
                    endBar: draftRange.end,
                    color: PART_COLORS[draftType],
                  });
                  setDraftRange(null);
                  setDraftName('Nova parte');
                }}
              >
                Adicionar parte
              </button>
              {overlappingParts.length > 0 && (
                <button
                  className="btn danger"
                  title={`Remove ${overlappingParts.map((p) => p.name).join(', ')} do roteiro desta versão (as faixas de áudio não são apagadas)`}
                  onClick={() => {
                    const ok = window.confirm(
                      `Excluir "${overlappingParts.map((p) => p.name).join('", "')}" do roteiro? Isso cria/atualiza uma versão separada do arranjo — a música original continua intacta.`
                    );
                    if (!ok) return;
                    deletePartsFromArrangement(overlappingParts.map((p) => p.id), 'Versão editada');
                    setDraftRange(null);
                  }}
                  style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <Scissors size={14} /> Excluir trecho selecionado
                </button>
              )}
              <button className="btn ghost" onClick={() => setDraftRange(null)}>Cancelar</button>
            </div>
          )}

          {!isArrange && <TransitionBanner song={song} engineState={engineState} />}

          {isArrange ? (
            <ArrangeEditor song={song} />
          ) : (
            <PartsGrid
              song={song}
              activePartId={engineState.activePartId}
              pendingPartId={engineState.pendingPartId}
              loopActive={engineState.loopActivePart}
              onJump={(id) => jumpToPart(id)}
              onToggleLoop={() => toggleLoopActivePart()}
            />
          )}
        </>
      )}

      <TransportBar />
      <MixerStrip song={song} />
    </>
  );
}

