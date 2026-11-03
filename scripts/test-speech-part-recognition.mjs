#!/usr/bin/env node
/**
 * Teste de regressão do reconhecimento de partes por VOZ
 * (src/audio/SpeechPartRecognition.ts) — cobre só a lógica pura (dicionário
 * de termos + montagem de partes a partir da transcrição), sem precisar de
 * um WebView de verdade (nem OfflineAudioContext, nem whisper.cpp rodando) —
 * ver `recognizePartsFromSpeech`, que não é exercitado aqui por depender de
 * Web Audio real.
 *
 * Rode com: node scripts/test-speech-part-recognition.mjs
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(os.tmpdir(), `speechpartrec-test-${Date.now()}.cjs`);

await build({
  entryPoints: [path.join(__dirname, '..', 'src', 'audio', 'SpeechPartRecognition.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
});

const { matchAnnouncementToType, buildPartsFromTranscript, encodeWav16 } = await import(`file://${outfile}`);

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  OK   - ${name}`);
  } else {
    failures++;
    console.log(`  FAIL - ${name}`);
  }
}
function section(title, fn) {
  console.log(`\n${title}`);
  fn();
}

section('matchAnnouncementToType: dicionário reconhece os termos esperados', () => {
  check('"Estrofe" -> Verso', matchAnnouncementToType('Estrofe') === 'Verso');
  check('"Verso dois" -> Verso', matchAnnouncementToType('Verso dois') === 'Verso');
  check('"Refrão" -> Refrão', matchAnnouncementToType('Refrão') === 'Refrão');
  check('"Coro" -> Refrão', matchAnnouncementToType('Coro') === 'Refrão');
  check('"Pré-refrão" -> Pré-refrão (não confunde com Refrão)', matchAnnouncementToType('Pré-refrão') === 'Pré-refrão');
  check('"Pré coro" -> Pré-refrão', matchAnnouncementToType('Pré coro') === 'Pré-refrão');
  check('"Introdução" -> Intro', matchAnnouncementToType('Introdução') === 'Intro');
  check('"Ponte" -> Ponte', matchAnnouncementToType('Ponte') === 'Ponte');
  check('"Interlúdio" -> Interlúdio', matchAnnouncementToType('Interlúdio') === 'Interlúdio');
  check('"Instrumental" -> Instrumental (não vira Interlúdio)', matchAnnouncementToType('Instrumental') === 'Instrumental');
  check('"Solo de guitarra" -> Solo', matchAnnouncementToType('Solo de guitarra') === 'Solo');
  check('"Tag final" -> Tag (termo mais específico não atrapalha)', matchAnnouncementToType('Tag final') === 'Tag');
  check('"Final" -> Final', matchAnnouncementToType('Final') === 'Final');
  check('letra cantada qualquer -> null (não é anúncio)', matchAnnouncementToType('te louvamos com alegria') === null);
  check('texto vazio -> null', matchAnnouncementToType('') === null);
});

section('buildPartsFromTranscript: monta partes a partir da transcrição', () => {
  // música de 120bpm, 4/4 -> 2s por compasso. Anúncios: "Estrofe" termina em
  // 8s (compasso 4), "Refrão" termina em 32s (compasso 16+1 contagem).
  const bpm = 120;
  const timeSig = 4;
  const segments = [
    { startMs: 6000, endMs: 7500, text: 'Estrofe' },
    { startMs: 30000, endMs: 31800, text: 'Refrão' },
    { startMs: 54000, endMs: 55700, text: 'Verso dois' },
    { startMs: 78000, endMs: 79600, text: 'Refrão' },
  ];
  const totalBars = 60;
  const parts = buildPartsFromTranscript(segments, totalBars, bpm, timeSig);

  check('retorna uma lista de partes (não null)', Array.isArray(parts));
  if (Array.isArray(parts)) {
    check('primeira parte é Intro (começa antes do 1º anúncio)', parts[0]?.type === 'Intro' && parts[0]?.startBar === 1);
    check('última parte vai até o fim da música', parts[parts.length - 1]?.endBar === totalBars + 1);
    check('tem pelo menos uma parte do tipo Verso', parts.some((p) => p.type === 'Verso'));
    check('tem pelo menos uma parte do tipo Refrão', parts.some((p) => p.type === 'Refrão'));
    // convenção do projeto (ver mergeDuplicateNames): a 1ª ocorrência fica
    // sem número, só a partir da 2ª que vira "Refrão 2", "Refrão 3"...
    check('Refrão repetido fica numerado (1ª sem número, 2ª "Refrão 2")', parts.some((p) => p.name === 'Refrão') && parts.some((p) => p.name === 'Refrão 2'));
    check('compassos não se sobrepõem (startBar < endBar sempre crescente)', parts.every((p, i) => p.startBar < p.endBar && (i === 0 || p.startBar === parts[i - 1].endBar)));
  }

  check(
    'poucos anúncios reconhecidos (< 2) -> null, caller cai pro método heurístico',
    buildPartsFromTranscript([{ startMs: 1000, endMs: 2000, text: 'Refrão' }], totalBars, bpm, timeSig) === null
  );
  check(
    'nenhum anúncio reconhecido -> null',
    buildPartsFromTranscript([{ startMs: 1000, endMs: 2000, text: 'la la la' }], totalBars, bpm, timeSig) === null
  );
  check(
    'anúncios duplicados (transcrição cortada) não viram duas partes separadas',
    (() => {
      const dupSegments = [
        { startMs: 6000, endMs: 7000, text: 'Re' },
        { startMs: 7100, endMs: 7500, text: 'Refrão' },
        { startMs: 30000, endMs: 31000, text: 'Verso' },
      ];
      // "Re" sozinho não bate no dicionário (precisa de \b em "refrao"), então
      // só testa o cenário real: dois segmentos bem próximos que batem no
      // dicionário (ex.: locutor repete a palavra) não devem virar 2 partes.
      const closeSegments = [
        { startMs: 6000, endMs: 7000, text: 'Refrão' },
        { startMs: 7200, endMs: 7900, text: 'Refrão' },
        { startMs: 40000, endMs: 41500, text: 'Verso' },
      ];
      const result = buildPartsFromTranscript(closeSegments, totalBars, bpm, timeSig);
      return Array.isArray(result) && result.filter((p) => p.type === 'Refrão').length === 1;
    })()
  );
});

section('encodeWav16: produz um cabeçalho WAV PCM16 mono válido', () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
  const wav = encodeWav16(samples, 16000);
  const asString = (offset, len) => String.fromCharCode(...wav.slice(offset, offset + len));
  check('tamanho total = 44 (cabeçalho) + 2 bytes por amostra', wav.length === 44 + samples.length * 2);
  check('marcador RIFF', asString(0, 4) === 'RIFF');
  check('marcador WAVE', asString(8, 4) === 'WAVE');
  check('marcador fmt ', asString(12, 4) === 'fmt ');
  check('marcador data', asString(36, 4) === 'data');
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  check('sampleRate gravado corretamente', view.getUint32(24, true) === 16000);
  check('mono (1 canal)', view.getUint16(22, true) === 1);
  check('16 bits por amostra', view.getUint16(34, true) === 16);
});

if (failures > 0) {
  console.error(`\n${failures} teste(s) falharam.`);
  process.exit(1);
} else {
  console.log('\nTodos os testes passaram.');
}
