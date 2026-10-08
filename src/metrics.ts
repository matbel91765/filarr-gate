/**
 * Les métriques de la boîte noire, au format texte de Prometheus (`/metrics`).
 * Aucune valeur de ligne : des compteurs, des durées, des tailles, des slugs.
 */

type Labels = Record<string, string>;

const BUCKETS = [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

const labelText = (labels: Labels): string => {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  return `{${entries.map(([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`).join(',')}}`;
};

interface Histogram {
  buckets: number[];
  sum: number;
  count: number;
}

export class Metrics {
  private counters = new Map<string, Map<string, { labels: Labels; value: number }>>();
  private histograms = new Map<string, Map<string, { labels: Labels; h: Histogram }>>();
  private help = new Map<string, { type: string; text: string }>();
  private gauges: Array<() => Array<{ name: string; help: string; labels?: Labels; value: number }>> = [];
  /** Requêtes servies par minute (une heure), pour le tableau de bord. */
  readonly perMinute: number[] = new Array(60).fill(0);
  private minute = Math.floor(Date.now() / 60_000);
  /** Durées des dernières requêtes servies (médiane du tableau de bord). */
  private recent: number[] = [];
  /** Requêtes servies par heure (24 h glissantes). */
  private hours: Array<{ hour: number; count: number }> = [];

  describe(name: string, type: 'counter' | 'histogram' | 'gauge', text: string): void {
    this.help.set(name, { type, text });
  }

  inc(name: string, labels: Labels = {}, by = 1): void {
    let series = this.counters.get(name);
    if (!series) this.counters.set(name, (series = new Map()));
    const key = labelText(labels);
    const entry = series.get(key);
    if (entry) entry.value += by;
    else series.set(key, { labels, value: by });
  }

  value(name: string, labels: Labels = {}): number {
    return this.counters.get(name)?.get(labelText(labels))?.value ?? 0;
  }

  observe(name: string, seconds: number, labels: Labels = {}): void {
    let series = this.histograms.get(name);
    if (!series) this.histograms.set(name, (series = new Map()));
    const key = labelText(labels);
    let entry = series.get(key);
    if (!entry) series.set(key, (entry = { labels, h: { buckets: new Array(BUCKETS.length).fill(0), sum: 0, count: 0 } }));
    BUCKETS.forEach((b, i) => {
      if (seconds <= b) entry!.h.buckets[i]! += 1;
    });
    entry.h.sum += seconds;
    entry.h.count += 1;
  }

  gauge(fn: () => Array<{ name: string; help: string; labels?: Labels; value: number }>): void {
    this.gauges.push(fn);
  }

  /** Une requête servie : le trafic par minute et la médiane. */
  served(ms: number): void {
    this.roll();
    this.perMinute[this.perMinute.length - 1]! += 1;
    this.recent.push(ms);
    const hour = Math.floor(Date.now() / 3_600_000);
    const last = this.hours[this.hours.length - 1];
    if (last && last.hour === hour) last.count += 1;
    else this.hours.push({ hour, count: 1 });
    while (this.hours.length > 0 && this.hours[0]!.hour <= hour - 24) this.hours.shift();
    if (this.recent.length > 2000) this.recent.splice(0, this.recent.length - 2000);
  }

  private roll(): void {
    const now = Math.floor(Date.now() / 60_000);
    const steps = Math.min(60, now - this.minute);
    for (let i = 0; i < steps; i += 1) {
      this.perMinute.shift();
      this.perMinute.push(0);
    }
    this.minute = now;
  }

  traffic(): number[] {
    this.roll();
    return [...this.perMinute];
  }

  /** Requêtes servies sur les dernières 24 h. */
  served24h(): number {
    const hour = Math.floor(Date.now() / 3_600_000);
    return this.hours.filter((h) => h.hour > hour - 24).reduce((n, h) => n + h.count, 0);
  }

  medianMs(): number | null {
    if (this.recent.length === 0) return null;
    const sorted = [...this.recent].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
  }

  render(): string {
    const lines: string[] = [];
    const head = (name: string, fallback: string) => {
      const h = this.help.get(name);
      lines.push(`# HELP ${name} ${h?.text ?? name}`);
      lines.push(`# TYPE ${name} ${h?.type ?? fallback}`);
    };
    for (const [name, series] of this.counters) {
      head(name, 'counter');
      for (const { labels, value } of series.values()) lines.push(`${name}${labelText(labels)} ${value}`);
    }
    for (const [name, series] of this.histograms) {
      head(name, 'histogram');
      for (const { labels, h } of series.values()) {
        let cumulative = 0;
        BUCKETS.forEach((b, i) => {
          cumulative = h.buckets[i]!;
          lines.push(`${name}_bucket${labelText({ ...labels, le: String(b) })} ${cumulative}`);
        });
        lines.push(`${name}_bucket${labelText({ ...labels, le: '+Inf' })} ${h.count}`);
        lines.push(`${name}_sum${labelText(labels)} ${h.sum}`);
        lines.push(`${name}_count${labelText(labels)} ${h.count}`);
      }
    }
    const seen = new Set<string>();
    for (const fn of this.gauges) {
      for (const g of fn()) {
        if (!seen.has(g.name)) {
          lines.push(`# HELP ${g.name} ${g.help}`);
          lines.push(`# TYPE ${g.name} gauge`);
          seen.add(g.name);
        }
        lines.push(`${g.name}${labelText(g.labels ?? {})} ${g.value}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }
}
