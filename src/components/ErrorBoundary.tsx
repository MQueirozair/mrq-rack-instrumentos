import { Component, type ErrorInfo, type ReactNode } from 'react';

// Rede de segurança no topo da árvore de componentes: sem isso, QUALQUER
// exceção não tratada durante a renderização (ex.: código que assume que uma
// faixa carregou com sucesso e explode ao lidar com os dados que não vieram)
// faz o React desmontar a árvore inteira silenciosamente, deixando a janela
// com a cor de fundo pura e nada mais — exatamente o "tela preta, não mostra
// nada" relatado por usuários no Windows e no macOS. Com isso aqui, o usuário
// vê uma mensagem de erro de verdade (e pode reportar/reiniciar) em vez de um
// app aparentemente travado/morto.
interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Também manda pro log de diagnóstico em disco (mesmo mecanismo usado
    // pelo resto do app), pra aparecer no mrq-debug.log quando o usuário
    // mandar o arquivo de log depois de um travamento.
    console.error('[ErrorBoundary] erro não tratado na renderização:', error, info.componentStack);
    try {
      void window.api?.log?.append?.(
        `[ErrorBoundary] ERRO FATAL NA INTERFACE: ${error.name}: ${error.message}\n${error.stack ?? ''}\nComponentStack:${info.componentStack ?? ''}`
      );
    } catch {
      /* noop — não deixar o próprio tratamento de erro quebrar algo */
    }
  }

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: '#0b0b0d',
            color: '#f4f4f5',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 32,
            textAlign: 'center',
            fontFamily: 'system-ui, sans-serif',
            gap: 16,
          }}
        >
          <div style={{ fontSize: 48 }}>⚠️</div>
          <h1 style={{ margin: 0, fontSize: 20 }}>Algo deu errado</h1>
          <p style={{ maxWidth: 520, opacity: 0.8, lineHeight: 1.5 }}>
            O MRQ encontrou um erro inesperado e não conseguiu continuar mostrando a tela.
            Isso não deveria acontecer — por favor, reinicie o app. Se o problema persistir,
            envie o arquivo de log de diagnóstico (Ajustes → Diagnóstico) para suporte.
          </p>
          <pre
            style={{
              maxWidth: 640,
              maxHeight: 160,
              overflow: 'auto',
              background: '#1a1a1d',
              padding: 12,
              borderRadius: 8,
              fontSize: 12,
              textAlign: 'left',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {this.state.error.name}: {this.state.error.message}
          </pre>
          <button
            onClick={this.handleReload}
            style={{
              padding: '10px 20px',
              borderRadius: 8,
              border: 'none',
              background: '#6d5efc',
              color: 'white',
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            Reiniciar interface
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
