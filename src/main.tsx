import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './styles/theme.css';
import { useStore } from './state/useStore';
import { engine } from './audio/engineInstance';

// Ganchos de depuração, úteis para suporte/diagnóstico (ex: via DevTools).
// Não afetam o funcionamento normal do app.
import { rackEngine } from './audio/rack/RackEngine';
(window as any).__mrqDebug = { useStore, engine, rackEngine };

// Captura qualquer erro/rejeição não tratada que escape de tudo mais (React,
// try/catch locais, etc.) e registra no log de diagnóstico em disco, se a
// ponte com o Tauri já estiver disponível — essencial pra conseguir investigar
// relatos de "tela preta" a partir do mrq-debug.log do próprio usuário, já
// que sem isso esse tipo de erro só aparece no console do DevTools (que a
// maioria dos usuários nunca abre).
function logFatal(label: string, err: unknown) {
  const detail = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err);
  console.error(`[${label}]`, err);
  try {
    void (window as any).api?.log?.append?.(`[${label}] ${detail}`);
  } catch {
    /* noop */
  }
}
window.addEventListener('error', (e) => logFatal('window.onerror', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => logFatal('unhandledrejection', e.reason));

// Rede de segurança de ÚLTIMO nível: se ALGUMA coisa no bootstrap falhar de um
// jeito que nem o ErrorBoundary do React alcança (ex.: o próprio módulo
// tauriBridge.ts falhando ao carregar, ou um erro antes do React montar),
// sem isto a janela fica com a cor de fundo pura (#0b0b0d, quase preta) e
// NADA mais — é exatamente a "tela preta" relatada por usuários logo ao abrir
// o app. Escreve direto no DOM (sem depender de React) e tenta registrar no
// log de diagnóstico em disco, se a ponte com o Tauri já existir.
function renderFatalBootError(err: unknown) {
  console.error('[bootstrap] falha fatal antes de renderizar a interface', err);
  try {
    void (window as any).api?.log?.append?.(
      `[bootstrap] ERRO FATAL NO BOOT (tela preta): ${err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err)}`
    );
  } catch {
    /* noop */
  }
  const root = document.getElementById('root');
  if (!root) return;
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  root.innerHTML = `
    <div style="position:fixed;inset:0;background:#0b0b0d;color:#f4f4f5;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px;text-align:center;font-family:system-ui,sans-serif;gap:16px;">
      <div style="font-size:48px;">⚠️</div>
      <h1 style="margin:0;font-size:20px;">Não foi possível abrir o MRQ</h1>
      <p style="max-width:520px;opacity:0.8;line-height:1.5;">
        Ocorreu um erro inesperado antes mesmo da interface carregar. Tente reiniciar o app.
        Se persistir, isso é um bug — por favor reporte com os detalhes abaixo.
      </p>
      <pre style="max-width:640px;max-height:160px;overflow:auto;background:#1a1a1d;padding:12px;border-radius:8px;font-size:12px;text-align:left;white-space:pre-wrap;word-break:break-word;">${message.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!))}</pre>
      <button id="mrq-fatal-reload" style="padding:10px 20px;border-radius:8px;border:none;background:#6d5efc;color:white;font-size:14px;cursor:pointer;">Tentar novamente</button>
    </div>
  `;
  document.getElementById('mrq-fatal-reload')?.addEventListener('click', () => window.location.reload());
}

async function bootstrap() {
  // Sob Electron, window.api já foi montado pelo preload.js antes deste script
  // sequer carregar. Sob Tauri não existe um estágio de preload separado —
  // então, quando detectamos que estamos num webview do Tauri (global injetado
  // só nesse ambiente), montamos a mesma API (ver tauriBridge.ts) ANTES de
  // renderizar qualquer componente que dependa de window.api.
  if (!window.api && '__TAURI_INTERNALS__' in window) {
    // IMPORTANTE: o import() em si (não só o bridge.ready depois) também
    // precisa estar protegido — se o módulo falhar ao avaliar/carregar, essa
    // promise rejeita e, sem try/catch aqui, a rejeição sobe sem tratamento,
    // o React NUNCA chega a montar, e a janela fica só com a cor de fundo
    // (tela preta), sem nenhum log ou pista do que aconteceu.
    try {
      const bridge = await import('./tauriBridge');
      // Espera a migração de dados do Electron (se houver) e a configuração
      // inicial do servidor remoto terminarem ANTES de montar qualquer
      // componente — ver o comentário em tauriBridge.ts sobre a corrida que
      // isso evita (ex.: TitleBar mostrando a porta/PIN errados por um instante).
      // Em try/catch pra NUNCA travar a tela em branco pra sempre: se a
      // migração falhar por algum motivo inesperado, o app ainda deve abrir
      // (com as configurações padrão) em vez de ficar preso aqui.
      // bridge.ready já tem seu próprio try/catch interno (então, na prática,
      // ele sempre RESOLVE, nunca rejeita) — mas isso não protege contra um
      // TRAVAMENTO (ex.: um comando Rust que nunca responde pelo canal IPC
      // por ter sofrido panic no meio de uma chamada async, ou uma chamada
      // de rede/socket que fica esperando algo que nunca chega, como uma
      // permissão de rede local do SO). Sem um limite de tempo aqui, isso
      // travaria o boot pra sempre e a janela ficaria só com a cor de fundo
      // (tela preta), já que o React nunca chegaria a renderizar.
      const TAURI_BRIDGE_READY_TIMEOUT_MS = 8000;
      try {
        await Promise.race([
          bridge.ready,
          new Promise<void>((_, reject) =>
            setTimeout(
              () => reject(new Error(`tauriBridge.ready não respondeu em ${TAURI_BRIDGE_READY_TIMEOUT_MS}ms (travamento?)`)),
              TAURI_BRIDGE_READY_TIMEOUT_MS
            )
          ),
        ]);
      } catch (err) {
        console.error('[bootstrap] falha ao aguardar tauriBridge.ready, prosseguindo mesmo assim', err);
      }
    } catch (err) {
      console.error('[bootstrap] falha ao carregar o módulo tauriBridge, prosseguindo mesmo assim', err);
      // Não aborta o boot: segue tentando renderizar o React normalmente.
      // Sem window.api montado várias telas vão reclamar, mas pelo menos o
      // usuário vê ALGUMA coisa em vez de uma janela morta.
    }
  }

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  );
}

bootstrap().catch(renderFatalBootError);
