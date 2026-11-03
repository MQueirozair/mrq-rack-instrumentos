/**
 * MRQ Instrument Converter — página de conversão de instrumentos pra `.mrq`
 * (Fase 8, ver docs/mrq-instrument-converter/mrq-converter-architecture.md §7). Três áreas:
 *
 *   A. Importação/Fila (coluna da esquerda) — escolher arquivos (multi-
 *      seleção), detecção automática de formato (extensão + checagem
 *      auxiliar de assinatura binária) e fila de conversão com status real
 *      por item.
 *   B. Pré-visualização (faixa no topo da coluna principal) — resumo do
 *      item selecionado + botão de pré-escuta rápida (só funciona depois de
 *      convertido: toca uma amostra real decodificada pelo backend Rust via
 *      `mrq_extract_sample`, nunca decodificação no WebView).
 *   C. Inspetor de Instrumentos (resto da coluna principal) — hospeda o MRQ
 *      Instrument Analyzer (ver MrqInstrumentAnalyzer.tsx).
 *
 * Sobre arrastar-e-soltar: a janela principal do app roda com
 * `dragDropEnabled: false` (ver src-tauri/tauri.conf.json) de propósito,
 * pra permitir o drag-and-drop HTML5 interno do ArrangeEditor (reordenar
 * partes). Isso tem um efeito colateral real: com essa flag desligada, o
 * evento nativo de arrastar-arquivo-do-SO do Tauri (`onDragDropEvent`)
 * nunca dispara nesta janela — e o `drop` HTML5 padrão não expõe caminho
 * de disco real (só um `File`/blob), que é o que todo comando `mrq_*`
 * exige. Como os importadores deste conversor trabalham com arquivos
 * potencialmente grandes (bancos SF2 de centenas de MB) lendo direto do
 * disco no Rust — nunca copiando o conteúdo inteiro pela ponte do WebView
 * — implementar drag-and-drop de verdade aqui exigiria ou (a) religar
 * `dragDropEnabled` globalmente (arriscando quebrar o reordenar de partes
 * do ArrangeEditor) ou (b) gravar os bytes soltos num arquivo temporário
 * antes de inspecionar/converter. Nenhuma das duas foi feita sem validar
 * com o usuário — por ora a importação é só pelo seletor de arquivos
 * abaixo (que sempre devolve caminhos reais, independente dessa flag).
 *
 * Importante: esta tela só roda dentro do Tauri (usa `@tauri-apps/plugin-dialog`
 * diretamente, igual a `mrqFormat.ts`) — não tem equivalente no build legado
 * em Electron, então não passa por `window.api` para diálogo de arquivos.
 */
