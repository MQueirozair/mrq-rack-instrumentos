/**
 * "Kontakt Audio Capture" — modal do MRQ Instrument Converter (não é um
 * segundo conversor: reaproveita o MESMO pipeline `.mrq`/`MrqInstrumentModel`
 * de todo o resto do conversor, ver src/audio/rack/kontaktCapture.ts).
 *
 * Fluxo: o usuário escolhe arquivos WAV/AIFF/FLAC já RENDERIZADOS pelo
 * Kontakt (instrumento ao qual ele tem acesso legítimo), a tela tenta
 * detectar nota/velocidade pelo NOME do arquivo (heurística best-effort,
 * nunca um "palpite" escondido — tudo que não é detectado fica com valor
 * padrão explícito e editável), o usuário confere/ajusta o mapeamento numa
 * grade, audiciona cada amostra, e ao confirmar o instrumento é montado e
 * gravado como `.mrq` pelo mesmo pipeline genérico (`runKontaktCapture` →
 * `mrqBuilderBegin`/`mrqCaptureAddSample`/`mrqBuilderFinish`, Rust decodifica
 * cada arquivo por caminho — nenhum áudio grande atravessa a ponte do
 * WebView como JSON).
 *
 * Transparência (exigência do usuário): o aviso fixo no topo e o relatório
 * de compatibilidade gerado deixam explícito que isto é áudio renderizado,
 * não a estrutura interna do instrumento Kontakt original — scripts KSP,
 * efeitos/modulações e pontos de loop não são e não podem ser recuperados
 * a partir do áudio.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { AlertTriangle, FolderOpen, Loader2, Pause, Play, Save, Trash2, Upload, X } from 'lucide-react';
import { basenameOf } from '../audio/rack/converterFormats';
import { midiNoteLabel } from '../audio/rack/midiNoteNames';
import { mrqReadMetadata, type MrqCompatibilityReport, type MrqFileMetadata, type MrqFinishResult, type MrqInstrumentModel } from '../audio/rack/mrqFormat';
import {
  buildCaptureInstrumentModel,
  computeAutoKeyRanges,
  computeAutoVelocityAndRoundRobin,
  findDuplicateGroups,
  mrqCaptureProbeAudioFile,
  parseCapturedFileName,
  runKontaktCapture,
  type CaptureFileProbe,
  type CaptureSampleTask,
  type CaptureZoneInput,
} from '../audio/rack/kontaktCapture';
import { useStore } from '../state/useStore';

const AUDIO_EXTENSIONS = ['wav', 'wave', 'aiff', 'aif', 'aifc', 'flac', 'mp3', 'ogg'];
const DEFAULT_ROOT_NOTE = 60; // C3 — mesma convenção padrão do resto do conversor.

export interface KontaktCaptureResult {
  fileName: string;
  instrument: MrqInstrumentModel;
  compatibility: MrqCompatibilityReport;
  convertedPath: string;
  convertedFinish: MrqFinishResult;
  convertedMetadata: MrqFileMetadata;
}

interface CaptureRow {
  id: string;
  path: string;
  fileName: string;
  group: string;
  rootNote: number;
  loKey: number;
  hiKey: number;
  loVel: number;
  hiVel: number;
  roundRobinGroup: string;
  roundRobinIndex: string;
  exclusiveGroup: string;
  rootNoteAuto: boolean;
  velocityAuto: boolean;
  /** Velocidade detectada pelo nome do arquivo (ou null) — mantida à parte
   *  de `loVel`/`hiVel` só pra alimentar "Aplicar mapeamento automático"
   *  mesmo depois que o usuário já tiver ajustado a faixa manualmente. */
  detectedVelocity: number | null;
  probe: CaptureFileProbe | null;
  probeError: string | null;
  probing: boolean;
  fileUrl: string | null;
}

let idCounter = 0;
function makeRowId(): string {
  idCounter += 1;
  return `kc-${Date.now().toString(36)}-${idCounter}`;
}

