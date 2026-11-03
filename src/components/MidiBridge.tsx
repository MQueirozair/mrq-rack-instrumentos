import { useEffect } from 'react';
import { useStore } from '../state/useStore';
import { initMidi, setBindings, setDispatcher } from '../midi/midiController';
import { rackEngine } from '../audio/rack/RackEngine';

/** Componente sem interface: liga o MIDI aos comandos do app. Monte uma vez no topo. */
export default function MidiBridge() {
  const settings = useStore((s) => s.settings);

  useEffect(() => {
    initMidi();
  }, []);

  useEffect(() => {
    setBindings(settings.midiBindings);
  }, [settings.midiBindings]);

  useEffect(() => {
    setDispatcher((binding, value) => {
      const state = useStore.getState();
      switch (binding.action) {
        case 'transport:play':
          state.play();
          break;
        case 'transport:pause':
          state.pause();
          break;
        case 'transport:stop':
          state.stop();
          break;
        case 'transport:prev':
          state.jumpRelative(-1);
          break;
        case 'transport:next':
          state.jumpRelative(1);
          break;
        case 'transport:loop':
          state.toggleLoopActivePart();
          break;
        case 'pad:toggle':
          state.togglePad();
          break;
        case 'partType': {
          const song = state.currentSong;
          if (!song || !binding.partType) break;
          const currentIdx = song.parts.findIndex((p) => p.id === state.engineState.activePartId);
          const ordered = song.parts.map((p, i) => ({ p, i }));
          const ahead = ordered.filter((x) => x.i > currentIdx && x.p.type === binding.partType);
          const behind = ordered.filter((x) => x.i <= currentIdx && x.p.type === binding.partType).reverse();
          const target = ahead[0]?.p ?? behind[0]?.p;
          if (target) state.jumpToPart(target.id);
          break;
        }

        // --- Rack: faders (usam o valor contínuo 0-127 do CC) ---
        case 'rack:layer:volume': {
          const index = binding.layerIndex;
          if (index === undefined || !state.settings.rack.layers[index]) break;
          const volume = Math.max(0, Math.min(1, value / 127));
          rackEngine.setLayerVolume(index, volume);
          state.updateRackLayer(index, { volume });
          break;
        }
        case 'rack:master:volume': {
          const masterVolume = Math.max(0, Math.min(1, value / 127));
          rackEngine.setMasterVolume(masterVolume);
          state.updateRack({ masterVolume });
          break;
        }
        case 'rack:master:reverb': {
          const reverb = Math.max(0, Math.min(1, value / 127));
          rackEngine.setReverb(reverb);
          state.updateRack({ reverb });
          break;
        }
        case 'rack:master:transpose': {
          // 0-127 -> -24..+24 semitons
          const transpose = Math.round((value / 127) * 48 - 24);
          state.updateRack({ transpose });
          break;
        }

        // --- Rack: botões/toggles (dispara em qualquer mensagem, ignora o valor) ---
        case 'rack:layer:mute': {
          const index = binding.layerIndex;
          const layer = index !== undefined ? state.settings.rack.layers[index] : undefined;
          if (index === undefined || !layer) break;
          const next = !layer.muted;
          rackEngine.setLayerMuted(index, next);
          state.updateRackLayer(index, { muted: next });
          break;
        }
        case 'rack:layer:solo': {
          const index = binding.layerIndex;
          const layer = index !== undefined ? state.settings.rack.layers[index] : undefined;
          if (index === undefined || !layer) break;
          const next = !layer.solo;
          rackEngine.setLayerSolo(index, next);
          state.updateRackLayer(index, { solo: next });
          break;
        }
        case 'rack:layer:octaver': {
          const index = binding.layerIndex;
          const layer = index !== undefined ? state.settings.rack.layers[index] : undefined;
          if (index === undefined || !layer) break;
          const octaverEnabled = !layer.octaverEnabled;
          rackEngine.setLayerOctaver(index, { enabled: octaverEnabled, mode: layer.octaverMode, mix: layer.octaverMix });
          state.updateRackLayer(index, { octaverEnabled });
          break;
        }
        case 'rack:master:panic':
          rackEngine.panic();
          break;

        default:
          break;
      }
    });
  }, []);

  return null;
}
