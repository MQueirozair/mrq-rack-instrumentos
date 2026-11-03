export function formatTime(totalSeconds: number): string {
  const sign = totalSeconds < 0 ? '-' : '';
  const s = Math.max(0, Math.abs(Math.round(totalSeconds)));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${sign}${mm.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export function gainToDb(gain: number): number {
  if (gain <= 0) return -60;
  return 20 * Math.log10(gain);
}