function titleCaseArticulation(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return m > 0 ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${s.toFixed(2)}s`;
}

export default function KontaktCaptureDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (result: KontaktCaptureResult) => void;
}) {
  const [instrumentName, setInstrumentName] = useState('Instrumento Capturado');
  const [rows, setRows] = useState<CaptureRow[]>([]);
  const [building, setBuilding] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const pushToast = useStore((s) => s.pushToast);

  useEffect(() => {
    return () => {
      audioElRef.current?.pause();
    };
  }, []);

  const duplicateGroups = useMemo(() => {
    const entries = rows.filter((r) => r.probe).map((r) => ({ id: r.id, hash: r.probe!.contentSha256 }));
    return findDuplicateGroups(entries);
  }, [rows]);
  const duplicateRowIds = useMemo(() => new Set(duplicateGroups.flat()), [duplicateGroups]);

  function updateRow(id: string, patch: Partial<CaptureRow>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  async function addPaths(paths: string[]) {
    if (paths.length === 0) return;
    const newRows: CaptureRow[] = paths.map((path) => {
      const fileName = basenameOf(path);
      const hints = parseCapturedFileName(fileName);
      const rootNote = hints.rootNote ?? DEFAULT_ROOT_NOTE;
      const group = hints.articulation ? titleCaseArticulation(hints.articulation) : 'Camada 1';
      return {
        id: makeRowId(),
        path,
        fileName,
        group,
        rootNote,
        loKey: hints.rootNote !== null ? hints.rootNote : 0,
        hiKey: hints.rootNote !== null ? hints.rootNote : 127,
        loVel: 0,
        hiVel: 127,
        roundRobinGroup: '',
        roundRobinIndex: '',
        exclusiveGroup: '',
        rootNoteAuto: hints.rootNote !== null,
        velocityAuto: hints.velocity !== null,
        detectedVelocity: hints.velocity,
        probe: null,
        probeError: null,
        probing: true,
        fileUrl: null,
      };
    });
    setRows((prev) => [...prev, ...newRows]);
    for (const row of newRows) {
      void (async () => {
        try {
          const [probe, fileUrl] = await Promise.all([mrqCaptureProbeAudioFile(row.path), window.api.fs.toFileUrl(row.path)]);
          updateRow(row.id, { probe, fileUrl, probing: false });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          updateRow(row.id, { probeError: message, probing: false });
        }
      })();
    }
  }

  async function pickFiles() {
    try {
      const result = await openDialog({
        multiple: true,
        title: 'Escolher amostras renderizadas pelo Kontakt',
        filters: [{ name: 'Áudio', extensions: AUDIO_EXTENSIONS }, { name: 'Todos os arquivos', extensions: ['*'] }],
      });
      if (!result) return;
      await addPaths(Array.isArray(result) ? result : [result]);
    } catch (err) {
      pushToast('Não foi possível abrir o seletor de arquivos.', 'error');
    }
  }

  async function pickFolder() {
    try {
      const result = await openDialog({ directory: true, multiple: false, title: 'Escolher pasta com amostras renderizadas' });
      if (!result || Array.isArray(result)) return;
      const tracks = await window.api.fs.scanFolderTracks(result);
      if (tracks.length === 0) {
        pushToast('Nenhum arquivo de áudio encontrado nessa pasta.', 'error');
        return;
      }
      await addPaths(tracks.map((t) => t.filePath));
    } catch (err) {
      pushToast('Não foi possível ler a pasta escolhida.', 'error');
    }
  }

  function removeRow(id: string) {
    if (playingId === id) {
      audioElRef.current?.pause();
      setPlayingId(null);
    }
    setRows((prev) => prev.filter((r) => r.id !== id));
  }

  function togglePlay(row: CaptureRow) {
    if (!row.fileUrl) return;
    if (playingId === row.id) {
      audioElRef.current?.pause();
      setPlayingId(null);
      return;
    }
    if (!audioElRef.current) audioElRef.current = new Audio();
    const audio = audioElRef.current;
    audio.pause();
    audio.src = row.fileUrl;
    audio.onended = () => setPlayingId(null);
    audio.play().catch(() => setPlayingId(null));
    setPlayingId(row.id);
  }

  function applyAutoMapping() {
    const keyResult = computeAutoKeyRanges(rows.map((r) => ({ id: r.id, group: r.group || 'Camada 1', rootNote: r.rootNote })));
    const velResult = computeAutoVelocityAndRoundRobin(
      rows.map((r) => ({ id: r.id, group: r.group || 'Camada 1', rootNote: r.rootNote, velocity: r.detectedVelocity }))
    );
    setRows((prev) =>
      prev.map((r) => {
        const k = keyResult.get(r.id);
        const v = velResult.get(r.id);
        return {
          ...r,
          loKey: k ? k.loKey : r.loKey,
          hiKey: k ? k.hiKey : r.hiKey,
          loVel: v ? v.loVel : r.loVel,
          hiVel: v ? v.hiVel : r.hiVel,
          roundRobinGroup: v?.roundRobinGroup ?? '',
          roundRobinIndex: v?.roundRobinIndex !== undefined ? String(v.roundRobinIndex) : '',
        };
      })
    );
    pushToast('Faixas de tecla/velocidade recalculadas a partir das notas raiz e velocidades detectadas/definidas.');
  }

  async function handleConfirm() {
    setError(null);
    if (rows.length === 0) {
      setError('Adicione pelo menos um arquivo de áudio antes de gerar o instrumento.');
      return;
    }
    if (rows.some((r) => r.probing)) {
      setError('Aguarde a análise de todos os arquivos terminar.');
      return;
    }
    if (rows.some((r) => r.probeError)) {
      setError('Remova ou corrija os arquivos com erro de leitura antes de continuar.');
      return;
    }
    const suggestedName = (instrumentName.trim() || 'Instrumento Capturado').replace(/[\\/:*?"<>|]/g, '_');
    let destPath: string | null = null;
    try {
      destPath = await saveDialog({
        title: 'Salvar instrumento MRQ',
        defaultPath: `${suggestedName}.mrq`,
        filters: [{ name: 'MRQ Instrument (.mrq)', extensions: ['mrq'] }],
      });
    } catch {
      pushToast('Não foi possível abrir o seletor de destino.', 'error');
      return;
    }
    if (!destPath) return;

    setBuilding(true);
    setProgress(null);
    try {
      const zones: CaptureZoneInput[] = rows.map((r) => ({
        sampleId: r.id,
        group: r.group.trim() || 'Camada 1',
        rootNote: r.rootNote,
        loKey: r.loKey,
        hiKey: r.hiKey,
        loVel: r.loVel,
        hiVel: r.hiVel,
        roundRobinGroup: r.roundRobinGroup.trim() || undefined,
        roundRobinIndex: r.roundRobinIndex.trim() !== '' ? Number(r.roundRobinIndex) : undefined,
        exclusiveGroup: r.exclusiveGroup.trim() !== '' ? Number(r.exclusiveGroup) : undefined,
        stereo: r.probe ? (r.probe.channels >= 2 ? 'stereo' : 'mono') : undefined,
      }));
      const { instrument, compatibility } = buildCaptureInstrumentModel(instrumentName.trim() || 'Instrumento Capturado', zones);
      const tasks: CaptureSampleTask[] = rows.map((r) => ({ sampleId: r.id, path: r.path }));
      const { finish } = await runKontaktCapture(destPath, instrument, tasks, (done, total) => setProgress({ done, total }));
      const metadata = await mrqReadMetadata(destPath);
      pushToast(`Instrumento "${instrumentName}" gerado a partir de ${rows.length} amostra(s).`);
      onImported({
        fileName: basenameOf(destPath),
        instrument,
        compatibility,
        convertedPath: destPath,
        convertedFinish: finish,
        convertedMetadata: metadata,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      pushToast(`Falha ao gerar o instrumento: ${message}`, 'error');
    } finally {
      setBuilding(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={building ? undefined : onClose}>
      <div className="modal wide kc-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Importar instrumento renderizado pelo Kontakt</h2>
          <button className="icon-btn" onClick={onClose} disabled={building}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <div className="kc-disclaimer">
            <AlertTriangle size={15} />
            <span>
              Este fluxo captura só o <strong>áudio já renderizado</strong> pelo Kontakt (arquivos WAV/AIFF/FLAC exportados a partir de um
              instrumento ao qual você tem acesso legítimo) — não abre, converte nem decodifica o arquivo <code>.nki</code> original. Scripts
              KSP, efeitos/modulações proprietários e a estrutura interna de grupos/articulações do instrumento original{' '}
              <strong>não são e não podem ser recuperados</strong> a partir do áudio. A qualidade do resultado depende inteiramente de quais
              notas/velocidades/articulações foram renderizadas.
            </span>
          </div>

          <div className="kc-toolbar">
            <div className="kc-name-input">
              <input
                type="text"
                value={instrumentName}
                onChange={(e) => setInstrumentName(e.target.value)}
                placeholder="Nome do instrumento"
                disabled={building}
              />
            </div>
            <button className="btn ghost small" onClick={() => void pickFiles()} disabled={building}>
              <Upload size={13} /> Escolher arquivos…
            </button>
            <button className="btn ghost small" onClick={() => void pickFolder()} disabled={building}>
              <FolderOpen size={13} /> Escolher pasta…
            </button>
            <button className="btn ghost small" onClick={applyAutoMapping} disabled={building || rows.length === 0}>
              Aplicar mapeamento automático
            </button>
          </div>

          {rows.length === 0 && (
            <div className="kc-dropzone" onClick={() => void pickFiles()}>
              Nenhum arquivo adicionado ainda — escolha arquivos ou uma pasta com as amostras renderizadas pelo Kontakt (WAV/AIFF/FLAC).
            </div>
          )}

          {duplicateGroups.length > 0 && (
            <div className="kc-duplicate-banner">
              <AlertTriangle size={13} />
              {duplicateGroups.length === 1
                ? 'Um grupo de arquivos com o mesmo conteúdo de áudio foi detectado — confira se é intencional (ex.: mesma amostra reaproveitada) antes de confirmar.'
                : `${duplicateGroups.length} grupos de arquivos com o mesmo conteúdo de áudio foram detectados — confira antes de confirmar.`}
            </div>
          )}

          {rows.length > 0 && (
            <div className="kc-grid-wrap">
              <table className="kc-grid">
                <thead>
                  <tr>
                    <th>Arquivo</th>
                    <th>Grupo/camada</th>
                    <th>Nota raiz</th>
                    <th>Faixa de tecla</th>
                    <th>Faixa de vel.</th>
                    <th>Round robin</th>
                    <th>Excl.</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const isDup = duplicateRowIds.has(row.id);
                    return (
                      <tr key={row.id} className={`${isDup ? 'duplicate' : ''} ${row.probeError ? 'row-error' : ''}`}>
                        <td>
                          <div className="kc-file-cell">
                            <span className="name" title={row.path}>
                              {row.fileName}
                            </span>
                            <span className="meta">
                              {row.probing && (
                                <>
                                  <Loader2 size={10} className="mrq-spin" /> analisando…
                                </>
                              )}
                              {row.probeError && <span title={row.probeError}>erro ao ler arquivo</span>}
                              {row.probe && (
                                <>
                                  {formatDuration(row.probe.durationSeconds)} · {row.probe.sampleRateHz} Hz ·{' '}
                                  {row.probe.channels >= 2 ? 'estéreo' : 'mono'}
                                  {isDup && <span className="kc-badge dup" style={{ marginLeft: 4 }}>duplicado</span>}
                                </>
                              )}
                            </span>
                          </div>
                        </td>
                        <td>
                          <input
                            type="text"
                            value={row.group}
                            onChange={(e) => updateRow(row.id, { group: e.target.value })}
                            disabled={building}
                          />
                        </td>
                        <td>
                          <div className="kc-key-pair">
                            <input
                              type="number"
                              min={0}
                              max={127}
                              value={row.rootNote}
                              onChange={(e) => updateRow(row.id, { rootNote: Number(e.target.value), rootNoteAuto: false })}
                              disabled={building}
                            />
                            <span className={`kc-badge ${row.rootNoteAuto ? 'auto' : 'manual'}`}>
                              {midiNoteLabel(row.rootNote)}
                            </span>
                          </div>
                        </td>
                        <td>
                          <div className="kc-key-pair">
                            <input
                              type="number"
                              min={0}
                              max={127}
                              value={row.loKey}
                              onChange={(e) => updateRow(row.id, { loKey: Number(e.target.value) })}
                              disabled={building}
                            />
                            –
                            <input
                              type="number"
                              min={0}
                              max={127}
                              value={row.hiKey}
                              onChange={(e) => updateRow(row.id, { hiKey: Number(e.target.value) })}
                              disabled={building}
                            />
                          </div>
                        </td>
                        <td>
                          <div className="kc-vel-pair">
                            <input
                              type="number"
                              min={0}
                              max={127}
                              value={row.loVel}
                              onChange={(e) => updateRow(row.id, { loVel: Number(e.target.value) })}
                              disabled={building}
                            />
                            –
                            <input
                              type="number"
                              min={0}
                              max={127}
                              value={row.hiVel}
                              onChange={(e) => updateRow(row.id, { hiVel: Number(e.target.value) })}
                              disabled={building}
                            />
                            {row.velocityAuto && <span className="kc-badge auto">auto</span>}
                          </div>
                        </td>
                        <td>
                          <div className="kc-vel-pair">
                            <input
                              type="text"
                              placeholder="grupo"
                              value={row.roundRobinGroup}
                              onChange={(e) => updateRow(row.id, { roundRobinGroup: e.target.value })}
                              disabled={building}
                              style={{ width: 70 }}
                            />
                            <input
                              type="number"
                              placeholder="#"
                              value={row.roundRobinIndex}
                              onChange={(e) => updateRow(row.id, { roundRobinIndex: e.target.value })}
                              disabled={building}
                              style={{ width: 40 }}
                            />
                          </div>
                        </td>
                        <td>
                          <input
                            type="number"
                            placeholder="—"
                            value={row.exclusiveGroup}
                            onChange={(e) => updateRow(row.id, { exclusiveGroup: e.target.value })}
                            disabled={building}
                            style={{ width: 44 }}
                          />
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button
                              className="icon-btn small"
                              title={row.fileUrl ? 'Pré-escutar' : 'Aguardando leitura do arquivo'}
                              disabled={!row.fileUrl}
                              onClick={() => togglePlay(row)}
                            >
                              {playingId === row.id ? <Pause size={12} /> : <Play size={12} />}
                            </button>
                            <button
                              className="icon-btn small"
                              title="Remover"
                              disabled={building}
                              onClick={() => removeRow(row.id)}
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="kc-footer">
          <div>
            {error && <span className="kc-footer-error">{error}</span>}
            {building && progress && (
              <span className="kc-footer-progress">
                <Loader2 size={14} className="mrq-spin" /> Gravando amostra {progress.done}/{progress.total}…
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn ghost" onClick={onClose} disabled={building}>
              Cancelar
            </button>
            <button className="btn primary" onClick={() => void handleConfirm()} disabled={building || rows.length === 0}>
              {building ? <Loader2 size={14} className="mrq-spin" /> : <Save size={14} />} Gerar instrumento .mrq
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
