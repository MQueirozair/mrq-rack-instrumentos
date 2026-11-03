#!/usr/bin/env node
/**
 * Teste de regressão do reconhecimento automático de partes (src/audio/PartRecognition.ts).
 *
 * Não usa um framework de testes (o projeto não tem um configurado) — é um
 * script standalone que compila o módulo com esbuild (pra rodar em Node, já
 * que o arquivo original usa a Web Audio API só em `recognizeParts`) e roda
 * cenários sintéticos contra `labelSegments`/`recognizeParts` diretamente.
 *
 * Existe porque essa área já regrediu DUAS vezes sem teste nenhum cobrindo:
 *   1. limiar de similaridade frouxo demais -> toda parte virava "Refrão";
 *   2. faixa guia com volume quase constante -> toda parte virava
 *      "Intro"/"Interlúdio" (classificada como instrumental por engano).
 *
 * Rode com: node scripts/test-part-recognition.mjs
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(os.tmpdir(), `partrec-test-${Date.now()}.cjs`);

await build({
  entryPoints: [path.join(__dirname, '..', 'src', 'audio', 'PartRecognition.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
});

const { recognizeParts, labelSegments } = await import(`file://${outfile}`);

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

function oneHotFeature(n) {
  const dim = n % 16;
  const vec = new Array(16).fill(0.02);
  vec[dim] = 1.0;
  const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0));
  return vec.map((v) => v / norm);
}

function makeFakeBuffer({ sr = 8000, bpm = 120, timeSig = 4, totalBars, sampleAt }) {
  const secPerBar = (60 / bpm) * timeSig;
  const totalSamples = Math.floor(totalBars * secPerBar * sr);
  const data = new Float32Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) {
    const t = i / sr;
    const bar = Math.min(totalBars - 1, Math.floor(t / secPerBar));
    data[i] = sampleAt(t, bar);
  }
  return { buffer: { duration: totalSamples / sr, sampleRate: sr, getChannelData: () => data }, bpm, timeSig };
}

section('labelSegments: estrutura completa com Intro/Verso/Pré-refrão/Refrão/Interlúdio/Solo/Ponte/Final', () => {
  let bar = 1;
  const seg = (len, feature, vocalRatio, avgRawEnergy) => {
    const s = { startBar: bar, endBar: bar + len, feature: oneHotFeature(feature), vocalRatio, avgRawEnergy };
    bar += len;
    return s;
  };
  const segments = [
    seg(4, 100, 0.0, 0.02),
    seg(8, 1, 1.0, 0.25),
    seg(4, 2, 1.0, 0.3),
    seg(8, 3, 1.0, 0.6),
    seg(8, 1, 1.0, 0.25),
    seg(4, 2, 1.0, 0.3),
    seg(8, 3, 1.0, 0.6),
    seg(4, 101, 0.05, 0.05),
    seg(4, 102, 0.1, 0.5),
    seg(8, 6, 1.0, 0.35),
    seg(8, 3, 1.0, 0.6),
    seg(4, 103, 0.0, 0.01),
  ];
  const parts = labelSegments(segments);
  const types = parts.map((p) => p.type);
  check('Intro é a primeira parte', parts[0].type === 'Intro');
  check('Final é a última parte', parts[parts.length - 1].type === 'Final');
  check('Refrão detectado nas 3 repetições mais altas', types.filter((t) => t === 'Refrão').length === 3);
  check('Pré-refrão detectado (curto, antes do refrão)', types.filter((t) => t === 'Pré-refrão').length === 2);
  check('Verso detectado (repetido)', types.filter((t) => t === 'Verso').length === 2);
  check('Interlúdio detectado (instrumental discreto)', types.includes('Interlúdio'));
  check('Solo detectado (instrumental de energia alta, distinto de Interlúdio)', types.includes('Solo'));
  check('Ponte detectada (vocal, não repete)', types.includes('Ponte'));
  const refraos = parts.filter((p) => p.type === 'Refrão');
  check('1ª ocorrência fica sem número', refraos[0]?.name === 'Refrão');
  check('2ª/3ª ocorrência numerada', refraos[1]?.name === 'Refrão 2' && refraos[2]?.name === 'Refrão 3');
});

section('Regressão: timbre igual, só o volume muda entre seções -> não pode virar tudo "Refrão"', () => {
  const { buffer, bpm, timeSig } = makeFakeBuffer({
    totalBars: 40,
    sampleAt: (t, bar) => {
      const amp = bar < 4 ? 0.01 : Math.floor((bar - 4) / 8) % 2 === 0 ? 0.2 : 0.6;
      return amp * Math.sin(2 * Math.PI * 220 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t));
    },
  });
  const parts = recognizeParts(buffer, bpm, timeSig, { sensitivity: 'normal' });
  const types = new Set(parts.map((p) => p.type));
  check('gera ao menos 1 parte', parts.length > 0);
  check('não colapsa tudo num único tipo', types.size > 1);
});

section('Regressão: faixa guia com volume quase constante -> não pode virar tudo instrumental', () => {
  const { buffer, bpm, timeSig } = makeFakeBuffer({
    totalBars: 32,
    sampleAt: (t) => 0.4 * Math.sin(2 * Math.PI * 220 * t) * (0.9 + 0.1 * Math.sin(2 * Math.PI * 0.5 * t)),
  });
  const parts = recognizeParts(buffer, bpm, timeSig, { sensitivity: 'normal' });
  const falseInstrumental = parts.some((p) => ['Intro', 'Interlúdio', 'Solo'].includes(p.type));
  check('gera ao menos 1 parte', parts.length > 0);
  check('nenhum falso positivo de instrumental numa faixa sempre cantada', !falseInstrumental);
});

section('Diversidade genuína (frequência e amplitude variam por seção) ainda funciona', () => {
  const sections = [
    { freq: 150, amp: 0.05 },
    { freq: 300, amp: 0.3 },
    { freq: 450, amp: 0.7 },
    { freq: 300, amp: 0.3 },
    { freq: 450, amp: 0.7 },
    { freq: 600, amp: 0.4 },
  ];
  const { buffer, bpm, timeSig } = makeFakeBuffer({
    totalBars: 48,
    sampleAt: (t, bar) => {
      const sec = sections[Math.min(sections.length - 1, Math.floor(bar / 8))];
      return sec.amp * Math.sin(2 * Math.PI * sec.freq * t);
    },
  });
  const parts = recognizeParts(buffer, bpm, timeSig, { sensitivity: 'normal' });
  const types = new Set(parts.map((p) => p.type));
  check('gera ao menos 1 parte', parts.length > 0);
  check('não colapsa tudo num único tipo', types.size > 1);
});

console.log(failures === 0 ? `\nTodos os testes passaram.` : `\n${failures} teste(s) falharam.`);
process.exit(failures === 0 ? 0 : 1);
