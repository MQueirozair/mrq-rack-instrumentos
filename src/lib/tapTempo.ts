export class TapTempo {
  private taps: number[] = [];
  private maxGapMs = 2200;

  tap(): number | null {
    const now = performance.now();
    if (this.taps.length > 0 && now - this.taps[this.taps.length - 1] > this.maxGapMs) {
      this.taps = [];
    }
    this.taps.push(now);
    if (this.taps.length > 8) this.taps.shift();
    if (this.taps.length < 2) return null;
    const intervals: number[] = [];
    for (let i = 1; i < this.taps.length; i++) intervals.push(this.taps[i] - this.taps[i - 1]);
    const avgMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    return Math.round((60000 / avgMs) * 10) / 10;
  }

  reset() {
    this.taps = [];
  }
}
