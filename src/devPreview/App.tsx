/**
 * Harness de pré-visualização — monta a tela REAL do MRQ Instrument
 * Converter (`InstrumentConverter.tsx`, sem nenhuma modificação) só pra dar
 * pra testar manualmente, num navegador comum, as duas features mais
 * recentes:
 *   1. Kontakt Audio Capture (botão "Importar instrumento renderizado pelo
 *      Kontakt…") — os diálogos de arquivo/pasta e as chamadas ao backend
 *      Rust estão mockados (ver mockShared.ts); os "arquivos" são tons
 *      sintetizados no navegador, nunca áudio real.
 *   2. O painel "⚙ Mostrar ajustes" do MRQ Instrument Analyzer — abra
 *      qualquer item da fila depois de importado pra ver o cabeçalho com o
 *      botão nos resultados.
 */
import InstrumentConverter from '../components/InstrumentConverter';

export default function PreviewApp() {
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-0, #0b0b0d)', color: 'var(--text-0, #eee)' }}>
      <div
        style={{
          padding: '8px 16px',
          fontSize: 12,
          borderBottom: '1px solid #2a2a30',
          background: '#161619',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <strong>Harness de pré-visualização (fora do app real)</strong>
        <span style={{ color: '#9a9aa5' }}>
          Diálogos de arquivo e backend Rust são MOCKADOS (áudio sintetizado no navegador, nunca arquivo real). Teste:{' '}
          <em>“Importar instrumento renderizado pelo Kontakt…”</em> à esquerda, depois selecione o item convertido e clique em{' '}
          <em>“⚙ Mostrar ajustes”</em> no Inspetor de Instrumentos à direita.
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <InstrumentConverter />
      </div>
    </div>
  );
}