import { useMemo, useRef, useState } from 'react';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import {
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
  FolderSearch,
  Loader2,
  Pause,
  Play,
  Save,
  Settings2,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import {
  basenameOf,
  convertAny,
  detectFormatByExtension,
  FORMAT_LABELS,
  inspectAny,
  magicBytesConflictWarning,
  readFileHeaderBytes,
  sniffMagicBytes,
  type ConverterFormatId,
  type NkiUnresolvedSample,
  type ExsUnresolvedSample,
} from '../audio/rack/converterFormats';
import {
  mrqDecodedSampleToAudioBuffer,
  mrqExtractSample,
  mrqReadMetadata,
  type MrqCompatibilityReport,
  type MrqFileMetadata,
  type MrqFinishResult,
  type MrqInstrumentModel,
} from '../audio/rack/mrqFormat';
import MrqInstrumentAnalyzer, { type AnalyzerSource } from './MrqInstrumentAnalyzer';
import MappingEditor from './MappingEditor';
import KontaktCaptureDialog, { type KontaktCaptureResult } from './KontaktCaptureDialog';
import { useStore } from '../state/useStore';
import { isTauriRuntime } from '../runtimeEnv';

type QueueStatus = 'pending' | 'inspecting' | 'inspected' | 'inspect-error' | 'converting' | 'converted' | 'convert-error';

interface QueueItem {
  id: string;
  path: string;
  fileName: string;
  format: ConverterFormatId | null;
  magicWarning: string | null;
  status: QueueStatus;
  instrument?: MrqInstrumentModel;
  compatibility?: MrqCompatibilityReport;
  error?: string;
  convertProgress?: { done: number; total: number };
  convertedPath?: string;
  convertedFinish?: MrqFinishResult;
  convertedMetadata?: MrqFileMetadata;
  /** Só preenchido pra `.nki`/`.exs` (ver ConverterInspection.unresolved) —
   *  lista estruturada das amostras que não resolveram, pra oferecer
   *  "escolher pasta da biblioteca" quando `reason === 'not-found'`. */
  unresolved?: (NkiUnresolvedSample | ExsUnresolvedSample)[];
  /** Pasta raiz de biblioteca escolhida manualmente pelo usuário (ver
   *  chooseLibraryFolderForItem) — reaplicada automaticamente em
   *  re-inspeções/conversões deste mesmo item, pra não precisar escolher de
   *  novo a cada tentativa. */
  libraryRoot?: string;
  /** Preenchido quando o item veio do fluxo "Kontakt Audio Capture" (ver
   *  KontaktCaptureDialog.tsx) em vez de um dos importadores de arquivo
   *  avulso de cima — já nasce com `status: 'converted'` (o `.mrq` já foi
   *  gravado dentro do diálogo) e `format: null` (não é um formato de
   *  origem reconhecido por extensão, é uma captura de áudio renderizado). */
  captureKind?: 'kontakt-audio';
  /** Mapeamento editado pelo usuário no Editor de Mapeamento (botão
   *  "Editar mapeamento" na faixa de pré-visualização) — ver
   *  `MappingEditor.tsx`. Quando presente, `convertItem` passa isto como
   *  `overrideInstrument` pra `convertAny`; só tem efeito real em
   *  `.syx`/`.nki`/`.exs` hoje (ver `formatSupportsMappingEdits` abaixo) —
   *  pros demais formatos fica guardado pra quando o backend Rust ganhar
   *  suporte a receber mapeamento editado de volta.
   */
  editedInstrument?: MrqInstrumentModel;
}

/** Só `.syx` (DX7), `.nki` (Kontakt) e `.exs` (Logic EXS24) convertem
 *  inteiramente no WebView, montando o `MrqInstrumentModel` localmente
 *  antes de chamar `mrqBuilderBegin` — pra esses, um modelo editado no
 *  Editor de Mapeamento pode ser usado de verdade na conversão (ver
 *  `overrideInstrument` em converterFormats.ts). Os demais formatos
 *  (SF2/SF3, NPNO/NSMP, WAV/AIFF/FLAC/MP3/OGG) convertem via um único
 *  comando Rust opaco que reconstrói tudo do zero a partir do arquivo de
 *  origem, sem gancho pra receber mapeamento de volta — e a captura de
 *  áudio Kontakt já nasce convertida (não há nada pra reconverter aqui). */
function formatSupportsMappingEdits(item: QueueItem): boolean {
  return !item.captureKind && (item.format === 'syx' || item.format === 'nki' || item.format === 'exs');
}

function mappingPersistNote(item: QueueItem): string {
  if (formatSupportsMappingEdits(item)) {
    return 'As edições feitas aqui são usadas de verdade na conversão deste instrumento — .syx/.nki/.exs convertem inteiramente dentro do app, sem depender de um comando opaco do backend.';
  }
  return 'Este formato ainda converte por um único comando do backend Rust que reconstrói o mapeamento direto do arquivo original. As edições feitas aqui ficam guardadas nesta sessão (e no botão "Salvar edições"), mas a conversão de hoje usa o mapeamento original — aplicar edições de verdade a este formato é a próxima etapa, ainda não implementada.';
}

let idCounter = 0;
function makeId(): string {
  idCounter += 1;
  return `qi-${Date.now().toString(36)}-${idCounter}`;
}

function logConverterError(context: string, err: unknown) {
  const e = err instanceof Error ? err : new Error(String(err));
  console.error(`[InstrumentConverter] ${context}:`, e);
  try {
    void window.api?.log?.append?.(`[InstrumentConverter] ${context}: ${e.name}: ${e.message}\n${e.stack ?? ''}`);
  } catch {
    /* noop */
  }
}

export default function InstrumentConverter() {
  // Segunda camada de defesa: o item de navegação já fica escondido fora do
  // Tauri (ver IconRail.tsx), mas se este componente for alcançado de outro
  // jeito mesmo assim, mostra um aviso claro em vez de deixar os diálogos de
  // arquivo (@tauri-apps/plugin-dialog) falharem de forma confusa.
  if (!isTauriRuntime()) {
    return (
      <div className="converter-page-outer">
        <div className="empty-state">
          <h3>Conversor de instrumentos (.mrq)</h3>
          <p>Esta funcionalidade só está disponível na versão Tauri do MRQ - Multitracks Play.</p>
        </div>
      </div>
    );
  }
  return <InstrumentConverterInner />;
}

function InstrumentConverterInner() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [captureDialogOpen, setCaptureDialogOpen] = useState(false);
  const [mappingEditorItemId, setMappingEditorItemId] = useState<string | null>(null);
  const pushToast = useStore((s) => s.pushToast);

  function handleCaptureImported(result: KontaktCaptureResult) {
    const item: QueueItem = {
      id: makeId(),
      path: result.convertedPath,
      fileName: result.fileName,
      format: null,
      magicWarning: null,
      status: 'converted',
      instrument: result.instrument,
      compatibility: result.compatibility,
      convertedPath: result.convertedPath,
      convertedFinish: result.convertedFinish,
      convertedMetadata: result.convertedMetadata,
      captureKind: 'kontakt-audio',
    };
    setQueue((prev) => [...prev, item]);
    setSelectedId(item.id);
    setCaptureDialogOpen(false);
  }

  const selected = queue.find((q) => q.id === selectedId) ?? null;

  async function pickFiles() {
    try {
      const result = await openDialog({
        multiple: true,
        title: 'Escolher instrumentos para converter',
        filters: [
          {
            name: 'Instrumentos suportados',
            extensions: ['sf2', 'sf3', 'npno', 'nsmp', 'nsmp3', 'nsmp4', 'syx', 'nki', 'exs', 'wav', 'wave', 'aiff', 'aif', 'flac', 'mp3', 'ogg'],
          },
          { name: 'Todos os arquivos', extensions: ['*'] },
        ],
      });
      if (!result) return;
      const paths = Array.isArray(result) ? result : [result];
      await addFiles(paths);
    } catch (err) {
      logConverterError('falha ao abrir diálogo de importação', err);
      pushToast('Não foi possível abrir o seletor de arquivos.', 'error');
    }
  }

  async function addFiles(paths: string[]) {
    const newItems: QueueItem[] = [];
    for (const path of paths) {
      const format = detectFormatByExtension(path);
      let magicWarning: string | null = null;
      try {
        const header = await readFileHeaderBytes(path, 32);
        if (format) magicWarning = magicBytesConflictWarning(format, sniffMagicBytes(header));
      } catch {
        /* checagem auxiliar — falha aqui não deve impedir a importação */
      }
      newItems.push({
        id: makeId(),
        path,
        fileName: basenameOf(path),
        format,
        magicWarning,
        status: format ? 'pending' : 'inspect-error',
        error: format ? undefined : 'Extensão não reconhecida pelo conversor.',
      });
    }
    setQueue((prev) => [...prev, ...newItems]);
    if (!selectedId && newItems.length > 0) setSelectedId(newItems[0].id);
    for (const item of newItems) {
      if (item.format) await inspectItem(item.id, item.format, item.path);
    }
  }

  async function inspectItem(id: string, format: ConverterFormatId, path: string, libraryRoot?: string) {
    setQueue((prev) => prev.map((q) => (q.id === id ? { ...q, status: 'inspecting' } : q)));
    try {
      const result = await inspectAny(format, path, { libraryRoot });
      setQueue((prev) =>
        prev.map((q) =>
          q.id === id
            ? { ...q, status: 'inspected', instrument: result.instrument, compatibility: result.compatibility, unresolved: result.unresolved, libraryRoot }
            : q
        )
      );
    } catch (err) {
      logConverterError(`falha ao inspecionar "${path}" (formato=${format})`, err);
      const e = err instanceof Error ? err.message : String(err);
      setQueue((prev) => prev.map((q) => (q.id === id ? { ...q, status: 'inspect-error', error: e, libraryRoot } : q)));
    }
  }

  /** Pede ao usuário a pasta-raiz de uma biblioteca de amostras e reinspeciona
   *  o item com ela (ver NkiLayerVoice.resolveFromLibraryRoot/ExsLayerVoice.resolveFromLibraryRoot/
   *  ConverterFormatOptions.libraryRoot)
   *  — mesmo comportamento de recuperação que o Mixer Pro oferece pra
   *  biblioteca Kontakt "fora do lugar", reimplementado aqui sem usar nenhum
   *  código dele, só o mesmo padrão de UX (perguntar a pasta raiz e procurar
   *  os arquivos faltantes dentro dela). */
  async function chooseLibraryFolderForItem(item: QueueItem) {
    if (!item.format) return;
    try {
      const result = await openDialog({ directory: true, title: 'Escolher a pasta raiz da biblioteca de amostras' });
      if (!result) return;
      const folder = Array.isArray(result) ? result[0] : result;
      if (!folder) return;
      await inspectItem(item.id, item.format, item.path, folder);
    } catch (err) {
      logConverterError('falha ao abrir diálogo de pasta da biblioteca', err);
      pushToast('Não foi possível abrir o seletor de pasta.', 'error');
    }
  }

  async function convertItem(item: QueueItem) {
    if (!item.format) return;
    const suggested = item.fileName.replace(/\.[^.]+$/, '') + '.mrq';
    let destPath: string | null = null;
    try {
      destPath = await saveDialog({
        title: 'Salvar instrumento MRQ',
        defaultPath: suggested,
        filters: [{ name: 'MRQ Instrument (.mrq)', extensions: ['mrq'] }],
      });
    } catch (err) {
      logConverterError('falha ao abrir diálogo de salvar', err);
      pushToast('Não foi possível abrir o seletor de destino.', 'error');
      return;
    }
    if (!destPath) return;
    setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: 'converting', convertProgress: undefined } : q)));
    try {
      const result = await convertAny(
        item.format,
        item.path,
        destPath,
        (done, total) => {
          setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, convertProgress: { done, total } } : q)));
        },
        { libraryRoot: item.libraryRoot, overrideInstrument: item.editedInstrument }
      );
      const metadata = await mrqReadMetadata(destPath);
      setQueue((prev) =>
        prev.map((q) =>
          q.id === item.id
            ? {
                ...q,
                status: 'converted',
                convertedPath: destPath as string,
                convertedFinish: result.finish,
                convertedMetadata: metadata,
                compatibility: result.compatibility,
                unresolved: result.unresolved,
              }
            : q
        )
      );
      pushToast(`"${item.fileName}" convertido com sucesso.`);
    } catch (err) {
      logConverterError(`falha ao converter "${item.path}" (formato=${item.format})`, err);
      const e = err instanceof Error ? err.message : String(err);
      setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: 'convert-error', error: e } : q)));
      pushToast(`Falha ao converter "${item.fileName}": ${e}`, 'error');
    }
  }

  function removeItem(id: string) {
    setQueue((prev) => prev.filter((q) => q.id !== id));
    if (selectedId === id) setSelectedId(null);
  }

  const analyzerSource: AnalyzerSource | null = useMemo(() => {
    if (!selected || !selected.instrument || !selected.compatibility) return null;
    return {
      label: selected.fileName,
      sourceFormatLabel: selected.captureKind === 'kontakt-audio'
        ? 'Captura de áudio Kontakt (WAV renderizado)'
        : selected.format
          ? FORMAT_LABELS[selected.format]
          : selected.fileName,
      sourcePath: selected.path,
      instrument: selected.instrument,
      compatibility: selected.compatibility,
      converted:
        selected.convertedPath && selected.convertedFinish && selected.convertedMetadata
          ? { path: selected.convertedPath, finish: selected.convertedFinish, metadata: selected.convertedMetadata }
          : undefined,
    };
  }, [selected]);

  return (
    <div className="converter-page-outer">
      <div className="converter-page">
        <div className="converter-queue-col">
          <div className="converter-queue-header">
            <h3>Importar instrumentos</h3>
            <button className="btn primary" onClick={() => void pickFiles()}>
              <FolderOpen size={14} /> Escolher arquivos…
            </button>
          </div>
          <div className="converter-dropzone" onClick={() => void pickFiles()}>
            <Upload size={18} />
            <span>SF2/SF3, NPNO/NSMP, SYX, NKI, EXS, WAV/AIFF/FLAC/MP3/OGG — clique para escolher um ou vários arquivos</span>
          </div>
          <button className="btn ghost" onClick={() => setCaptureDialogOpen(true)}>
            <Upload size={14} /> Importar instrumento renderizado pelo Kontakt…
          </button>
          <div className="converter-queue-list">
            {queue.length === 0 && <p className="mrq-tab-hint">Nenhum arquivo na fila ainda.</p>}
            {queue.map((item) => (
              <QueueRow
                key={item.id}
                item={item}
                selected={item.id === selectedId}
                onSelect={() => setSelectedId(item.id)}
                onConvert={() => void convertItem(item)}
                onRemove={() => removeItem(item.id)}
                onChooseLibraryFolder={() => void chooseLibraryFolderForItem(item)}
              />
            ))}
          </div>
        </div>

        <div className="converter-main-col">
          {selected ? (
            <PreviewStrip
              item={selected}
              onConvert={() => void convertItem(selected)}
              onOpenMapping={() => setMappingEditorItemId(selected.id)}
            />
          ) : (
            <div className="converter-preview-strip empty">Selecione um item da fila para inspecionar.</div>
          )}
          <div className="converter-inspector">
            {analyzerSource ? (
              <MrqInstrumentAnalyzer source={analyzerSource} />
            ) : selected?.status === 'inspecting' ? (
              <div className="empty-state">
                <Loader2 size={22} className="mrq-spin" />
                <p>Analisando "{selected.fileName}"…</p>
              </div>
            ) : selected?.status === 'inspect-error' ? (
              <div className="empty-state">
                <AlertTriangle size={22} color="#ff5577" />
                <p>Não foi possível analisar "{selected.fileName}".</p>
                <p className="mrq-error-text">{selected.error}</p>
              </div>
            ) : (
              <div className="empty-state">
                <h3>Inspetor de Instrumentos</h3>
                <p>Importe e selecione um arquivo na fila à esquerda para ver detalhes de mapeamento, velocity, amostras e compatibilidade.</p>
              </div>
            )}
          </div>
        </div>
      </div>
      {captureDialogOpen && (
        <KontaktCaptureDialog onClose={() => setCaptureDialogOpen(false)} onImported={handleCaptureImported} />
      )}
      {mappingEditorItemId &&
        (() => {
          const item = queue.find((q) => q.id === mappingEditorItemId);
          if (!item || !item.instrument) return null;
          return (
            <MappingEditor
              fileName={item.fileName}
              formatLabel={item.captureKind === 'kontakt-audio' ? 'Captura de áudio Kontakt' : item.format ? FORMAT_LABELS[item.format] : ''}
              instrument={item.editedInstrument ?? item.instrument}
              canPersist={formatSupportsMappingEdits(item)}
              persistNote={mappingPersistNote(item)}
              onClose={() => setMappingEditorItemId(null)}
              onSave={(edited) => {
                setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, editedInstrument: edited } : q)));
                pushToast(`Mapeamento de "${item.fileName}" atualizado.`);
              }}
            />
          );
        })()}
    </div>
  );
}

