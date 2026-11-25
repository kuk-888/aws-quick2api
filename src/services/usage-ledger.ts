import type { DatabaseSync } from "node:sqlite";
import { openDatabaseFor } from "../storage/db.js";

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
  private readonly db: DatabaseSync;
  private lastPruneHour = 0;

  constructor(
    dbFile: string | undefined,
    private readonly recordIp = true
  ) {
    this.db = openDatabaseFor(dbFile);
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
    this.db
      .prepare(
        "INSERT INTO usage_buckets (hour, model, routed_model, key, ip, account, requests, errors, input_tokens, cache_read_tokens, output_tokens) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(hour, model, routed_model, key, ip, account) DO UPDATE SET " +
          "requests = excluded.requests, errors = excluded.errors, input_tokens = excluded.input_tokens, " +
          "cache_read_tokens = excluded.cache_read_tokens, output_tokens = excluded.output_tokens",
      )
      .run(
        b.hour,
        b.model,
        b.routedModel ?? "",
        b.key,
        b.ip,
        b.account,
        b.requests,
        b.errors,
        b.inputTokens,
        b.cacheReadTokens,
        b.outputTokens,
      );
    this.db.prepare("INSERT INTO usage_recent (at, payload) VALUES (?, ?)").run(rec.at, JSON.stringify(rec));
    if (hour !== this.lastPruneHour) this.prune(hour);
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

  /** No-op kept for callers that used to flush a JSON file; SQLite writes are immediate. */
  flush(): void {}

  private prune(nowHour: number): void {
    const cutoff = nowHour - RETENTION_HOURS;
    for (const [id, b] of this.buckets) if (b.hour < cutoff) this.buckets.delete(id);
    if (this.buckets.size > MAX_BUCKETS) {
      const sorted = [...this.buckets.entries()].sort((a, b) => a[1].hour - b[1].hour);
      for (const [id] of sorted.slice(0, this.buckets.size - MAX_BUCKETS)) this.buckets.delete(id);
    }
    this.db.prepare("DELETE FROM usage_buckets WHERE hour < ?").run(cutoff);
    this.db
      .prepare(
        "DELETE FROM usage_recent WHERE id NOT IN (SELECT id FROM usage_recent ORDER BY at DESC, id DESC LIMIT ?)",
      )
      .run(RECENT_LIMIT);
    this.lastPruneHour = nowHour;
  }

  private load(): void {
    const cutoff = Math.floor(Date.now() / HOUR) - RETENTION_HOURS;
    try {
      const rows = this.db
        .prepare(
          "SELECT hour, model, routed_model, key, ip, account, requests, errors, input_tokens, cache_read_tokens, output_tokens FROM usage_buckets WHERE hour >= ?",
        )
        .all(cutoff) as Array<{
        hour: number;
        model: string;
        routed_model: string;
        key: string;
        ip: string;
        account: string;
        requests: number;
        errors: number;
        input_tokens: number;
        cache_read_tokens: number;
        output_tokens: number;
      }>;
      for (const row of rows) {
        const ip = this.recordIp ? row.ip || UNKNOWN : UNKNOWN;
        const bucket: Bucket = {
          hour: row.hour,
          model: row.model,
          ...(row.routed_model ? { routedModel: row.routed_model } : {}),
          key: row.key,
          ip,
          account: row.account,
          requests: row.requests,
          errors: row.errors,
          inputTokens: row.input_tokens,
          cacheReadTokens: row.cache_read_tokens,
          outputTokens: row.output_tokens,
        };
        this.buckets.set(`${row.hour}|${row.model}|${row.routed_model || ""}|${row.key}|${ip}|${row.account}`, bucket);
      }
      const recentRows = this.db
        .prepare("SELECT payload FROM usage_recent ORDER BY at DESC, id DESC LIMIT ?")
        .all(RECENT_LIMIT) as Array<{ payload: string }>;
      this.recent = recentRows
        .map((row) => {
          try {
            return JSON.parse(row.payload) as LedgerRecord;
          } catch {
            return undefined;
          }
        })
        .filter((rec): rec is LedgerRecord => Boolean(rec));
    } catch {
      // A damaged ledger must never block startup; start empty.
      this.buckets.clear();
      this.recent = [];
    }
  }
}
