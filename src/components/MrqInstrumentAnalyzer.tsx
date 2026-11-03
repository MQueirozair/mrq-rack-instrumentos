/**
 * MRQ Instrument Analyzer — painel de inspeção com abas usado pelo
 * Inspetor de Instrumentos do MRQ Instrument Converter (Fase 8, ver
 * docs/mrq-instrument-converter/mrq-converter-architecture.md §7.1).
 *
 * Regras obrigatórias (valem pra todas as abas abaixo):
 *  - só usa metadado real já extraído pelos importadores/backend — nunca
 *    inventa dado pra preencher um gráfico (campo ausente aparece como
 *    "não informado", nunca um valor de exemplo);
 *  - nenhuma decodificação pesada de áudio acontece aqui dentro: a forma de
 *    onda da aba "Amostras" só existe depois de converter pra `.mrq`, e os
 *    quadros PCM vêm já decodificados do backend Rust via
 *    `mrqExtractSample` — o WebView só desenha o que chega, não decodifica
 *    MP3/FLAC/etc. sozinho;
 *  - a aba "Comparar Original x MRQ" só fica habilitada quando existe de
 *    verdade uma conversão concluída pra comparar (nunca uma simulação).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Info,
  ListTree,
  Loader2,
  Pause,
  Play,
  Repeat,
  Settings,
  Sliders,
  Waves,
  X,
  XCircle,
} from 'lucide-react';
import {
  mrqDecodedSampleToAudioBuffer,
  mrqExtractSample,
  type MrqCompatibilityReport,
  type MrqDecodedSample,
  type MrqFileMetadata,
  type MrqFinishResult,
  type MrqGroup,
  type MrqInstrumentModel,
  type MrqPreset,
  type MrqSourceFormat,
  type MrqZone,
} from '../audio/rack/mrqFormat';
import { midiNoteLabel, midiNoteName } from '../audio/rack/midiNoteNames';

export interface AnalyzerConvertedInfo {
  path: string;
  finish: MrqFinishResult;
  metadata: MrqFileMetadata;
}

export interface AnalyzerSource {
  label: string;
  sourceFormatLabel: string;
  sourcePath: string;
  instrument: MrqInstrumentModel;
  compatibility: MrqCompatibilityReport;
  converted?: AnalyzerConvertedInfo;
}

type AnalyzerTab = 'overview' | 'keyboard' | 'velocity' | 'tree' | 'samples' | 'loops' | 'compat' | 'compare';

const TABS: { id: AnalyzerTab; label: string }[] = [
  { id: 'overview', label: 'Visão geral' },
  { id: 'keyboard', label: 'Teclado' },
  { id: 'velocity', label: 'Velocity' },
  { id: 'tree', label: 'Grupos & zonas' },
  { id: 'samples', label: 'Amostras' },
  { id: 'loops', label: 'Loops' },
  { id: 'compat', label: 'Compatibilidade' },
  { id: 'compare', label: 'Comparar' },
];

const SOURCE_FORMAT_LABELS: Record<MrqSourceFormat, string> = {
  sf2: 'SoundFont 2 (SF2)',
  sf3: 'SoundFont 3 (SF3)',
  sfz: 'SFZ',
  npno: 'Biblioteca de piano Nord (NPNO)',
  nsmp: 'Amostra Nord (NSMP)',
  'syx-dx7': 'Banco SysEx DX7 (SYX)',
  nki: 'Patch Kontakt (NKI)',
  exs: 'Instrumento Logic EXS24 (EXS)',
  wav: 'WAV',
  aiff: 'AIFF',
  flac: 'FLAC',
  mp3: 'MP3',
  ogg: 'OGG Vorbis',
  'kontakt-capture': 'Captura de áudio Kontakt (WAV renderizado)',
};

// ---------------------------------------------------------------------------
// Painel "⚙ Mostrar ajustes" do cabeçalho — preferências de VISUALIZAÇÃO e
// INSPEÇÃO do Analyzer (zoom do teclado, o que mostrar/ocultar, filtros,
// modo de comparação). Nada aqui lê/escreve o `.mrq`, nem altera
// `MrqInstrumentModel`/samples — são só flags que mudam COMO as abas já
// existentes desenham os mesmos dados reais. Ficam no componente raiz
// (`MrqInstrumentAnalyzer`) e sobrevivem à troca de instrumento selecionado
// (só a seleção de zona/aba ativa é resetada ao trocar de arquivo — ver
// `useEffect` abaixo), conforme pedido ("manter as preferências de
// visualização durante a sessão").
// ---------------------------------------------------------------------------
interface AnalyzerViewSettings {
  // A. Visualização (aba Teclado)
  keyboardZoom: number; // 0.7–1.6, multiplica a largura/altura das teclas
  showNoteNames: boolean;
  showRootKeys: boolean;
  showZoneRegions: boolean; // realce da zona selecionada sobre o teclado
  showGroupDividers: boolean;
  showOverlaps: boolean;

  // B. Velocity
  showVelocityLayers: boolean;
  velocityViewMode: 'regions' | 'graph';
  showVelocityMinMax: boolean;
  highlightVelocityGapsOverlaps: boolean;

  // C. Amostras
  showWaveform: boolean;
  waveformZoom: number; // 1–4, multiplica a largura do canvas (scroll horizontal)
  showSampleTechInfo: boolean;
  enablePreview: boolean;

  // D. Grupos & zonas — filtros (as ações de expandir/recolher tudo não
  // precisam de estado próprio aqui, ver `treeExpanded` mais abaixo)
  filterGroupName: string | null;
  filterNoteLo: number | null;
  filterNoteHi: number | null;
  filterVelLo: number | null;
  filterVelHi: number | null;

  // E. Comparação
  compareShowOnlyDiffs: boolean;
  compareHighlightCompat: boolean;
}

const DEFAULT_VIEW_SETTINGS: AnalyzerViewSettings = {
  keyboardZoom: 1,
  showNoteNames: true,
  showRootKeys: true,
  showZoneRegions: true,
  showGroupDividers: true,
  showOverlaps: true,
  showVelocityLayers: true,
  velocityViewMode: 'regions',
  showVelocityMinMax: true,
  highlightVelocityGapsOverlaps: true,
  showWaveform: true,
  waveformZoom: 1,
  showSampleTechInfo: true,
  enablePreview: true,
  filterGroupName: null,
  filterNoteLo: null,
  filterNoteHi: null,
  filterVelLo: null,
  filterVelHi: null,
  compareShowOnlyDiffs: false,
  compareHighlightCompat: true,
};

// ---------------------------------------------------------------------------
// Achatamento do modelo (Instrument -> Preset -> Group -> Zone) numa lista
// plana, usada por quase todas as abas. É só uma projeção de leitura — não
// altera o modelo.
// ---------------------------------------------------------------------------
export interface FlatZone {
  key: string;
  preset: MrqPreset;
  group: MrqGroup;
  zone: MrqZone;
  zoneIndex: number;
}

function flattenZones(instrument: MrqInstrumentModel): FlatZone[] {
  const out: FlatZone[] = [];
  instrument.presets.forEach((preset) => {
    preset.groups.forEach((group) => {
      group.zones.forEach((zone, zoneIndex) => {
        out.push({ key: `${preset.id}::${group.id}::${zoneIndex}`, preset, group, zone, zoneIndex });
      });
    });
  });
  return out;
}

function hashHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

function groupColor(groupId: string): string {
  return `hsl(${hashHue(groupId)}, 62%, 56%)`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export default function MrqInstrumentAnalyzer({ source }: { source: AnalyzerSource }) {
  const [tab, setTab] = useState<AnalyzerTab>('overview');
  const [selectedZoneKey, setSelectedZoneKey] = useState<string | null>(null);

  // Preferências de visualização/inspeção do painel "⚙ Mostrar ajustes" —
  // deliberadamente NÃO entram no useEffect de reset abaixo: devem
  // sobreviver à troca de instrumento selecionado na mesma sessão de uso
  // (só a zona selecionada e a aba ativa são específicas de cada arquivo).
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [viewSettings, setViewSettings] = useState<AnalyzerViewSettings>(DEFAULT_VIEW_SETTINGS);
  const [treeExpanded, setTreeExpanded] = useState<Set<string> | null>(null);

  function patchViewSettings(patch: Partial<AnalyzerViewSettings>) {
    setViewSettings((prev) => ({ ...prev, ...patch }));
  }

  const flatZones = useMemo(() => flattenZones(source.instrument), [source.instrument]);
  const selectedFlatZone = flatZones.find((fz) => fz.key === selectedZoneKey) ?? null;

  // Reseta seleção ao trocar de item inspecionado (evita mostrar uma zona
  // "fantasma" de outro instrumento que por coincidência tenha a mesma key).
  useEffect(() => {
    setSelectedZoneKey(null);
    setTab('overview');
    setTreeExpanded(null);
  }, [source.sourcePath]);

  const compareEnabled = !!source.converted;

  return (
    <div className="mrq-analyzer">
      <div className="mrq-analyzer-header">
        <span className="mrq-analyzer-header-title">Inspetor de Instrumentos</span>
        <button
          className={`btn ghost small mrq-settings-toggle ${settingsOpen ? 'active' : ''}`}
          onClick={() => setSettingsOpen((v) => !v)}
          title="Preferências de visualização e inspeção do Analyzer (não altera o instrumento nem o arquivo .mrq)"
        >
          <Settings size={13} /> {settingsOpen ? 'Ocultar ajustes' : 'Mostrar ajustes'}
        </button>
      </div>
      {settingsOpen && (
        <AnalyzerSettingsPanel
          settings={viewSettings}
          onChange={patchViewSettings}
          instrument={source.instrument}
          treeExpanded={treeExpanded}
          onExpandAllGroups={() => {
            const all = new Set<string>();
            source.instrument.presets.forEach((p) => {
              all.add(p.id);
              p.groups.forEach((g) => all.add(`${p.id}::${g.id}`));
            });
            setTreeExpanded(all);
          }}
          onCollapseAllGroups={() => setTreeExpanded(new Set())}
          compareAvailable={compareEnabled}
        />
      )}
      <div className="mrq-analyzer-tabs">
        {TABS.map((t) => {
          const disabled = t.id === 'compare' && !compareEnabled;
          return (
            <button
              key={t.id}
              className={`mrq-analyzer-tab ${tab === t.id ? 'active' : ''}`}
              disabled={disabled}
              title={disabled ? 'Disponível depois de gerar o .mrq' : undefined}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <div className="mrq-analyzer-body">
        {tab === 'overview' && <OverviewTab source={source} flatZones={flatZones} />}
        {tab === 'keyboard' && (
          <KeyboardTab
            flatZones={flatZones}
            selectedZoneKey={selectedZoneKey}
            onSelectZone={setSelectedZoneKey}
            settings={viewSettings}
          />
        )}
        {tab === 'velocity' && (
          <VelocityTab
            flatZones={flatZones}
            selectedZoneKey={selectedZoneKey}
            onSelectZone={setSelectedZoneKey}
            settings={viewSettings}
          />
        )}
        {tab === 'tree' && (
          <TreeTab
            instrument={source.instrument}
            selectedZoneKey={selectedZoneKey}
            onSelectZone={setSelectedZoneKey}
            selectedFlatZone={selectedFlatZone}
            converted={source.converted}
            settings={viewSettings}
            expanded={treeExpanded}
            onExpandedChange={setTreeExpanded}
          />
        )}
        {tab === 'samples' && <SamplesTab flatZones={flatZones} converted={source.converted} settings={viewSettings} />}
        {tab === 'loops' && <LoopsTab flatZones={flatZones} converted={source.converted} />}
        {tab === 'compat' && <CompatTab compatibility={source.compatibility} />}
        {tab === 'compare' && source.converted && (
          <CompareTab
            instrument={source.instrument}
            flatZones={flatZones}
            converted={source.converted}
            compatibility={source.compatibility}
            settings={viewSettings}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Painel de ajustes do cabeçalho — só controla as flags de `AnalyzerViewSettings`
// acima (e as ações de expandir/recolher todos os grupos da aba Grupos &
// zonas, que o próprio painel pede explicitamente). Nenhum campo aqui é
// gravado em disco nem muda o `MrqInstrumentModel`/arquivo `.mrq`.
// ---------------------------------------------------------------------------
function SettingsSection({
  title,
  defaultOpen,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className="mrq-settings-section">
      <button className="mrq-settings-section-header" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span>{title}</span>
      </button>
      {open && <div className="mrq-settings-section-body">{children}</div>}
    </div>
  );
}

function AnalyzerSettingsPanel({
  settings,
  onChange,
  instrument,
  treeExpanded,
  onExpandAllGroups,
  onCollapseAllGroups,
  compareAvailable,
}: {
  settings: AnalyzerViewSettings;
  onChange: (patch: Partial<AnalyzerViewSettings>) => void;
  instrument: MrqInstrumentModel;
  treeExpanded: Set<string> | null;
  onExpandAllGroups: () => void;
  onCollapseAllGroups: () => void;
  compareAvailable: boolean;
}) {
  const groupNames = useMemo(() => {
    const names = new Set<string>();
    instrument.presets.forEach((p) => p.groups.forEach((g) => names.add(g.name)));
    return [...names];
  }, [instrument]);

  function numOrNull(raw: string): number | null {
    if (raw.trim() === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  return (
    <div className="mrq-settings-panel">
      <SettingsSection title="A. Visualização (teclado)" defaultOpen>
        <label className="mrq-settings-row">
          <span>Zoom do teclado</span>
          <input
            type="range"
            min={0.7}
            max={1.6}
            step={0.1}
            value={settings.keyboardZoom}
            onChange={(e) => onChange({ keyboardZoom: Number(e.target.value) })}
          />
          <span className="mrq-settings-value">{Math.round(settings.keyboardZoom * 100)}%</span>
        </label>
        <label className="mrq-settings-checkbox">
          <input type="checkbox" checked={settings.showNoteNames} onChange={(e) => onChange({ showNoteNames: e.target.checked })} />
          Exibir notas e nomes das notas
        </label>
        <label className="mrq-settings-checkbox">
          <input type="checkbox" checked={settings.showRootKeys} onChange={(e) => onChange({ showRootKeys: e.target.checked })} />
          Exibir Root Keys
        </label>
        <label className="mrq-settings-checkbox">
          <input type="checkbox" checked={settings.showZoneRegions} onChange={(e) => onChange({ showZoneRegions: e.target.checked })} />
          Exibir região da zona selecionada
        </label>
        <label className="mrq-settings-checkbox">
          <input type="checkbox" checked={settings.showGroupDividers} onChange={(e) => onChange({ showGroupDividers: e.target.checked })} />
          Exibir divisões entre grupos
        </label>
        <label className="mrq-settings-checkbox">
          <input type="checkbox" checked={settings.showOverlaps} onChange={(e) => onChange({ showOverlaps: e.target.checked })} />
          Exibir sobreposições de zonas
        </label>
      </SettingsSection>

      <SettingsSection title="B. Velocity">
        <label className="mrq-settings-checkbox">
          <input
            type="checkbox"
            checked={settings.showVelocityLayers}
            onChange={(e) => onChange({ showVelocityLayers: e.target.checked })}
          />
          Mostrar camadas de velocity
        </label>
        <div className="mrq-settings-row">
          <span>Modo de visualização</span>
          <select
            value={settings.velocityViewMode}
            onChange={(e) => onChange({ velocityViewMode: e.target.value as AnalyzerViewSettings['velocityViewMode'] })}
          >
            <option value="regions">Regiões (por zona)</option>
            <option value="graph">Gráfico (cobertura 0–127)</option>
          </select>
        </div>
        <label className="mrq-settings-checkbox">
          <input
            type="checkbox"
            checked={settings.showVelocityMinMax}
            onChange={(e) => onChange({ showVelocityMinMax: e.target.checked })}
          />
          Exibir intervalos mínimo/máximo
        </label>
        <label className="mrq-settings-checkbox">
          <input
            type="checkbox"
            checked={settings.highlightVelocityGapsOverlaps}
            onChange={(e) => onChange({ highlightVelocityGapsOverlaps: e.target.checked })}
          />
          Destacar lacunas e sobreposições
        </label>
      </SettingsSection>

      <SettingsSection title="C. Amostras">
        <label className="mrq-settings-checkbox">
          <input type="checkbox" checked={settings.showWaveform} onChange={(e) => onChange({ showWaveform: e.target.checked })} />
          Exibir forma de onda (waveform)
        </label>
        <label className="mrq-settings-row">
          <span>Zoom da waveform</span>
          <input
            type="range"
            min={1}
            max={4}
            step={0.5}
            value={settings.waveformZoom}
            onChange={(e) => onChange({ waveformZoom: Number(e.target.value) })}
            disabled={!settings.showWaveform}
          />
          <span className="mrq-settings-value">{settings.waveformZoom}x</span>
        </label>
        <label className="mrq-settings-checkbox">
          <input
            type="checkbox"
            checked={settings.showSampleTechInfo}
            onChange={(e) => onChange({ showSampleTechInfo: e.target.checked })}
          />
          Mostrar informações técnicas dos samples
        </label>
        <label className="mrq-settings-checkbox">
          <input type="checkbox" checked={settings.enablePreview} onChange={(e) => onChange({ enablePreview: e.target.checked })} />
          Habilitar pré-escuta (quando suportada)
        </label>
      </SettingsSection>

      <SettingsSection title="D. Grupos & zonas">
        <div className="mrq-settings-row">
          <button className="btn ghost small" onClick={onExpandAllGroups}>
            Expandir todos os grupos
          </button>
          <button className="btn ghost small" onClick={onCollapseAllGroups}>
            Recolher todos os grupos
          </button>
        </div>
        {treeExpanded !== null && (
          <p className="mrq-tab-hint" style={{ margin: '2px 0 0' }}>
            {treeExpanded.size === 0 ? 'Tudo recolhido na árvore.' : `${treeExpanded.size} nó(s) expandido(s) na árvore.`}
          </p>
        )}
        <div className="mrq-settings-row">
          <span>Filtrar por grupo</span>
          <select value={settings.filterGroupName ?? ''} onChange={(e) => onChange({ filterGroupName: e.target.value || null })}>
            <option value="">Todos os grupos</option>
            {groupNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div className="mrq-settings-row">
          <span>Filtrar por faixa de notas</span>
          <input
            type="number"
            min={0}
            max={127}
            placeholder="min"
            value={settings.filterNoteLo ?? ''}
            onChange={(e) => onChange({ filterNoteLo: numOrNull(e.target.value) })}
          />
          <input
            type="number"
            min={0}
            max={127}
            placeholder="max"
            value={settings.filterNoteHi ?? ''}
            onChange={(e) => onChange({ filterNoteHi: numOrNull(e.target.value) })}
          />
        </div>
        <div className="mrq-settings-row">
          <span>Filtrar por velocity</span>
          <input
            type="number"
            min={0}
            max={127}
            placeholder="min"
            value={settings.filterVelLo ?? ''}
            onChange={(e) => onChange({ filterVelLo: numOrNull(e.target.value) })}
          />
          <input
            type="number"
            min={0}
            max={127}
            placeholder="max"
            value={settings.filterVelHi ?? ''}
            onChange={(e) => onChange({ filterVelHi: numOrNull(e.target.value) })}
          />
        </div>
        {(settings.filterGroupName || settings.filterNoteLo !== null || settings.filterNoteHi !== null || settings.filterVelLo !== null || settings.filterVelHi !== null) && (
          <button
            className="btn ghost small"
            onClick={() => onChange({ filterGroupName: null, filterNoteLo: null, filterNoteHi: null, filterVelLo: null, filterVelHi: null })}
          >
            Limpar filtros
          </button>
        )}
      </SettingsSection>

      <SettingsSection title="E. Comparação">
        <p className="mrq-tab-hint" style={{ margin: 0 }}>
          {compareAvailable
            ? 'A aba "Comparar" já está habilitada (este instrumento tem um .mrq gerado de verdade pra comparar).'
            : 'A aba "Comparar" só habilita depois de gerar o .mrq — não existe dado real pra comparar antes disso.'}
        </p>
        <label className="mrq-settings-checkbox">
          <input
            type="checkbox"
            checked={settings.compareShowOnlyDiffs}
            onChange={(e) => onChange({ compareShowOnlyDiffs: e.target.checked, })}
            disabled={!compareAvailable}
          />
          Mostrar somente diferenças
        </label>
        <label className="mrq-settings-checkbox">
          <input
            type="checkbox"
            checked={!settings.compareShowOnlyDiffs}
            onChange={(e) => onChange({ compareShowOnlyDiffs: !e.target.checked })}
            disabled={!compareAvailable}
          />
          Mostrar todos os parâmetros
        </label>
        <label className="mrq-settings-checkbox">
          <input
            type="checkbox"
            checked={settings.compareHighlightCompat}
            onChange={(e) => onChange({ compareHighlightCompat: e.target.checked })}
            disabled={!compareAvailable}
          />
          Destacar preservado/aproximado/não suportado
        </label>
      </SettingsSection>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1. Visão geral
// ---------------------------------------------------------------------------
function OverviewTab({ source, flatZones }: { source: AnalyzerSource; flatZones: FlatZone[] }) {
  const presetCount = source.instrument.presets.length;
  const groupCount = source.instrument.presets.reduce((n, p) => n + p.groups.length, 0);
  const zoneCount = flatZones.length;
  const uniqueSampleIds = useMemo(() => new Set(flatZones.map((fz) => fz.zone.sampleId)), [flatZones]);

  const loKeys = flatZones.map((fz) => fz.zone.loKey);
  const hiKeys = flatZones.map((fz) => fz.zone.hiKey);
  const loVels = flatZones.map((fz) => fz.zone.loVel);
  const hiVels = flatZones.map((fz) => fz.zone.hiVel);
  const noteRange = loKeys.length ? `${midiNoteLabel(Math.min(...loKeys))} – ${midiNoteLabel(Math.max(...hiKeys))}` : 'não informado';
  const velRange = loVels.length ? `${Math.min(...loVels)} – ${Math.max(...hiVels)}` : 'não informado';

  const sampleEntries = source.converted?.metadata.samples ?? null;
  let audioProfile = 'disponível após a conversão';
  if (sampleEntries && sampleEntries.length > 0) {
    const rates = new Set(sampleEntries.map((s) => s.sampleRateHz));
    const bits = new Set(sampleEntries.map((s) => s.bitsPerSampleEncoded));
    const chans = new Set(sampleEntries.map((s) => s.channels));
    const rateLabel = rates.size === 1 ? `${[...rates][0]} Hz` : `variado (${[...rates].sort((a, b) => a - b).join('/')} Hz)`;
    const bitsLabel = bits.size === 1 ? `${[...bits][0]} bits` : `variado (${[...bits].sort((a, b) => a - b).join('/')} bits)`;
    const chanLabel = chans.size === 1 ? ([...chans][0] === 1 ? 'mono' : [...chans][0] === 2 ? 'estéreo' : `${[...chans][0]} canais`) : 'variado';
    audioProfile = `${rateLabel} · ${bitsLabel} · ${chanLabel}`;
  }

  return (
    <div className="mrq-overview">
      <div className="mrq-overview-header">
        <h3>{source.instrument.name || source.label}</h3>
        <span className="mrq-badge">{SOURCE_FORMAT_LABELS[source.instrument.sourceFormat] ?? source.sourceFormatLabel}</span>
      </div>
      <div className="mrq-card-grid">
        <InfoCard label="Presets" value={String(presetCount)} />
        <InfoCard label="Grupos" value={String(groupCount)} />
        <InfoCard label="Zonas" value={String(zoneCount)} />
        <InfoCard label="Amostras únicas" value={String(uniqueSampleIds.size)} />
        <InfoCard label="Faixa de notas" value={noteRange} />
        <InfoCard label="Faixa de velocity" value={velRange} />
        <InfoCard label="Perfil de áudio" value={audioProfile} wide={audioProfile.length > 18} />
        <InfoCard label="Importado em" value={new Date(source.instrument.importedAt).toLocaleString('pt-BR')} wide />
      </div>
      {source.instrument.midi && (
        <div className="mrq-overview-section">
          <h4>Configuração MIDI</h4>
          <div className="mrq-card-grid">
            {source.instrument.midi.pitchBendRangeSemitones !== undefined && (
              <InfoCard label="Pitch bend" value={`±${source.instrument.midi.pitchBendRangeSemitones} semitons`} />
            )}
            {source.instrument.midi.defaultChannel !== undefined && (
              <InfoCard label="Canal padrão" value={String(source.instrument.midi.defaultChannel)} />
            )}
            {source.instrument.midi.transposeSemitones !== undefined && (
              <InfoCard label="Transposição" value={`${source.instrument.midi.transposeSemitones} semitons`} />
            )}
          </div>
        </div>
      )}
      {!source.converted && (
        <div className="mrq-hint">
          <Info size={14} />
          <span>Converta este item para ver a forma de onda real das amostras e comparar com o original gerado.</span>
        </div>
      )}
    </div>
  );
}

function InfoCard({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={`mrq-info-card ${wide ? 'wide' : ''}`}>
      <div className="mrq-info-card-label">{label}</div>
      <div className="mrq-info-card-value">{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2. Teclado (mapa de teclas 88 teclas, A0..C8)
// ---------------------------------------------------------------------------
const WHITE_PITCH_CLASSES = new Set([0, 2, 4, 5, 7, 9, 11]);
const KEY_LO = 21; // A0
const KEY_HI = 108; // C8
const WHITE_W = 14;
const BLACK_W = 9;
const WHITE_H = 72;
const BLACK_H = 44;

function isWhiteKey(note: number): boolean {
  return WHITE_PITCH_CLASSES.has(((note % 12) + 12) % 12);
}

function KeyboardTab({
  flatZones,
  selectedZoneKey,
  onSelectZone,
  settings,
}: {
  flatZones: FlatZone[];
  selectedZoneKey: string | null;
  onSelectZone: (key: string | null) => void;
  settings: AnalyzerViewSettings;
}) {
  const [selectedNote, setSelectedNote] = useState<number | null>(null);
  const zoom = settings.keyboardZoom;
  const whiteW = WHITE_W * zoom;
  const blackW = BLACK_W * zoom;
  const whiteH = WHITE_H * zoom;
  const blackH = BLACK_H * zoom;

  const keyLayout = useMemo(() => {
    let whiteIndex = 0;
    const layout: { note: number; white: boolean; x: number }[] = [];
    for (let note = KEY_LO; note <= KEY_HI; note += 1) {
      if (isWhiteKey(note)) {
        layout.push({ note, white: true, x: whiteIndex * whiteW });
        whiteIndex += 1;
      } else {
        layout.push({ note, white: false, x: whiteIndex * whiteW - blackW / 2 });
      }
    }
    return layout;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whiteW, blackW]);
  const totalWidth = keyLayout.filter((k) => k.white).length * whiteW;

  const zonesAtNote = (note: number) => flatZones.filter((fz) => note >= fz.zone.loKey && note <= fz.zone.hiKey);
  const selectedZone = flatZones.find((fz) => fz.key === selectedZoneKey) ?? null;
  const notePanel = selectedNote !== null ? zonesAtNote(selectedNote) : [];

  // "Divisão entre grupos": uma linha mais grossa sempre que a tecla
  // anterior pertence a um grupo diferente (ou não tem zona nenhuma) — só
  // olha pro primeiro grupo que cobre cada tecla, é uma pista visual, não
  // um dado novo.
  function groupBoundary(note: number): boolean {
    if (!settings.showGroupDividers) return false;
    const here = zonesAtNote(note)[0]?.group.id ?? null;
    const prev = zonesAtNote(note - 1)[0]?.group.id ?? null;
    return here !== prev;
  }

  return (
    <div className="mrq-keyboard-tab">
      <p className="mrq-tab-hint">
        Cada tecla mostra a cobertura real das zonas do instrumento. Clique numa tecla para ver quais zonas respondem a
        ela; marcas na base indicam a nota raiz (<em>root key</em>) de uma zona.
      </p>
      <div className="mrq-keyboard-scroll">
        <svg width={totalWidth + 2} height={whiteH + 2} className="mrq-keyboard-svg">
          {keyLayout
            .filter((k) => k.white)
            .map((k) => {
              const zones = zonesAtNote(k.note);
              const overlap = settings.showOverlaps && zones.length > 1;
              const fill = zones.length === 0 ? 'var(--bg-2)' : overlap ? 'url(#mrq-overlap-hatch)' : groupColor(zones[0].group.id);
              const inSelected =
                settings.showZoneRegions && !!selectedZone && k.note >= selectedZone.zone.loKey && k.note <= selectedZone.zone.hiKey;
              return (
                <g key={k.note} onClick={() => setSelectedNote(k.note)} className="mrq-key-hit">
                  <rect
                    x={k.x}
                    y={0}
                    width={whiteW - 1}
                    height={whiteH}
                    fill={fill}
                    opacity={zones.length === 0 ? 1 : 0.85}
                    stroke={inSelected ? '#22d3ee' : groupBoundary(k.note) ? '#f2a93b' : 'var(--border)'}
                    strokeWidth={inSelected ? 2 : groupBoundary(k.note) ? 2 : 1}
                  />
                  {settings.showRootKeys && zones.some((z) => z.zone.rootNote === k.note) && (
                    <circle cx={k.x + (whiteW - 1) / 2} cy={whiteH - 7} r={2.4} fill="#111" />
                  )}
                  {settings.showNoteNames && k.note % 12 === 0 && (
                    <text x={k.x + 2} y={whiteH - 3} fontSize={7} fill="var(--text-2)">
                      {midiNoteName(k.note)}
                    </text>
                  )}
                  {selectedNote === k.note && <rect x={k.x} y={0} width={whiteW - 1} height={whiteH} fill="#22d3ee" opacity={0.25} />}
                </g>
              );
            })}
          {keyLayout
            .filter((k) => !k.white)
            .map((k) => {
              const zones = zonesAtNote(k.note);
              const overlap = settings.showOverlaps && zones.length > 1;
              const fill = zones.length === 0 ? '#0a0a0c' : overlap ? 'url(#mrq-overlap-hatch)' : groupColor(zones[0].group.id);
              const inSelected =
                settings.showZoneRegions && !!selectedZone && k.note >= selectedZone.zone.loKey && k.note <= selectedZone.zone.hiKey;
              return (
                <g key={k.note} onClick={() => setSelectedNote(k.note)} className="mrq-key-hit">
                  <rect
                    x={k.x}
                    y={0}
                    width={blackW}
                    height={blackH}
                    fill={fill}
                    opacity={zones.length === 0 ? 1 : 0.9}
                    stroke={inSelected ? '#22d3ee' : '#000'}
                    strokeWidth={inSelected ? 2 : 1}
                  />
                  {settings.showRootKeys && zones.some((z) => z.zone.rootNote === k.note) && (
                    <circle cx={k.x + blackW / 2} cy={blackH - 6} r={2} fill="#22d3ee" />
                  )}
                  {selectedNote === k.note && <rect x={k.x} y={0} width={blackW} height={blackH} fill="#22d3ee" opacity={0.35} />}
                </g>
              );
            })}
          <defs>
            <pattern id="mrq-overlap-hatch" width={6} height={6} patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
              <rect width={6} height={6} fill="#7a1d2b" />
              <line x1={0} y1={0} x2={0} y2={6} stroke="#ff5577" strokeWidth={2} />
            </pattern>
          </defs>
        </svg>
      </div>
      {selectedNote !== null && (
        <div className="mrq-note-panel">
          <h4>
            {midiNoteLabel(selectedNote)} — {notePanel.length} zona(s)
          </h4>
          {notePanel.length === 0 && <p className="mrq-tab-hint">Nenhuma zona cobre esta nota (buraco no mapeamento).</p>}
          <ul className="mrq-note-zone-list">
            {notePanel.map((fz) => (
              <li key={fz.key}>
                <span className="mrq-swatch" style={{ background: groupColor(fz.group.id) }} />
                <span>
                  {fz.preset.name} / {fz.group.name} — {midiNoteLabel(fz.zone.loKey)}–{midiNoteLabel(fz.zone.hiKey)}, vel {fz.zone.loVel}
                  –{fz.zone.hiVel}, root {midiNoteName(fz.zone.rootNote)}
                </span>
                <button className="btn ghost small" onClick={() => onSelectZone(fz.key)}>
                  selecionar
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. Velocity layers — faixas REAIS de velocity por zona (nunca os exemplos
//    ilustrativos 1-40/41-80/81-127).
// ---------------------------------------------------------------------------
function VelocityTab({
  flatZones,
  selectedZoneKey,
  onSelectZone,
  settings,
}: {
  flatZones: FlatZone[];
  selectedZoneKey: string | null;
  onSelectZone: (key: string | null) => void;
  settings: AnalyzerViewSettings;
}) {
  const sorted = useMemo(
    () => [...flatZones].sort((a, b) => a.zone.loKey - b.zone.loKey || a.zone.loVel - b.zone.loVel),
    [flatZones]
  );

  function overlapsWith(fz: FlatZone): FlatZone[] {
    return flatZones.filter((other) => {
      if (other.key === fz.key) return false;
      const keyOverlap = other.zone.loKey <= fz.zone.hiKey && other.zone.hiKey >= fz.zone.loKey;
      const velOverlap = other.zone.loVel <= fz.zone.hiVel && other.zone.hiVel >= fz.zone.loVel;
      return keyOverlap && velOverlap;
    });
  }

  // Cobertura agregada 0-127 (soma de TODAS as zonas, sem separar por nota)
  // — usada pelo modo "Gráfico" e pela marcação de lacunas/sobreposições.
  // É uma visão aproximada por design (o mesmo cálculo de `overlapsWith`
  // acima já ignora a nota pra achar conflito de velocity) — nunca inventa
  // nada, só soma faixas reais de zona.
  const coverage = useMemo(() => {
    const counts = new Array(128).fill(0);
    flatZones.forEach((fz) => {
      for (let v = fz.zone.loVel; v <= fz.zone.hiVel; v += 1) counts[v] += 1;
    });
    return counts;
  }, [flatZones]);
  const maxCoverage = Math.max(1, ...coverage);
  const gapCount = coverage.filter((c) => c === 0).length;
  const overlapCount = coverage.filter((c) => c > 1).length;

  if (sorted.length === 0) {
    return <p className="mrq-tab-hint">Este instrumento não tem zonas.</p>;
  }

  if (!settings.showVelocityLayers) {
    return <p className="mrq-tab-hint">Camadas de velocity ocultadas nos ajustes de visualização (⚙ Mostrar ajustes → Velocity).</p>;
  }

  return (
    <div className="mrq-velocity-tab">
      <p className="mrq-tab-hint">Cada barra mostra o intervalo de velocity real de uma zona (0–127). Zonas com conflito de velocity numa mesma nota aparecem destacadas.</p>
      <div className="mrq-velocity-scale">
        <span>0</span>
        <span>32</span>
        <span>64</span>
        <span>96</span>
        <span>127</span>
      </div>

      {settings.highlightVelocityGapsOverlaps && (
        <p className="mrq-tab-hint">
          Cobertura agregada (todas as zonas, sem separar por nota): {gapCount} valor(es) de velocity sem nenhuma zona,{' '}
          {overlapCount} valor(es) cobertos por mais de uma zona.
        </p>
      )}

      {settings.velocityViewMode === 'graph' ? (
        <div className="mrq-velocity-graph" title="Quantidade de zonas que cobrem cada valor de velocity (0–127)">
          {coverage.map((count, v) => (
            <div
              key={v}
              className={`mrq-velocity-graph-bar ${settings.highlightVelocityGapsOverlaps && count === 0 ? 'gap' : ''} ${
                settings.highlightVelocityGapsOverlaps && count > 1 ? 'overlap' : ''
              }`}
              style={{ height: `${(count / maxCoverage) * 100}%` }}
              title={`velocity ${v}: ${count} zona(s)`}
            />
          ))}
        </div>
      ) : (
        <div className="mrq-velocity-rows">
          {sorted.map((fz) => {
            const conflicts = overlapsWith(fz);
            const left = (fz.zone.loVel / 127) * 100;
            const width = Math.max(((fz.zone.hiVel - fz.zone.loVel + 1) / 127) * 100, 1.5);
            return (
              <div key={fz.key} className={`mrq-velocity-row ${selectedZoneKey === fz.key ? 'selected' : ''}`} onClick={() => onSelectZone(fz.key)}>
                <div className="mrq-velocity-row-label">
                  {fz.preset.name} / {fz.group.name} · {midiNoteLabel(fz.zone.loKey)}–{midiNoteLabel(fz.zone.hiKey)}
                </div>
                <div className="mrq-velocity-track">
                  <div
                    className={`mrq-velocity-bar ${settings.highlightVelocityGapsOverlaps && conflicts.length ? 'conflict' : ''}`}
                    style={{ left: `${left}%`, width: `${width}%`, background: groupColor(fz.group.id) }}
                    title={`velocity ${fz.zone.loVel}-${fz.zone.hiVel}`}
                  />
                </div>
                {settings.showVelocityMinMax && (
                  <div className="mrq-velocity-row-value">
                    {fz.zone.loVel}–{fz.zone.hiVel}
                    {settings.highlightVelocityGapsOverlaps && conflicts.length > 0 && (
                      <span className="mrq-conflict-badge" title={`sobrepõe ${conflicts.length} outra(s) zona(s) na mesma nota`}>
                        ⚠ {conflicts.length}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. Grupos & zonas — árvore expansível
// ---------------------------------------------------------------------------
function TreeTab({
  instrument,
  selectedZoneKey,
  onSelectZone,
  selectedFlatZone,
  converted,
  settings,
  expanded: expandedProp,
  onExpandedChange,
}: {
  instrument: MrqInstrumentModel;
  selectedZoneKey: string | null;
  onSelectZone: (key: string | null) => void;
  selectedFlatZone: FlatZone | null;
  converted?: AnalyzerConvertedInfo;
  settings: AnalyzerViewSettings;
  expanded: Set<string> | null;
  onExpandedChange: (next: Set<string>) => void;
}) {
  // `null` = ainda não houve nenhuma ação explícita de expandir/recolher
  // (nem pelo painel de ajustes, nem clicando na árvore) — nesse caso o
  // padrão é só os presets abertos, igual ao comportamento original.
  const expanded = expandedProp ?? new Set(instrument.presets.map((p) => p.id));
  const toggle = (id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onExpandedChange(next);
  };

  function zoneMatchesFilter(zone: MrqZone): boolean {
    if (settings.filterNoteLo !== null && zone.hiKey < settings.filterNoteLo) return false;
    if (settings.filterNoteHi !== null && zone.loKey > settings.filterNoteHi) return false;
    if (settings.filterVelLo !== null && zone.hiVel < settings.filterVelLo) return false;
    if (settings.filterVelHi !== null && zone.loVel > settings.filterVelHi) return false;
    return true;
  }
  const filterActive =
    !!settings.filterGroupName || settings.filterNoteLo !== null || settings.filterNoteHi !== null || settings.filterVelLo !== null || settings.filterVelHi !== null;

  return (
    <div className="mrq-tree-tab">
      <div className="mrq-tree-col">
        {filterActive && (
          <p className="mrq-tab-hint">Filtro de visualização ativo (ver ⚙ Mostrar ajustes → Grupos &amp; zonas) — não altera o instrumento, só o que aparece aqui.</p>
        )}
        <ul className="mrq-tree-list">
          {instrument.presets.map((preset) => (
            <li key={preset.id}>
              <div className="mrq-tree-row" onClick={() => toggle(preset.id)}>
                {expanded.has(preset.id) ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <ListTree size={13} />
                <span>
                  {preset.name} <em>({preset.groups.length} grupo(s))</em>
                </span>
              </div>
              {expanded.has(preset.id) && (
                <ul className="mrq-tree-list nested">
                  {preset.groups
                    .filter((group) => !settings.filterGroupName || group.name === settings.filterGroupName)
                    .map((group) => {
                      const groupKey = `${preset.id}::${group.id}`;
                      const visibleZones = group.zones
                        .map((zone, zi) => ({ zone, zi }))
                        .filter(({ zone }) => zoneMatchesFilter(zone));
                      if (filterActive && visibleZones.length === 0) return null;
                      return (
                        <li key={group.id}>
                          <div className="mrq-tree-row" onClick={() => toggle(groupKey)}>
                            {expanded.has(groupKey) ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                            <span className="mrq-swatch" style={{ background: groupColor(group.id) }} />
                            <span>
                              {group.name} <em>({visibleZones.length} de {group.zones.length} zona(s))</em>
                            </span>
                          </div>
                          {expanded.has(groupKey) && (
                            <ul className="mrq-tree-list nested">
                              {visibleZones.map(({ zone, zi }) => {
                                const key = `${preset.id}::${group.id}::${zi}`;
                                return (
                                  <li key={key}>
                                    <div
                                      className={`mrq-tree-row leaf ${selectedZoneKey === key ? 'selected' : ''}`}
                                      onClick={() => onSelectZone(key)}
                                    >
                                      <Circle size={8} fill={groupColor(group.id)} stroke="none" />
                                      <span>
                                        {midiNoteLabel(zone.loKey)}–{midiNoteLabel(zone.hiKey)} · vel {zone.loVel}-{zone.hiVel} · amostra{' '}
                                        <code>{zone.sampleId}</code>
                                      </span>
                                    </div>
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </li>
                      );
                    })}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </div>
      <div className="mrq-tree-detail">
        {selectedFlatZone ? (
          <ZoneDetail flatZone={selectedFlatZone} converted={converted} />
        ) : (
          <p className="mrq-tab-hint">Selecione uma zona na árvore para ver todos os parâmetros dela.</p>
        )}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div className="mrq-field">
      <span className="mrq-field-label">{label}</span>
      <span className="mrq-field-value">{value}</span>
    </div>
  );
}

function ZoneDetail({ flatZone, converted }: { flatZone: FlatZone; converted?: AnalyzerConvertedInfo }) {
  const { zone, group, preset } = flatZone;
  const [showAdjustments, setShowAdjustments] = useState(false);

  // Reseta o painel de ajustes ao trocar de zona selecionada — evita abrir
  // a zona errada "herdada" de uma seleção anterior.
  useEffect(() => setShowAdjustments(false), [flatZone.key]);

  return (
    <div className="mrq-zone-detail">
      <div className="mrq-zone-detail-header">
        <h4>
          {preset.name} / {group.name}
        </h4>
        {/* Nome deliberadamente diferente do botão global "Mostrar ajustes" do
            cabeçalho do Analyzer (ver AnalyzerSettingsPanel) — este aqui abre
            o mapeamento/forma de onda de UMA zona específica, não as
            preferências de visualização do Analyzer inteiro. */}
        <button className="mrq-adjustments-btn" onClick={() => setShowAdjustments(true)} title="Abrir visão de edição (mapeamento + forma de onda) desta zona">
          <Sliders size={13} /> Ver mapeamento da zona
        </button>
      </div>
      {showAdjustments && <ZoneAdjustmentsOverlay flatZone={flatZone} converted={converted} onClose={() => setShowAdjustments(false)} />}
      <Field label="Amostra" value={zone.sampleId} />
      <Field label="Nota raiz" value={midiNoteLabel(zone.rootNote)} />
      <Field label="Faixa de notas" value={`${midiNoteLabel(zone.loKey)} – ${midiNoteLabel(zone.hiKey)}`} />
      <Field label="Faixa de velocity" value={`${zone.loVel} – ${zone.hiVel}`} />
      <Field label="Afinação (cents)" value={zone.tuneCents} />
      <Field label="Volume (dB)" value={zone.volumeDb} />
      <Field label="Pan" value={zone.pan} />
      <Field label="Estéreo" value={zone.stereo} />
      <Field label="Grupo de exclusividade" value={zone.exclusiveGroup} />
      <Field label="Round robin" value={zone.roundRobinGroup ? `${zone.roundRobinGroup} #${zone.roundRobinIndex ?? '?'}` : undefined} />
      <Field label="Loop habilitado" value={zone.loopEnabled === undefined ? undefined : zone.loopEnabled ? 'sim' : 'não'} />
      <Field label="Loop início (quadros)" value={zone.loopStart} />
      <Field label="Loop fim (quadros)" value={zone.loopEnd} />
      {zone.envelope && (
        <>
          <h5>Envelope (da zona)</h5>
          <Field label="Attack" value={zone.envelope.attack} />
          <Field label="Hold" value={zone.envelope.hold} />
          <Field label="Decay" value={zone.envelope.decay} />
          <Field label="Sustain" value={zone.envelope.sustain} />
          <Field label="Release" value={zone.envelope.release} />
        </>
      )}
      {zone.filter && (
        <>
          <h5>Filtro (da zona)</h5>
          <Field label="Tipo" value={zone.filter.filterType} />
          <Field label="Cutoff (Hz)" value={zone.filter.cutoffHz} />
          <Field label="Resonância" value={zone.filter.resonance} />
        </>
      )}
      {(group.envelope || group.filter || (group.modulation && group.modulation.length > 0)) && (
        <>
          <h5>Herdado do grupo "{group.name}"</h5>
          {group.envelope && (
            <Field
              label="Envelope do grupo"
              value={`A${group.envelope.attack} D${group.envelope.decay} S${group.envelope.sustain} R${group.envelope.release}`}
            />
          )}
          {group.filter && <Field label="Filtro do grupo" value={`${group.filter.filterType} @ ${group.filter.cutoffHz} Hz`} />}
          {group.modulation?.map((m, i) => (
            <Field key={i} label={`Modulação ${i + 1}`} value={`${m.source} → ${m.destination} (${m.amount})`} />
          ))}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4b. "Mostrar ajustes" — visão combinada ao estilo editor de sampler
//    (mapeamento + zona/forma de onda), inspirada no mapping/zone editor de
//    referência enviado pelo usuário. É só uma reorganização visual de dados
//    que já existem no .mrq + no PCM decodificado: nenhum campo novo é
//    inventado. Em particular, o modelo MrqZone NÃO tem fade-in/fade-out,
//    crossfade nem modo de loop (forward/reverse/alternate) — por isso essa
//    visão deliberadamente NÃO mostra essas linhas (mostrar "0" ou "Forward"
//    sem o dado existir seria inventar parâmetro, o que é proibido no projeto).
// ---------------------------------------------------------------------------
function ZoneAdjustmentsOverlay({
  flatZone,
  converted,
  onClose,
}: {
  flatZone: FlatZone;
  converted?: AnalyzerConvertedInfo;
  onClose: () => void;
}) {
  const { zone, group, preset } = flatZone;
  const [decoded, setDecoded] = useState<MrqDecodedSample | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);

  useEffect(() => {
    setDecoded(null);
    setLoadError(null);
    setPlaying(false);
    if (!converted) return;
    let cancelled = false;
    setLoading(true);
    mrqExtractSample(converted.path, zone.sampleId)
      .then((d) => {
        if (!cancelled) setDecoded(d);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [converted, zone.sampleId]);

  useEffect(() => {
    if (!decoded || !canvasRef.current) return;
    drawWaveform(canvasRef.current, decoded, zone.loopStart ?? null, zone.loopEnd ?? null);
  }, [decoded, zone.loopStart, zone.loopEnd]);

  useEffect(() => stopPlayback, []);

  function stopPlayback() {
    try {
      sourceNodeRef.current?.stop();
    } catch {
      /* já parado */
    }
    sourceNodeRef.current = null;
    setPlaying(false);
  }

  async function togglePlay() {
    if (!decoded) return;
    if (playing) {
      stopPlayback();
      return;
    }
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
  }

  const frameCount = decoded ? decoded.interleaved.length / decoded.channels : null;
  const durationSec = decoded && frameCount ? frameCount / decoded.sampleRateHz : null;
  const hasLoop = zone.loopEnabled && zone.loopStart !== undefined && zone.loopEnd !== undefined;

  return (
    <div className="mrq-adjustments-overlay" onClick={onClose}>
      <div className="mrq-adjustments-panel" onClick={(e) => e.stopPropagation()}>
        <div className="mrq-adjustments-header">
          <span>
            Ajustes — {preset.name} / {group.name} <code>{zone.sampleId}</code>
          </span>
          <button className="mrq-adjustments-close" onClick={onClose} title="Fechar">
            <X size={16} />
          </button>
        </div>

        {/* Barra de mapeamento (equivalente ao topo da imagem de referência) */}
        <div className="mrq-adjustments-mapping-row">
          <span className="mrq-adjustments-chip">Vol {zone.volumeDb} dB</span>
          <span className="mrq-adjustments-chip">Pan {zone.pan}</span>
          <span className="mrq-adjustments-chip">
            Notas {midiNoteLabel(zone.loKey)}–{midiNoteLabel(zone.hiKey)}
          </span>
          <span className="mrq-adjustments-chip">
            Velocity {zone.loVel}–{zone.hiVel}
          </span>
          <span className="mrq-adjustments-chip">Raiz {midiNoteLabel(zone.rootNote)}</span>
          <span className="mrq-adjustments-chip">Tune {zone.tuneCents}¢</span>
          {zone.stereo && <span className="mrq-adjustments-chip">Estéreo</span>}
          {zone.exclusiveGroup && <span className="mrq-adjustments-chip">Grupo excl. {zone.exclusiveGroup}</span>}
        </div>

        {/* Zona / forma de onda (equivalente ao editor inferior da imagem de referência) */}
        <div className="mrq-adjustments-zone">
          {!converted && (
            <p className="mrq-tab-hint">Converta este instrumento para ver a forma de onda real e tocar esta zona (os quadros PCM vêm decodificados pelo backend Rust, não pelo navegador).</p>
          )}
          {converted && loading && (
            <div className="mrq-tab-hint">
              <Loader2 size={14} className="mrq-spin" /> decodificando amostra…
            </div>
          )}
          {converted && loadError && <p className="mrq-error-text">Falha ao decodificar: {loadError}</p>}
          {converted && decoded && (
            <>
              <canvas ref={canvasRef} width={760} height={140} className="mrq-waveform-canvas" />
              <div className="mrq-sample-controls">
                <button className="btn primary small" onClick={() => void togglePlay()}>
                  {playing ? <Pause size={13} /> : <Play size={13} />} {playing ? 'Parar' : 'Tocar'}
                </button>
                <span className="mrq-sample-meta">
                  {durationSec !== null ? `${durationSec.toFixed(2)}s` : ''} · {decoded.sampleRateHz} Hz · {decoded.channels === 1 ? 'mono' : decoded.channels === 2 ? 'estéreo' : `${decoded.channels}ch`}
                </span>
              </div>
              <div className="mrq-adjustments-fields">
                <Field label="Início da amostra (quadro)" value={0} />
                <Field label="Fim da amostra (quadro)" value={frameCount !== null ? frameCount - 1 : null} />
                <Field label="Duração (quadros)" value={frameCount} />
                {hasLoop ? (
                  <>
                    <Field label="Loop início (quadro)" value={zone.loopStart} />
                    <Field label="Loop fim (quadro)" value={zone.loopEnd} />
                    <Field label="Loop duração (quadros)" value={(zone.loopEnd as number) - (zone.loopStart as number)} />
                  </>
                ) : (
                  <Field label="Loop" value="sem loop definido" />
                )}
              </div>
            </>
          )}
        </div>

        <p className="mrq-tab-hint mrq-adjustments-note">
          <Info size={12} /> Fade In/Out, Crossfade e Modo de loop (Forward/Reverse/Alternate) não existem no modelo <code>.mrq</code> atual — por isso não aparecem aqui. Mostrar valores inventados para esses campos violaria a política do
          projeto de nunca exibir dados que não vieram do arquivo de origem.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 5. Amostras — lista + forma de onda real (só pós-conversão, via
//    mrqExtractSample, que já devolve PCM decodificado pelo backend Rust).
// ---------------------------------------------------------------------------
function SamplesTab({
  flatZones,
  converted,
  settings,
}: {
  flatZones: FlatZone[];
  converted?: AnalyzerConvertedInfo;
  settings: AnalyzerViewSettings;
}) {
  const uniqueSamples = useMemo(() => {
    const map = new Map<string, FlatZone[]>();
    flatZones.forEach((fz) => {
      const list = map.get(fz.zone.sampleId) ?? [];
      list.push(fz);
      map.set(fz.zone.sampleId, list);
    });
    return [...map.entries()];
  }, [flatZones]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [decoded, setDecoded] = useState<MrqDecodedSample | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);

  useEffect(() => {
    setDecoded(null);
    setLoadError(null);
    setPlaying(false);
  }, [selectedId, converted?.path]);

  useEffect(() => {
    if (!decoded || !canvasRef.current || !settings.showWaveform) return;
    drawWaveform(canvasRef.current, decoded, null, null);
  }, [decoded, settings.showWaveform, settings.waveformZoom]);

  async function loadSample(sampleId: string) {
    setSelectedId(sampleId);
    if (!converted) return;
    setLoading(true);
    setLoadError(null);
    try {
      const d = await mrqExtractSample(converted.path, sampleId);
      setDecoded(d);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function stopPlayback() {
    try {
      sourceNodeRef.current?.stop();
    } catch {
      /* já parado */
    }
    sourceNodeRef.current = null;
    setPlaying(false);
  }

  async function togglePlay() {
    if (!decoded) return;
    if (playing) {
      stopPlayback();
      return;
    }
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
  }

  const entry = converted?.metadata.samples.find((s) => s.id === selectedId) ?? null;

  return (
    <div className="mrq-samples-tab">
      <div className="mrq-samples-list">
        {uniqueSamples.map(([sampleId, zones]) => {
          const idxEntry = converted?.metadata.samples.find((s) => s.id === sampleId);
          return (
            <div
              key={sampleId}
              className={`mrq-sample-row ${selectedId === sampleId ? 'selected' : ''}`}
              onClick={() => void loadSample(sampleId)}
            >
              <code>{sampleId}</code>
              {settings.showSampleTechInfo && (
                <span className="mrq-sample-meta">
                  {zones.length} zona(s)
                  {idxEntry ? ` · ${idxEntry.sampleRateHz} Hz · ${idxEntry.bitsPerSampleEncoded} bits · ${idxEntry.channels === 1 ? 'mono' : idxEntry.channels === 2 ? 'estéreo' : `${idxEntry.channels}ch`} · ${idxEntry.codec} · ${formatBytes(idxEntry.length)}` : ' · metadados completos após a conversão'}
                </span>
              )}
            </div>
          );
        })}
        {uniqueSamples.length === 0 && <p className="mrq-tab-hint">Nenhuma amostra referenciada.</p>}
      </div>
      <div className="mrq-sample-preview">
        {!converted && <p className="mrq-tab-hint">Converta este instrumento para ver a forma de onda real e tocar a amostra (os quadros PCM vêm decodificados pelo backend Rust, não pelo navegador).</p>}
        {converted && !selectedId && <p className="mrq-tab-hint">Selecione uma amostra na lista.</p>}
        {converted && selectedId && loading && (
          <div className="mrq-tab-hint">
            <Loader2 size={14} className="mrq-spin" /> decodificando amostra…
          </div>
        )}
        {converted && loadError && <p className="mrq-error-text">Falha ao decodificar: {loadError}</p>}
        {converted && decoded && (
          <>
            {settings.showWaveform ? (
              <div className="mrq-waveform-scroll">
                <canvas ref={canvasRef} width={520 * settings.waveformZoom} height={120} className="mrq-waveform-canvas" />
              </div>
            ) : (
              <p className="mrq-tab-hint">Waveform ocultada nos ajustes de visualização (⚙ Mostrar ajustes → Amostras).</p>
            )}
            <div className="mrq-sample-controls">
              <button className="btn primary small" disabled={!settings.enablePreview} onClick={() => void togglePlay()}>
                {playing ? <Pause size={13} /> : <Play size={13} />} {playing ? 'Parar' : 'Tocar'}
              </button>
              {entry && settings.showSampleTechInfo && (
                <span className="mrq-sample-meta">
                  {(decoded.interleaved.length / decoded.channels / decoded.sampleRateHz).toFixed(2)}s · sha256 {entry.sha256.slice(0, 12)}…
                  {entry.convertedFromFloat32 ? ' · convertido de float32' : ''}
                  {entry.bitsPerSampleOriginal ? ` · original ${entry.bitsPerSampleOriginal} bits` : ''}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function drawWaveform(canvas: HTMLCanvasElement, decoded: MrqDecodedSample, loopStart: number | null, loopEnd: number | null) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0a0b0e';
  ctx.fillRect(0, 0, w, h);
  const frameCount = decoded.interleaved.length / decoded.channels;
  if (frameCount <= 0) return;
  const src = decoded.interleaved instanceof Float32Array ? decoded.interleaved : Float32Array.from(decoded.interleaved);
  const buckets = Math.min(w, 1024);
  const framesPerBucket = Math.max(1, Math.floor(frameCount / buckets));
  ctx.strokeStyle = '#22d3ee';
  ctx.lineWidth = 1;
  const mid = h / 2;
  for (let b = 0; b < buckets; b += 1) {
    let min = 1;
    let max = -1;
    const start = b * framesPerBucket;
    const end = Math.min(frameCount, start + framesPerBucket);
    for (let f = start; f < end; f += 1) {
      let sum = 0;
      for (let ch = 0; ch < decoded.channels; ch += 1) sum += src[f * decoded.channels + ch];
      const v = sum / decoded.channels;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const x = (b / buckets) * w;
    ctx.beginPath();
    ctx.moveTo(x, mid + min * mid);
    ctx.lineTo(x, mid + max * mid);
    ctx.stroke();
  }
  if (loopStart !== null && loopEnd !== null && loopEnd > loopStart) {
    const x1 = (loopStart / frameCount) * w;
    const x2 = (loopEnd / frameCount) * w;
    ctx.fillStyle = 'rgba(242, 169, 59, 0.18)';
    ctx.fillRect(x1, 0, x2 - x1, h);
    ctx.strokeStyle = '#f2a93b';
    ctx.beginPath();
    ctx.moveTo(x1, 0);
    ctx.lineTo(x1, h);
    ctx.moveTo(x2, 0);
    ctx.lineTo(x2, h);
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// 6. Loops — só mostra início/fim/tipo quando o formato de origem informou;
//    nunca inventa um loop pra formatos que não suportam (hoje, só SF2/SF3
//    populam esse dado — ver src-tauri/src/importers/sf2.rs).
// ---------------------------------------------------------------------------
function LoopsTab({ flatZones, converted }: { flatZones: FlatZone[]; converted?: AnalyzerConvertedInfo }) {
  const withLoop = flatZones.filter((fz) => fz.zone.loopEnabled && fz.zone.loopStart !== undefined && fz.zone.loopEnd !== undefined);
  const withoutLoop = flatZones.filter((fz) => !(fz.zone.loopEnabled && fz.zone.loopStart !== undefined && fz.zone.loopEnd !== undefined));

  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [decoded, setDecoded] = useState<MrqDecodedSample | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewZone = withLoop.find((fz) => fz.key === previewKey) ?? null;

  useEffect(() => {
    setDecoded(null);
  }, [previewKey]);

  useEffect(() => {
    if (!decoded || !canvasRef.current || !previewZone) return;
    drawWaveform(canvasRef.current, decoded, previewZone.zone.loopStart ?? null, previewZone.zone.loopEnd ?? null);
  }, [decoded, previewZone]);

  async function loadPreview(fz: FlatZone) {
    setPreviewKey(fz.key);
    if (!converted) return;
    try {
      const d = await mrqExtractSample(converted.path, fz.zone.sampleId);
      setDecoded(d);
    } catch {
      setDecoded(null);
    }
  }

  return (
    <div className="mrq-loops-tab">
      <h4>
        <Repeat size={14} /> Zonas com loop ({withLoop.length})
      </h4>
      {withLoop.length === 0 && <p className="mrq-tab-hint">Nenhuma zona deste instrumento declara loop (o formato de origem não informou pontos de loop).</p>}
      <ul className="mrq-loop-list">
        {withLoop.map((fz) => (
          <li key={fz.key} className={previewKey === fz.key ? 'selected' : ''} onClick={() => void loadPreview(fz)}>
            <span className="mrq-swatch" style={{ background: groupColor(fz.group.id) }} />
            <span>
              {fz.preset.name} / {fz.group.name} · amostra <code>{fz.zone.sampleId}</code>
            </span>
            <span className="mrq-sample-meta">
              início {fz.zone.loopStart} · fim {fz.zone.loopEnd} (quadros desde o início da amostra)
            </span>
          </li>
        ))}
      </ul>
      {previewZone && (
        <div className="mrq-sample-preview">
          {!converted && <p className="mrq-tab-hint">Converta para visualizar a região de loop sobre a forma de onda real.</p>}
          {converted && !decoded && <p className="mrq-tab-hint">Carregando forma de onda…</p>}
          {converted && decoded && <canvas ref={canvasRef} width={520} height={120} className="mrq-waveform-canvas" />}
        </div>
      )}
      <h4 className="mrq-loops-none-header">Zonas sem loop ({withoutLoop.length})</h4>
      <p className="mrq-tab-hint">{withoutLoop.length} zona(s) tocam a amostra inteira, sem repetição (sem informação de loop no formato de origem ou loop desativado).</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 7. Compatibilidade — direto do MrqCompatibilityReport que cada importador
//    já produz (Preservado / Aproximado / Não suportado).
// ---------------------------------------------------------------------------
function CompatTab({ compatibility }: { compatibility: MrqCompatibilityReport }) {
  return (
    <div className="mrq-compat-tab">
      <CompatSection title="Preservado" icon={<CheckCircle2 size={14} color="#3ecf8e" />} items={compatibility.preserved} tone="ok" />
      <CompatSection title="Aproximado" icon={<Sliders size={14} color="#f2a93b" />} items={compatibility.approximated} tone="warn" />
      <CompatSection title="Não suportado" icon={<XCircle size={14} color="#ff5577" />} items={compatibility.unsupported} tone="bad" />
      {compatibility.preserved.length + compatibility.approximated.length + compatibility.unsupported.length === 0 && (
        <p className="mrq-tab-hint">Este importador não registrou nenhuma observação de compatibilidade para este arquivo.</p>
      )}
    </div>
  );
}

function CompatSection({
  title,
  icon,
  items,
  tone,
}: {
  title: string;
  icon: React.ReactNode;
  items: { field: string; detail: string }[];
  tone: 'ok' | 'warn' | 'bad';
}) {
  return (
    <div className={`mrq-compat-section ${tone}`}>
      <h4>
        {icon} {title} ({items.length})
      </h4>
      {items.length === 0 ? (
        <p className="mrq-tab-hint">Nenhum item.</p>
      ) : (
        <ul>
          {items.map((it, i) => (
            <li key={i}>
              <strong>{it.field}</strong> — {it.detail}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 8. Comparar Original x MRQ — só habilitada com os dois lados reais (ver
//    checagem `compareEnabled` no componente principal).
// ---------------------------------------------------------------------------
function CompareRow({ label, original, generated }: { label: string; original: string | number; generated: string | number }) {
  const match = String(original) === String(generated);
  return (
    <div className="mrq-compare-row">
      <span className="mrq-compare-label">{label}</span>
      <span className="mrq-compare-value">{original}</span>
      <span className="mrq-compare-value">{generated}</span>
      {match ? <CheckCircle2 size={15} color="#3ecf8e" /> : <XCircle size={15} color="#ff5577" />}
    </div>
  );
}

function CompareTab({
  instrument,
  flatZones,
  converted,
  compatibility,
  settings,
}: {
  instrument: MrqInstrumentModel;
  flatZones: FlatZone[];
  converted: AnalyzerConvertedInfo;
  compatibility: MrqCompatibilityReport;
  settings: AnalyzerViewSettings;
}) {
  const generatedInstrument = converted.metadata.instrument;
  const generatedGroupCount = generatedInstrument.presets.reduce((n, p) => n + p.groups.length, 0);
  const generatedZoneCount = generatedInstrument.presets.reduce((n, p) => n + p.groups.reduce((m, g) => m + g.zones.length, 0), 0);
  const groupCount = instrument.presets.reduce((n, p) => n + p.groups.length, 0);
  const uniqueSampleIds = new Set(flatZones.map((fz) => fz.zone.sampleId));

  const rows: { label: string; original: string | number; generated: string | number }[] = [
    { label: 'Nome', original: instrument.name, generated: generatedInstrument.name },
    { label: 'Formato de origem', original: instrument.sourceFormat, generated: generatedInstrument.sourceFormat },
    { label: 'Presets', original: instrument.presets.length, generated: generatedInstrument.presets.length },
    { label: 'Grupos', original: groupCount, generated: generatedGroupCount },
    { label: 'Zonas', original: flatZones.length, generated: generatedZoneCount },
    { label: 'Amostras únicas referenciadas', original: uniqueSampleIds.size, generated: converted.metadata.samples.length },
    { label: 'Amostras gravadas (finish)', original: uniqueSampleIds.size, generated: converted.finish.sampleCount },
  ];
  const visibleRows = settings.compareShowOnlyDiffs ? rows.filter((r) => String(r.original) !== String(r.generated)) : rows;

  return (
    <div className="mrq-compare-tab">
      <p className="mrq-tab-hint">
        Comparação entre o modelo analisado na importação e o conteúdo relido de verdade do arquivo <code>.mrq</code> gerado
        (via <code>mrq_read_metadata</code>), para confirmar que nada foi perdido silenciosamente na gravação.
      </p>
      {settings.compareShowOnlyDiffs && visibleRows.length === 0 && (
        <p className="mrq-tab-hint">Nenhuma diferença encontrada entre o modelo analisado e o `.mrq` relido.</p>
      )}
      {visibleRows.length > 0 && (
        <>
          <div className="mrq-compare-header">
            <span />
            <span>Original (análise)</span>
            <span>Gerado (.mrq relido)</span>
            <span />
          </div>
          {visibleRows.map((r) => (
            <CompareRow key={r.label} label={r.label} original={r.original} generated={r.generated} />
          ))}
        </>
      )}
      <p className="mrq-compare-path">
        <Waves size={13} /> {converted.path}
      </p>
      {settings.compareHighlightCompat && (
        <div className="mrq-compare-compat">
          <h4>Compatibilidade (reaproveitado da aba "Compatibilidade")</h4>
          <CompatSection title="Preservado" icon={<CheckCircle2 size={14} color="#3ecf8e" />} items={compatibility.preserved} tone="ok" />
          <CompatSection title="Aproximado" icon={<Sliders size={14} color="#f2a93b" />} items={compatibility.approximated} tone="warn" />
          <CompatSection title="Não suportado" icon={<XCircle size={14} color="#ff5577" />} items={compatibility.unsupported} tone="bad" />
        </div>
      )}
    </div>
  );
}
