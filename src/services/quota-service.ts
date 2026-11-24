import {
  fetchOAuthProfileUsage,
  fetchOAuthUserIdentity,
  getCachedOAuthUserIdentity,
  listOAuthCloudSessions,
  resolveOAuthAccessToken,
} from "../aws-quick/oauth-client.js";
import { getSharedOutpost, parseQuickCredential } from "../aws-quick/outpost-singleton.js";
import { fetchWebProfileUsage, listWebCloudSessions } from "../aws-quick/web-client.js";
import { maskSecretKey } from "../core/key-pool.js";

export interface QuickPlanQuotaView {
  membershipType: string;
  billingCycleStart?: string;
  billingCycleEnd?: string;
  daysRemainingInCycle?: number;
  trialExpiresAt?: string;
  trialDaysRemaining?: number;
  autoDisplayMessage?: string;
  apiDisplayMessage?: string;
  /** AWS Quick Session usage pool (5h rolling burst window) */
  sessionPool: {
    usedPercent: number | null;
    remainingPercent: number | null;
    /** Minutes until AWS Quick restores usable session burst capacity (null/undefined when not throttled). */
    resumeInMinutes?: number | null;
    /** Estimated ISO timestamp when session burst capacity resumes (`now + resumeInMinutes * 60s`). */
    resumeAt?: string;
  };
  /** AWS Quick Monthly usage pool (minutes) */
  premiumApiPool: {
    usedPercent: number | null;
    remainingPercent: number | null;
  };
  overallIncludedPlan: {
    usedPercent: number | null;
    remainingPercent: number | null;
    allowanceUsd: number | null;
    breakdownUsd?: {
      includedUsd: number;
      bonusUsd: number;
      totalUsd: number;
    };
  };
  onDemandSpend: {
    enabled: boolean;
    usedUsd: number;
    limitUsd: number | null;
    remainingUsd: number | null;
  };
}

export interface BotQuotaView {
  hasLimit: boolean;
  usedPercent: number | null;
  remainingPercent: number | null;
  hasAvailableUsage: boolean;
  periodStart?: string;
  resetAt?: string;
}

export interface AccountQuotaReport {
  maskedKey: string;
  status: "ok" | "error";
  bot?: BotQuotaView;
  cloudSessionCount?: number | null;
  tokenRemainingSec?: number | null;
  identity?: {
    apiKeyName: string;
    userEmail?: string;
    displayName?: string;
    userId?: number;
    createdAt: string;
  };
  quota?: QuickPlanQuotaView;
  error?: string;
}

const summaryCache = new Map<string, { report: AccountQuotaReport; expiresAtMs: number }>();
const SUMMARY_CACHE_TTL_MS = 30_000;

export function evictQuotaCachesForKey(apiKey: string): void {
  summaryCache.delete(apiKey);
}

