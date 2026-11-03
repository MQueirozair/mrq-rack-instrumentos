import { AudioEngine } from './AudioEngine';
import { PadEngine } from './PadEngine';

export const engine = new AudioEngine();
export const padEngine = new PadEngine(engine);
