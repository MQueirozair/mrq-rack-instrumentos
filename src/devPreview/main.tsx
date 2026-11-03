/**
 * Ponto de entrada do harness de pré-visualização (dev-preview.html /
 * `npm run dev:preview`) — SÓ PARA TESTE MANUAL, nunca empacotado nos
 * builds reais (Tauri/Electron). Instala os mocks de ambiente ANTES de
 * importar qualquer componente real, pra que `isTauriRuntime()` e as
 * chamadas `invoke`/`open`/`save`/`window.api.*` encontrem tudo já no
 * lugar.
 */
import { installMockTauriFlag, installMockWindowApi } from './mockShared';

installMockTauriFlag();
installMockWindowApi();

import { createRoot } from 'react-dom/client';
import '../styles/theme.css';
import PreviewApp from './App';

const el = document.getElementById('root');
if (el) createRoot(el).render(<PreviewApp />);