function formatMinutesAsHours(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

async function fetchSingleAwsQuickQuota(
  apiKey: string,
  force = false,
  proxyUrl?: string,
): Promise<AccountQuotaReport> {
  const now = Date.now();
  if (!force) {
    const cached = summaryCache.get(apiKey);
    if (cached && cached.expiresAtMs > now) return cached.report;
  }

  const maskedKey = maskSecretKey(apiKey);
  try {
    const cred = parseQuickCredential(apiKey);
    let usage;
    let cloudSessions;
    let accountId: string | undefined;
    let region: string | undefined = "us-east-1";
    let tokenRemainingSec: number | null = null;
    let apiKeyName = "local-outpost";

    let userEmail: string | undefined;
    let displayName: string | undefined;

    if (cred.mode === "oauth" && cred.oauth) {
      apiKeyName = "oauth-pkce (90d)";
      region = cred.oauth.region || "us-east-1";
      accountId = cred.oauth.accountId || cred.oauth.clientId.slice(0, 12);
      const cachedId = getCachedOAuthUserIdentity(cred.oauth.clientId);
      const needIdentityProbe = (!cred.oauth.email && !cachedId?.email) || (!cred.oauth.name && !cachedId?.name);
      const [tok, u, cs, probedId] = await Promise.all([
        resolveOAuthAccessToken(cred.oauth, force, proxyUrl),
        fetchOAuthProfileUsage(cred.oauth, proxyUrl),
        listOAuthCloudSessions(cred.oauth, 100, proxyUrl).catch(() => null),
        needIdentityProbe ? fetchOAuthUserIdentity(cred.oauth, proxyUrl).catch(() => null) : Promise.resolve(null),
      ]);
      usage = u;
      cloudSessions = cs;
      tokenRemainingSec = Math.max(0, Math.floor((tok.expiresAt - now) / 1000));
      const resolvedId = probedId || cachedId;
      userEmail = cred.oauth.email || resolvedId?.email;
      displayName = cred.oauth.name || resolvedId?.name;
      if (resolvedId?.accountId) accountId = resolvedId.accountId;
    } else if (cred.mode === "web" && cred.web) {
      apiKeyName = "web-cookie";
      accountId = cred.web.accountId;
      const [u, cs] = await Promise.all([
        fetchWebProfileUsage(cred.web, proxyUrl),
        listWebCloudSessions(cred.web, 100, proxyUrl).catch(() => null),
      ]);
      usage = u;
      cloudSessions = cs;
    } else {
      apiKeyName = cred.mode === "outpost" ? "local-outpost" : "imported-token";
      const outpost = await getSharedOutpost();
      if (cred.mode === "token" && cred.jwt) {
        outpost.setImportedToken({ jwt: cred.jwt, wsHost: cred.wsHost, outpostId: cred.outpostId });
      } else {
        outpost.setImportedToken(null);
      }
      const [session, u, cs] = await Promise.all([
        outpost.getSncsSession(force),
        outpost.getProfileUsage(),
        outpost.listCloudSessions(100).catch(() => null),
      ]);
      usage = u;
      cloudSessions = cs;
      accountId = session.accountId;
      region = session.region || "us-east-1";
      tokenRemainingSec = session.usableUntil
        ? Math.max(0, Math.floor(session.usableUntil - now / 1000))
        : null;
    }

    const sessUsed = Number(usage.session?.used ?? 0);
    const sessLimit = Number(usage.session?.limit ?? 100);
    const sessPct = sessLimit > 0 ? Math.min(100, Math.round((sessUsed / sessLimit) * 1000) / 10) : 0;
    const rawSessResumeMin = usage.session?.resume_in_minutes;
    const rawSessResetsAt = typeof usage.session?.resets_at === "number" && Number.isFinite(usage.session.resets_at)
      ? usage.session.resets_at * 1000
      : Number.NaN;
    const sessResumeMin =
      typeof rawSessResumeMin === "number" && Number.isFinite(rawSessResumeMin) && rawSessResumeMin > 0
        ? Math.ceil(rawSessResumeMin)
        : Number.isFinite(rawSessResetsAt) && rawSessResetsAt > now
          ? Math.max(1, Math.ceil((rawSessResetsAt - now) / 60_000))
          : null;
    const sessResumeAt = sessResumeMin
      ? new Date(Number.isFinite(rawSessResetsAt) && rawSessResetsAt > now && !(typeof rawSessResumeMin === "number" && rawSessResumeMin > 0) ? rawSessResetsAt : now + sessResumeMin * 60_000).toISOString()
      : undefined;

    const monUsed = Number(usage.monthly?.used ?? 0);
    const monLimit = Number(usage.monthly?.limit ?? 600);
    const monPct = monLimit > 0 ? Math.min(100, Math.round((monUsed / monLimit) * 1000) / 10) : 0;

    const resetEpoch = typeof usage.monthly?.resets_at === "number" ? usage.monthly.resets_at : undefined;
    const billingCycleEnd = resetEpoch ? new Date(resetEpoch * 1000).toISOString() : undefined;
    const daysRemainingInCycle = resetEpoch
      ? Math.max(0, Math.ceil((resetEpoch * 1000 - now) / 86_400_000))
      : undefined;

    const trialEpoch = typeof usage.subscription?.free_trial_metadata?.expiry_date === "number"
      ? usage.subscription.free_trial_metadata.expiry_date
      : undefined;
    const trialExpiresAt = trialEpoch ? new Date(trialEpoch * 1000).toISOString() : undefined;
    const trialDaysRemaining = trialEpoch
      ? Math.max(0, Math.ceil((trialEpoch * 1000 - now) / 86_400_000))
      : undefined;

    const subType = usage.subscription?.subscription_type || "AWS_QUICK";

    const report: AccountQuotaReport = {
      maskedKey,
      status: "ok",
      cloudSessionCount: cloudSessions ? cloudSessions.length : null,
      tokenRemainingSec,
      identity: {
        apiKeyName,
        userEmail: userEmail || (accountId ? `aws:${accountId} (${region})` : region),
        ...(displayName ? { displayName } : {}),
        createdAt: new Date(now).toISOString(),
      },
      quota: {
        membershipType: subType,
        billingCycleEnd,
        daysRemainingInCycle,
        ...(trialExpiresAt ? { trialExpiresAt } : {}),
        ...(trialDaysRemaining !== undefined ? { trialDaysRemaining } : {}),
        autoDisplayMessage: `Session ${sessUsed}/${sessLimit}`,
        apiDisplayMessage: `Monthly ${formatMinutesAsHours(monUsed)} / ${formatMinutesAsHours(monLimit)}`,
        sessionPool: {
          usedPercent: sessPct,
          remainingPercent: Math.max(0, Math.round((100 - sessPct) * 10) / 10),
          ...(sessResumeMin !== null ? { resumeInMinutes: sessResumeMin } : {}),
          ...(sessResumeAt ? { resumeAt: sessResumeAt } : {}),
        },
        premiumApiPool: {
          usedPercent: monPct,
          remainingPercent: Math.max(0, Math.round((100 - monPct) * 10) / 10),
        },
        overallIncludedPlan: {
          usedPercent: monPct,
          remainingPercent: Math.max(0, Math.round((100 - monPct) * 10) / 10),
          allowanceUsd: null,
        },
        onDemandSpend: {
          enabled: false,
          usedUsd: 0,
          limitUsd: null,
          remainingUsd: null,
        },
      },
    };

    summaryCache.set(apiKey, { report, expiresAtMs: now + SUMMARY_CACHE_TTL_MS });
    return report;
  } catch (err) {
    return {
      maskedKey,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function fetchAllAccountQuotas(
  apiKeys: string[],
  options?: {
    force?: boolean;
    forceRefresh?: boolean;
    meFetcher?: unknown;
    fetchImpl?: unknown;
    fetcher?: unknown;
    proxyByKey?: (apiKey: string) => string | undefined;
  },
): Promise<AccountQuotaReport[]> {
  const results = new Array<AccountQuotaReport>(apiKeys.length);
  const force = Boolean(options?.force || options?.forceRefresh);
  const concurrency = Math.min(4, Math.max(1, apiKeys.length));
  let cursor = 0;
  const worker = async () => {
    while (cursor < apiKeys.length) {
      const idx = cursor++;
      const key = apiKeys[idx]!;
      results[idx] = await fetchSingleAwsQuickQuota(key, force, options?.proxyByKey?.(key));
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}
