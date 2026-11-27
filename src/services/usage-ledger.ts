import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Metadata-only request ledger behind the console overview. It stores counters per hour and dimension
 * (model / sub-key / client IP / upstream account) plus a short ring of recent requests. It never stores
 * prompts, responses or any message content.
 */

export interface LedgerCounters {
  requests: number;
  errors: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

interface Bucket extends LedgerCounters {
  hour: number;
  model: string;
  routedModel?: string;
  key: string;
  ip: string;
  account: string;
}

export interface LedgerRecord {
  at: number;
  model: string;
  /** Actual underlying upstream model returned by AWS Quick dynamic routing (e.g. claude-opus-5-5). */
  routedModel?: string;
  key: string;
  ip: string;
  account: string;
  ok: boolean;
  status: number;
  durationMs: number;
  ttftMs?: number;
  execMode?: string;
  usedProxy?: boolean;
  protocol: string;
  stream: boolean;
  /** Sanitized User-Agent (capped); metadata only. */
  ua?: string;
  /** Coarse client label derived from the User-Agent (Kilo / Claude Code / ...). */
  client?: string;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

export type LedgerRange = "today" | "7d" | "30d";

const HOUR = 3_600_000;
const RETENTION_HOURS = 24 * 30;
const MAX_BUCKETS = 40_000;
const RECENT_LIMIT = 100;
const UNKNOWN = "-";

const zero = (): LedgerCounters => ({ requests: 0, errors: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 });
const add = (t: LedgerCounters, r: LedgerCounters): void => {
  t.requests += r.requests;
  t.errors += r.errors;
  t.inputTokens += r.inputTokens;
  t.cacheReadTokens += r.cacheReadTokens;
  t.outputTokens += r.outputTokens;
};
const totalTokens = (c: LedgerCounters): number => c.inputTokens + c.cacheReadTokens + c.outputTokens;

export class UsageLedger {
  private buckets = new Map<string, Bucket>();
  private recent: LedgerRecord[] = [];
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private writeEpoch = 0;
  private tmpSeq = 0;

  constructor(
    private readonly filePath: string | undefined,
    private readonly recordIp = true
  ) {
    this.load();
  }

  record(r: LedgerRecord): void {
    const routedModel = r.routedModel ? String(r.routedModel).replace(/^us\.anthropic\./, "").trim() : undefined;
    const rec: LedgerRecord = {
      ...r,
      model: r.model || UNKNOWN,
      ...(routedModel ? { routedModel } : {}),
      key: r.key || UNKNOWN,
      ip: this.recordIp ? r.ip || UNKNOWN : UNKNOWN,
      account: r.account || UNKNOWN
    };
    this.recent.unshift(rec);
    if (this.recent.length > RECENT_LIMIT) this.recent.length = RECENT_LIMIT;

    const hour = Math.floor(rec.at / HOUR);
    const id = `${hour}|${rec.model}|${routedModel || ""}|${rec.key}|${rec.ip}|${rec.account}`;
    let b = this.buckets.get(id);
    if (!b) {
      b = {
        hour,
        model: rec.model,
        ...(routedModel ? { routedModel } : {}),
        key: rec.key,
        ip: rec.ip,
        account: rec.account,
        ...zero()
      };
      this.buckets.set(id, b);
      if (this.buckets.size > MAX_BUCKETS) this.prune(hour);
    }
    b.requests += 1;
    if (!rec.ok) b.errors += 1;
    b.inputTokens += rec.inputTokens;
    b.cacheReadTokens += rec.cacheReadTokens;
    b.outputTokens += rec.outputTokens;
    this.markDirty();
  }