function statusBadge(item: QueueItem) {
  switch (item.status) {
    case 'pending':
      return <span className="converter-status pending">na fila</span>;
    case 'inspecting':
      return (
        <span className="converter-status busy">
          <Loader2 size={11} className="mrq-spin" /> analisando
        </span>
      );
    case 'inspected':
      return (
        <span className="converter-status ok">
          <CheckCircle2 size={11} /> pronto
        </span>
      );
    case 'inspect-error':
      return (
        <span className="converter-status bad">
          <XCircle size={11} /> erro
        </span>
      );
    case 'converting':
      return (
        <span className="converter-status busy">
          <Loader2 size={11} className="mrq-spin" /> convertendo
          {item.convertProgress ? ` (${item.convertProgress.done}/${item.convertProgress.total})` : ''}
        </span>
      );
    case 'converted':
      return (
        <span className="converter-status ok">
          <CheckCircle2 size={11} /> convertido
        </span>
      );
    case 'convert-error':
      return (
        <span className="converter-status bad">
          <XCircle size={11} /> falhou
        </span>
      );
    default:
      return null;
  }
}

function QueueRow({
  item,
  selected,
  onSelect,
  onConvert,
  onRemove,
  onChooseLibraryFolder,
}: {
  item: QueueItem;
  selected: boolean;
  onSelect: () => void;
  onConvert: () => void;
  onRemove: () => void;
  onChooseLibraryFolder: () => void;
}) {
  const busy = item.status === 'converting';
  const missingCount = item.unresolved?.filter((u) => u.reason === 'not-found').length ?? 0;
  return (
    <div className={`converter-queue-row ${selected ? 'selected' : ''}`} onClick={onSelect}>
      <div className="converter-queue-row-top">
        <span className="converter-queue-row-name" title={item.path}>
          {item.fileName}
        </span>
        <button
          className="icon-btn small"
          title={busy ? 'Aguarde a conversão terminar' : 'Remover da fila'}
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <Trash2 size={12} />
        </button>
      </div>
      <div className="converter-queue-row-meta">
        <span>{item.format ? FORMAT_LABELS[item.format] : 'formato não reconhecido'}</span>
        {statusBadge(item)}
      </div>
      {item.magicWarning && (
        <div className="converter-queue-row-warning">
          <AlertTriangle size={11} /> {item.magicWarning}
        </div>
      )}
      {item.status === 'inspect-error' && <div className="converter-queue-row-warning">{item.error}</div>}
      {item.status === 'convert-error' && <div className="converter-queue-row-warning">{item.error}</div>}
      {(item.format === 'nki' || item.format === 'exs') && (missingCount > 0 || item.status === 'inspect-error') && (
        <div className="converter-queue-row-warning">
          <AlertTriangle size={11} />{' '}
          {missingCount > 0 ? `${missingCount} amostra(s) não encontrada(s)` : 'amostras não encontradas ao lado do arquivo'}
          <button
            className="icon-btn small"
            title="Escolher a pasta raiz da biblioteca de amostras e tentar resolver de novo"
            onClick={(e) => {
              e.stopPropagation();
              onChooseLibraryFolder();
            }}
          >
            <FolderSearch size={12} />
          </button>
        </div>
      )}
      {!item.captureKind && (item.status === 'inspected' || item.status === 'converted' || item.status === 'convert-error') && (
        <button
          className="btn ghost small"
          onClick={(e) => {
            e.stopPropagation();
            onConvert();
          }}
        >
          <Save size={12} /> {item.status === 'converted' ? 'Converter novamente…' : 'Converter para .mrq…'}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Área B — pré-visualização: resumo do item selecionado + pré-escuta rápida
// (só habilitada pós-conversão, tocando uma amostra real decodificada pelo
// backend Rust via mrq_extract_sample).
// ---------------------------------------------------------------------------
function PreviewStrip({ item, onConvert, onOpenMapping }: { item: QueueItem; onConvert: () => void; onOpenMapping: () => void }) {
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);

  function pickRepresentativeSample(): { sampleId: string } | null {
    for (const preset of item.instrument?.presets ?? []) {
      for (const group of preset.groups) {
        if (group.zones.length > 0) return { sampleId: group.zones[0].sampleId };
      }
    }
    return null;
  }

  async function togglePreview() {
    if (playing) {
      try {
        sourceNodeRef.current?.stop();
      } catch {
        /* já parado */
      }
      setPlaying(false);
      return;
    }
    if (!item.convertedPath) return;
    const rep = pickRepresentativeSample();
    if (!rep) return;
    setLoading(true);
    try {
      const decoded = await mrqExtractSample(item.convertedPath, rep.sampleId);
      if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') await ctx.resume();
      const buffer = mrqDecodedSampleToAudioBuffer(ctx, decoded);
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(ctx.destination);
      node.onended = () => setPlaying(false);
      node.start();
      sourceNodeRef.current = node;
      setPlaying(true);
    } catch (err) {
      logConverterError('falha na pré-escuta', err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="converter-preview-strip">
      <div className="converter-preview-info">
        <strong>{item.instrument?.name || item.fileName}</strong>
        <span>{item.captureKind === 'kontakt-audio' ? 'Captura de áudio Kontakt' : item.format ? FORMAT_LABELS[item.format] : ''}</span>
        {statusBadge(item)}
      </div>
      <div className="converter-preview-actions">
        <button
          className="btn ghost small"
          disabled={!item.convertedPath || loading}
          title={item.convertedPath ? 'Tocar uma amostra do instrumento convertido' : 'Converta primeiro para pré-escutar'}
          onClick={() => void togglePreview()}
        >
          {loading ? <Loader2 size={13} className="mrq-spin" /> : playing ? <Pause size={13} /> : <Play size={13} />} Pré-escutar
        </button>
        {item.instrument && !item.captureKind && (
          <button className="btn ghost small" onClick={onOpenMapping} title="Abrir o Editor de Mapeamento — ajustar tecla raiz, afinação, faixas, volume e pan por zona antes de converter">
            <Settings2 size={13} /> Editar mapeamento{item.editedInstrument ? ' •' : ''}
          </button>
        )}
        {item.status !== 'converting' && !item.captureKind && (
          <button className="btn primary small" onClick={onConvert}>
            <Save size={13} /> {item.status === 'converted' ? 'Converter novamente' : 'Converter para .mrq'}
          </button>
        )}
      </div>
    </div>
  );
}
