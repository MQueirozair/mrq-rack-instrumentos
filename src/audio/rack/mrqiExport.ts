import { packMrqi, audioBufferToSampleInput, type MrqiGroupDef, type MrqiZoneDef, type MrqiSampleInput } from './mrqiFormat';
import type { NkiLayerVoice } from './NkiLayerVoice';

/**
 * Converte um instrumento Kontakt (`.nki`, Kontakt 1-4) já carregado numa
 * camada do Rack em um pacote `.mrqi` pronto pra salvar em disco. Reaproveita
 * inteiramente o mapeamento de zonas/amostras que o NkiLayerVoice já extraiu
 * do .nki (ver NkiLayerVoice.exportForMrqi) — nenhuma leitura nova do .nki é
 * feita aqui, só reempacotamento do que já estava decodificado em memória.
 */
export function exportNkiToMrqi(voice: NkiLayerVoice): Uint8Array {
  const exported = voice.exportForMrqi();
  const groups: MrqiGroupDef[] = [];
  const zones: MrqiZoneDef[] = [];
  const samples: MrqiSampleInput[] = [];
  let sampleIndex = 0;

  exported.groups.forEach((group, gi) => {
    const groupId = `g${gi}`;
    groups.push({ id: groupId, name: group.name });
    for (const zone of group.zones) {
      const samplePath = `audio/${String(sampleIndex).padStart(3, '0')}.pcmf32`;
      samples.push(audioBufferToSampleInput(zone.buffer));
      sampleIndex++;
      zones.push({
        groupId,
        sample: samplePath,
        rootNote: zone.rootNote,
        loKey: zone.loNote,
        hiKey: zone.hiNote,
        loVel: zone.loVel,
        hiVel: zone.hiVel,
        tuneCents: zone.tuneCents,
        volume: zone.volume,
        pan: zone.pan,
      });
    }
  });

  return packMrqi(
    {
      name: exported.instrumentName,
      sourceFormat: 'kontakt-1-4',
      importedAt: new Date().toISOString(),
      groups,
      zones,
    },
    samples
  );
}
