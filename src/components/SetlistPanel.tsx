import { useEffect, useRef, useState } from 'react';
import { Download, FileText, History, Trash2, Upload } from 'lucide-react';
import type { Scene } from '../../shared/types';
import { useStore } from '../state/useStore';

/**
 * Baixa, de uma faixa de áudio, só os bytes (sem decodificar nada) — "esquenta"
 * o cache de disco/SO pra quando o engine for de fato carregar e decodificar
 * essa música, reduzindo a espera percebida ao trocar pra próxima música de
 * uma cena ao vivo. Silencioso: qualquer falha aqui é só uma otimização
 * perdida, nunca deve incomodar o operador com um erro.
 */
async function prefetchSongFiles(songId: string) {
  const song = useStore.getState().library.songs.find((s) => s.id === songId);
  if (!song) return;
  for (const track of song.tracks) {
    try {
      const url = await window.api.fs.toFileUrl(track.filePath);
      await fetch(url);
    } catch {
      /* apenas uma otimização, ignora falhas */
    }
  }
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function fmtDuration(sec: number): string {
  if (!sec || sec <= 0) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Gera uma "folha de roteiro" (gig sheet) em HTML autônomo (sem dependências
 * externas, tudo inline) pra imprimir ou salvar como PDF — novidade pedida
 * pelo usuário ("ferramentas novas"). Em vez de depender de alguma biblioteca
 * de PDF (risco extra de dependência pra um recurso simples), geramos um
 * .html autossuficiente: o operador abre no navegador e usa Ctrl+P /
 * "Salvar como PDF" do próprio navegador — funciona em qualquer SO sem
 * precisar instalar nada a mais. Mostra ordem, tom, BPM, duração e as
 * anotações da música, já numerados pra colar na estante do músico.
 */
function buildGigSheetHtml(scene: Scene, songs: ReturnType<typeof useStore.getState>['library']['songs']): string {
  const rows = scene.items.map((item, i) => {
    const song = songs.find((s) => s.id === item.songId);
    if (!song) return '';
    const notes = song.notes?.trim() ? escapeHtml(song.notes.trim()) : '';
    return `
      <tr>
        <td class="num">${i + 1}</td>
        <td class="title">${escapeHtml(song.title)}</td>
        <td>${escapeHtml(item.key)}</td>
        <td>${item.bpm}</td>
        <td>${fmtDuration(song.durationSec)}</td>
        <td class="notes">${notes}</td>
      </tr>`;
  }).join('');
  const totalSec = scene.items.reduce((acc, item) => {
    const song = songs.find((s) => s.id === item.songId);
    return acc + (song?.durationSec ?? 0);
  }, 0);
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<title>Roteiro — ${escapeHtml(scene.name)}</title>
<style>
  @page { size: A4; margin: 16mm; }
  body { font-family: -apple-system, 'Segoe UI', Arial, sans-serif; color: #111; margin: 0; padding: 24px; }
  h1 { font-size: 22px; margin: 0 0 2px; }
  .sub { color: #555; font-size: 13px; margin-bottom: 18px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border-bottom: 1px solid #ddd; padding: 8px 10px; text-align: left; font-size: 14px; vertical-align: top; }
  th { background: #f0f0f0; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #444; }
  td.num { font-weight: 700; width: 28px; }
  td.title { font-weight: 600; }
  td.notes { color: #555; font-size: 12.5px; max-width: 220px; }
  .footer { margin-top: 18px; font-size: 12px; color: #777; }
  @media print { .no-print { display: none; } }
  .no-print { margin-top: 20px; }
  .no-print button { font-size: 13px; padding: 8px 14px; cursor: pointer; }
</style>
</head>
<body>
  <h1>${escapeHtml(scene.name)}</h1>
  <div class="sub">Roteiro gerado pelo MRQ · Multitracks Play em ${new Date().toLocaleString('pt-BR')} · ${scene.items.length} música(s) · duração total ≈ ${fmtDuration(totalSec)}</div>
  <table>
    <thead><tr><th>#</th><th>Música</th><th>Tom</th><th>BPM</th><th>Duração</th><th>Anotações</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="footer">MRQ · Multitracks Play</div>
  <div class="no-print"><button onclick="window.print()">🖨 Imprimir / Salvar como PDF</button></div>
</body>
</html>`;
}

function downloadGigSheet(scene: Scene, songs: ReturnType<typeof useStore.getState>['library']['songs']) {
  const html = buildGigSheetHtml(scene, songs);
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${scene.name.replace(/[^\w\- ]+/g, '').trim() || 'roteiro'}.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export default function SetlistPanel() {
  const library = useStore((s) => s.library);
  const addScene = useStore((s) => s.addScene);
  const deleteScene = useStore((s) => s.deleteScene);
  const updateScene = useStore((s) => s.updateScene);
  const importScene = useStore((s) => s.importScene);
  const selectSong = useStore((s) => s.selectSong);
  const setKey = useStore((s) => s.setKey);
  const setBpm = useStore((s) => s.setBpm);
  const currentSong = useStore((s) => s.currentSong);
  const engineState = useStore((s) => s.engineState);
  const playLog = useStore((s) => s.playLog);
  const clearPlayLog = useStore((s) => s.clearPlayLog);
  // ativa a cena no estado global (não só local deste painel), pra que outras
  // telas (ex.: a prévia da próxima música no cabeçalho) também saibam qual
  // cena está em uso, mesmo com o painel de setlist fechado.
  const activeSceneId = useStore((s) => s.activeSceneId);
  const setActiveSceneId = useStore((s) => s.setActiveSceneId);
  const [newSceneName, setNewSceneName] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const prefetchedRef = useRef<string | null>(null);

  // mesmo comportamento de antes: se nenhuma cena estiver ativa ainda, abre a
  // primeira da lista automaticamente ao montar o painel pela 1ª vez.
  useEffect(() => {
    if (activeSceneId === null && library.scenes.length > 0) setActiveSceneId(library.scenes[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scene = library.scenes.find((s) => s.id === activeSceneId) ?? null;

  // Pré-aquecimento: quando uma cena está aberta e a música atual é uma das
  // dela e está tocando, já esquenta os arquivos da PRÓXIMA da lista, pra
  // reduzir a espera quando o operador clicar nela ao vivo.
  useEffect(() => {
    if (!scene || !currentSong || !engineState.isPlaying) return;
    const idx = scene.items.findIndex((it) => it.songId === currentSong.id);
    const next = idx >= 0 ? scene.items[idx + 1] : null;
    if (next && prefetchedRef.current !== next.songId) {
      prefetchedRef.current = next.songId;
      prefetchSongFiles(next.songId);
    }
  }, [scene, currentSong, engineState.isPlaying]);

  async function playItem(songId: string, key: string, bpm: number) {
    await selectSong(songId);
    setKey(key);
    setBpm(bpm);
  }

  function exportScene(s: Scene) {
    downloadJson(`${s.name.replace(/[^\w\- ]+/g, '').trim() || 'cena'}.mrqscene.json`, s);
  }

  function handleImportFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        if (!parsed || typeof parsed.name !== 'string' || !Array.isArray(parsed.items)) {
          throw new Error('formato inválido');
        }
        importScene(parsed as Scene);
      } catch {
        useStore.getState().pushToast('Arquivo de cena inválido.', 'error');
      }
    };
    reader.readAsText(file);
  }

  return (
    <div className="secondary-panel">
      <div className="secondary-header">
        <h2>{scene ? scene.name : 'Cenas'}</h2>
        {scene && (
          <div style={{ display: 'flex', gap: 4 }}>
            <button className="icon-btn" title="Gerar folha de roteiro pra imprimir/PDF (.html)" onClick={() => downloadGigSheet(scene, library.songs)}><FileText size={16} /></button>
            <button className="icon-btn" title="Exportar cena (.json)" onClick={() => exportScene(scene)}><Download size={16} /></button>
            <button className="icon-btn" title="Remover cena" onClick={() => { deleteScene(scene.id); setActiveSceneId(null); }}><Trash2 size={16} /></button>
          </div>
        )}
      </div>
      <div className="secondary-body">
        {!scene && (
          <>
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              <input placeholder="Nome da cena, ex: Culto de domingo" value={newSceneName} onChange={(e) => setNewSceneName(e.target.value)} />
              <button
                className="btn primary"
                onClick={() => {
                  if (!newSceneName.trim()) return;
                  addScene(newSceneName.trim());
                  setNewSceneName('');
                }}
              >
                Criar
              </button>
            </div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
              <button className="btn ghost" style={{ flex: 1 }} onClick={() => importInputRef.current?.click()}>
                <Upload size={13} style={{ marginRight: 6 }} />Importar cena (.json)
              </button>
              <input
                ref={importInputRef}
                type="file"
                accept="application/json,.json"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleImportFile(file);
                  e.target.value = '';
                }}
              />
            </div>
            {library.scenes.map((s) => (
              <div key={s.id} className="song-list-item" onClick={() => setActiveSceneId(s.id)}>
                <div className="title">{s.name}</div>
                <div className="meta">{s.items.length} músicas</div>
              </div>
            ))}
            {library.scenes.length === 0 && (
              <div style={{ color: 'var(--text-2)', fontSize: 13, marginBottom: 14 }}>
                Crie uma cena para montar a ordem do culto ou show.
              </div>
            )}

            <button className="btn ghost" style={{ width: '100%', marginTop: 10 }} onClick={() => setShowHistory((v) => !v)}>
              <History size={13} style={{ marginRight: 6 }} />
              {showHistory ? 'Ocultar histórico' : 'Histórico de execução (sessão atual)'}
            </button>
            {showHistory && (
              <div style={{ marginTop: 8 }}>
                {playLog.length === 0 && (
                  <div style={{ color: 'var(--text-2)', fontSize: 12 }}>Nada tocado ainda nesta sessão.</div>
                )}
                {playLog.length > 0 && (
                  <button className="btn ghost" style={{ marginBottom: 6 }} onClick={() => clearPlayLog()}>Limpar histórico</button>
                )}
                {playLog.map((entry, i) => (
                  <div className="play-log-row" key={i}>
                    <span>{entry.songTitle} — {entry.partName}</span>
                    <span className="when">{new Date(entry.at).toLocaleTimeString('pt-BR')}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {scene && (
          <>
            <button className="btn ghost" style={{ marginBottom: 8 }} onClick={() => setActiveSceneId(null)}>← Todas as cenas</button>
            <select
              style={{ width: '100%', marginBottom: 10 }}
              onChange={(e) => {
                if (!e.target.value) return;
                const song = library.songs.find((s) => s.id === e.target.value);
                if (!song) return;
                updateScene(scene.id, { items: [...scene.items, { songId: song.id, key: song.currentKey, bpm: song.currentBpm }] });
                e.target.value = '';
              }}
            >
              <option value="">+ adicionar música à cena…</option>
              {library.songs.map((s) => (
                <option key={s.id} value={s.id}>{s.title}</option>
              ))}
            </select>

            {scene.items.map((item, i) => {
              const song = library.songs.find((s) => s.id === item.songId);
              if (!song) return null;
              const isCurrent = currentSong?.id === song.id;
              const isNext = !isCurrent && scene.items[i - 1] && currentSong?.id === scene.items[i - 1].songId;
              return (
                <div
                  key={i}
                  className={`song-list-item ${isCurrent ? 'selected' : ''}`}
                  onClick={() => playItem(song.id, item.key, item.bpm)}
                >
                  <div className="title">{i + 1}. {song.title} {isNext && <span style={{ color: 'var(--accent)', fontSize: 10 }}>A SEGUIR ●</span>}</div>
                  <div className="meta">Tom {item.key} · {item.bpm} BPM</div>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