  overview(range: LedgerRange, now = Date.now()) {
    const nowHour = Math.floor(now / HOUR);
    let since: number;
    let bucketHours: number;
    if (range === "today") {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      since = Math.floor(d.getTime() / HOUR);
      bucketHours = 1;
    } else if (range === "7d") {
      since = nowHour - 24 * 7 + 1;
      bucketHours = 6;
    } else {
      since = nowHour - 24 * 30 + 1;
      bucketHours = 24;
    }

    const totals = zero();
    const byModel = new Map<string, LedgerCounters>();
    const byRoutedModel = new Map<string, LedgerCounters>();
    const byKey = new Map<string, LedgerCounters>();
    const byIp = new Map<string, LedgerCounters>();
    const byAccount = new Map<string, LedgerCounters>();
    const trend = new Map<number, LedgerCounters>();
    const bump = (m: Map<string | number, LedgerCounters>, k: string | number, b: Bucket) => {
      let c = m.get(k);
      if (!c) m.set(k, (c = zero()));
      add(c, b);
    };

    for (const b of this.buckets.values()) {
      if (b.hour < since || b.hour > nowHour) continue;
      add(totals, b);
      bump(byModel, b.model, b);
      if (b.routedModel) bump(byRoutedModel, b.routedModel, b);
      bump(byKey, b.key, b);
      bump(byIp, b.ip, b);
      bump(byAccount, b.account, b);
      bump(trend, since + Math.floor((b.hour - since) / bucketHours) * bucketHours, b);
    }

    const rank = (m: Map<string | number, LedgerCounters>, limit: number) =>
      [...m.entries()]
        .map(([name, c]) => ({ name: String(name), ...c, totalTokens: totalTokens(c) }))
        .sort((a, b) => b.totalTokens - a.totalTokens || b.requests - a.requests)
        .slice(0, limit);

    const points: Array<{ t: number } & LedgerCounters> = [];
    for (let h = since; h <= nowHour; h += bucketHours) {
      points.push({ t: h * HOUR, ...(trend.get(h) ?? zero()) });
    }

    const promptTokens = totals.inputTokens + totals.cacheReadTokens;
    return {
      range,
      since: since * HOUR,
      bucketHours,
      totals: {
        ...totals,
        totalTokens: totalTokens(totals),
        cacheHitRatePercent: promptTokens > 0 ? Number(((totals.cacheReadTokens / promptTokens) * 100).toFixed(1)) : 0
      },
      byModel: rank(byModel, 8),
      byRoutedModel: rank(byRoutedModel, 10),
      byKey: rank(byKey, 8),
      byIp: rank(byIp, 10),
      byAccount: rank(byAccount, 8),
      trend: points,
      recent: this.recent.slice(0, RECENT_LIMIT)
    };
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.writeEpoch += 1;
    if (!this.dirty || !this.filePath) return;
    this.dirty = false;
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.${++this.tmpSeq}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, buckets: [...this.buckets.values()], recent: this.recent.slice(0, 30) }), { mode: 0o600 });
      renameSync(tmp, this.filePath);
    } catch {
      this.dirty = true; // keep counting in memory; retry on the next flush
    }
  }

  private enqueueAsyncFlush(): void {
    if (!this.dirty || !this.filePath) return;
    this.dirty = false;
    const filePath = this.filePath;
    const epoch = ++this.writeEpoch;
    const payload = JSON.stringify({ v: 1, buckets: [...this.buckets.values()], recent: this.recent.slice(0, 30) });
    this.writeChain = this.writeChain
      .then(async () => {
        if (epoch !== this.writeEpoch) return;
        const tmp = `${filePath}.${process.pid}.${++this.tmpSeq}.tmp`;
        try {
          await mkdir(path.dirname(filePath), { recursive: true });
          await writeFile(tmp, payload, { mode: 0o600 });
          if (epoch !== this.writeEpoch) {
            await unlink(tmp).catch(() => { });
            return;
          }
          await rename(tmp, filePath);
        } catch {
          await unlink(tmp).catch(() => { });
          if (epoch === this.writeEpoch) this.dirty = true;
        }
      })
      .catch(() => { });
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.timer || !this.filePath) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.enqueueAsyncFlush();
    }, 30_000);
    this.timer.unref?.();
  }

  private prune(nowHour: number): void {
    const cutoff = nowHour - RETENTION_HOURS;
    for (const [id, b] of this.buckets) if (b.hour < cutoff) this.buckets.delete(id);
    if (this.buckets.size <= MAX_BUCKETS) return;
    const sorted = [...this.buckets.entries()].sort((a, b) => a[1].hour - b[1].hour);
    for (const [id] of sorted.slice(0, this.buckets.size - MAX_BUCKETS)) this.buckets.delete(id);
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const data = JSON.parse(readFileSync(this.filePath, "utf8")) as { buckets?: Bucket[]; recent?: LedgerRecord[] };
      const cutoff = Math.floor(Date.now() / HOUR) - RETENTION_HOURS;
      for (const b of data.buckets ?? []) {
        if (typeof b.hour !== "number" || b.hour < cutoff) continue;
        const ip = this.recordIp ? b.ip || UNKNOWN : UNKNOWN;
        this.buckets.set(`${b.hour}|${b.model}|${b.routedModel || ""}|${b.key}|${ip}|${b.account}`, { ...zero(), ...b, ip });
      }
      this.recent = (data.recent ?? []).slice(0, RECENT_LIMIT);
    } catch {
      // A corrupt ledger must never block startup; start empty.
    }
  }
}
