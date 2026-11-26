import { fork, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readDotEnvRaw, resolveGatewayDataDir } from "./core/config.js";
import {
  ensureReleaseNodeModulesLink,
  EXIT_CODE_SELF_UPDATE_RESTART,
  loadSelfUpdateState,
  readAndValidateReleaseManifest,
  readBuiltinRuntimeInfo,
  releaseDirForVersion,
  saveSelfUpdateState,
} from "./services/self-updater.js";
import { compareSemver } from "./services/update-checker.js";

export interface BootTarget {
  kind: "builtin" | "hot";
  version: string;
  entryPath: string;
  releaseDir?: string;
  isPendingVerification: boolean;
}

export function resolveBootTarget(opts: {
  dataDir: string;
  builtinAppRoot?: string;
}): BootTarget {
  const builtin = readBuiltinRuntimeInfo(opts.builtinAppRoot);
  const builtinEntry = path.join(builtin.appRoot, "dist", "src", "server.js");
  const state = loadSelfUpdateState(opts.dataDir);

  if (state.activeVersion) {
    // If Docker image or git pull upgraded built-in app to >= active hot version, prefer built-in!
    if (compareSemver(builtin.version, state.activeVersion) >= 0) {
      try {
        saveSelfUpdateState(opts.dataDir, {
          ...state,
          activeVersion: null,
          previousVersion: null,
          pendingVersion: null,
          lastUpdatedAt: new Date().toISOString(),
        });
      } catch {
        // Non-fatal if dataDir is read-only; server startup probe will handle it
      }
      return {
        kind: "builtin",
        version: builtin.version,
        entryPath: builtinEntry,
        isPendingVerification: false,
      };
    }

    const tryCandidate = (ver: string): BootTarget | null => {
      try {
        const dir = releaseDirForVersion(opts.dataDir, ver);
        const manifest = readAndValidateReleaseManifest(dir, builtin.depsHash);
        if (!manifest) return null;
        ensureReleaseNodeModulesLink(dir, builtin.appRoot);
        return {
          kind: "hot",
          version: ver,
          entryPath: path.join(dir, manifest.entry),
          releaseDir: dir,
          isPendingVerification: state.pendingVersion === ver,
        };
      } catch {
        return null;
      }
    };

    const primary = tryCandidate(state.activeVersion);
    if (primary) return primary;

    // Active release is corrupt or incompatible with current depsHash -> roll back cleanly!
    const fallbackVer =
      state.previousVersion && compareSemver(state.previousVersion, builtin.version) > 0
        ? state.previousVersion
        : null;
    const fallback = fallbackVer ? tryCandidate(fallbackVer) : null;
    const reason = `Hot release v${state.activeVersion} missing or incompatible with runtime dependencies; rolled back.`;
    console.warn(
      JSON.stringify({
        event: "self_update_boot_fallback",
        failedVersion: state.activeVersion,
        targetVersion: fallback ? fallback.version : builtin.version,
        reason,
      }),
    );
    try {
      saveSelfUpdateState(opts.dataDir, {
        ...state,
        activeVersion: fallback ? fallback.version : null,
        previousVersion: null,
        pendingVersion: null,
        failedVersions: Array.from(new Set([...state.failedVersions, state.activeVersion])),
        lastRollbackReason: reason,
        lastUpdatedAt: new Date().toISOString(),
      });
    } catch {
      // Non-fatal
    }
    if (fallback) return fallback;
  }

  return {
    kind: "builtin",
    version: builtin.version,
    entryPath: builtinEntry,
    isPendingVerification: false,
  };
}

export interface BootstrapSupervisorOptions {
  dataDir: string;
  builtinAppRoot?: string;
  /** How long a newly updated release must remain healthy after `gateway_ready` before promotion. */
  healthyGraceMs?: number;
  /** Max time to wait for `gateway_ready` on a pending hot release before killing & auto-rolling back. */
  startupReadyTimeoutMs?: number;
  /** Base environment passed to spawned server children (defaults to process.env; excludes `.env` expansion to avoid Linux E2BIG). */
  baseEnv?: NodeJS.ProcessEnv;
  /** Extra environment variables passed to spawned server children. */
  extraEnv?: Record<string, string>;
  /** Optional hook called before spawning each child (useful in tests). */
  onSpawn?: (target: BootTarget, child: ChildProcess) => void;
  /** Optional AbortSignal to stop the supervisor cleanly (useful in tests). */
  signal?: AbortSignal;
}

/**
 * Thin supervisor loop that launches the active gateway release (`builtin` or hot-updated),
 * handles instant in-place restarts on `EXIT_CODE_SELF_UPDATE_RESTART` (75), and automatically
 * rolls back to the previous known-good version if a newly updated release crashes during startup.
 */
export async function runBootstrapSupervisor(opts: BootstrapSupervisorOptions): Promise<number> {
  const builtin = readBuiltinRuntimeInfo(opts.builtinAppRoot);
  const envGrace = Number.parseInt(process.env.SELF_UPDATE_HEALTHY_MS || "", 10);
  const healthyGraceMs =
    opts.healthyGraceMs ?? (Number.isFinite(envGrace) && envGrace >= 0 ? envGrace : 5_000);
  const startupReadyTimeoutMs =
    opts.startupReadyTimeoutMs ?? 25_000;
  const resolvedDataDir = path.resolve(opts.dataDir);

  let activeChild: ChildProcess | null = null;
  let shuttingDown = false;

  const forwardSignal = (sig: NodeJS.Signals) => {
    shuttingDown = true;
    if (activeChild && !activeChild.killed) {
      try {
        activeChild.kill(sig);
      } catch {
        // ignore
      }
    }
  };

  const onSigInt = () => forwardSignal("SIGINT");
  const onSigTerm = () => forwardSignal("SIGTERM");
  const onAbort = () => forwardSignal("SIGTERM");

  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (!shuttingDown) {
      const target = resolveBootTarget({ dataDir: resolvedDataDir, builtinAppRoot: builtin.appRoot });
      const childEnv: NodeJS.ProcessEnv = {
        ...(opts.baseEnv ?? process.env),
        ...(opts.extraEnv ?? {}),
        AWS_QUICK_SUPERVISED: "1",
        AWS_QUICK_BUILTIN_ROOT: builtin.appRoot,
        AWS_QUICK_BUILTIN_VERSION: builtin.version,
        AWS_QUICK_ACTIVE_RELEASE_DIR: target.releaseDir ?? "",
        AWS_QUICK_UPDATES_DATA_DIR: resolvedDataDir,
      };

      const outcome = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
        restartRequested: boolean;
        promoted: boolean;
        timedOut: boolean;
      }>((resolve) => {
        let restartRequested = false;
        let promoted = !target.isPendingVerification;
        let readyReceived = false;
        let timedOut = false;
        let healthyTimer: NodeJS.Timeout | null = null;
        let readyTimer: NodeJS.Timeout | null = null;
        let forceKillTimer: NodeJS.Timeout | null = null;

        const child = fork(target.entryPath, process.argv.slice(2), {
          cwd: process.cwd(),
          env: childEnv,
          stdio: "inherit",
        });
        activeChild = child;
        opts.onSpawn?.(target, child);

        const promotePendingRelease = () => {
          if (promoted) return;
          promoted = true;
          const st = loadSelfUpdateState(resolvedDataDir);
          if (st.pendingVersion === target.version) {
            try {
              saveSelfUpdateState(resolvedDataDir, {
                ...st,
                pendingVersion: null,
                lastRollbackReason: undefined,
                lastUpdatedAt: new Date().toISOString(),
              });
            } catch {
              // ignore
            }
            console.log(
              JSON.stringify({
                event: "self_update_promoted",
                version: target.version,
              }),
            );
          }
        };

        if (target.isPendingVerification && startupReadyTimeoutMs > 0) {
          readyTimer = setTimeout(() => {
            readyTimer = null;
            if (readyReceived || shuttingDown) return;
            timedOut = true;
            try {
              child.kill("SIGTERM");
            } catch {
              // ignore
            }
            forceKillTimer = setTimeout(() => {
              forceKillTimer = null;
              try {
                child.kill("SIGKILL");
              } catch {
                // ignore
              }
            }, 2_000);
            forceKillTimer.unref?.();
          }, startupReadyTimeoutMs);
          readyTimer.unref?.();
        }

        child.on("message", (msg: unknown) => {
          if (!msg || typeof msg !== "object") return;
          const rec = msg as { type?: string };
          if (rec.type === "self_update_restart") {
            restartRequested = true;
          } else if (rec.type === "gateway_ready" && target.isPendingVerification && !promoted) {
            readyReceived = true;
            if (readyTimer) {
              clearTimeout(readyTimer);
              readyTimer = null;
            }
            if (healthyTimer) clearTimeout(healthyTimer);
            if (healthyGraceMs === 0) {
              promotePendingRelease();
            } else {
              healthyTimer = setTimeout(promotePendingRelease, healthyGraceMs);
              healthyTimer.unref?.();
            }
          }
        });

        child.once("exit", (code, signal) => {
          if (healthyTimer) {
            clearTimeout(healthyTimer);
            healthyTimer = null;
          }
          if (readyTimer) {
            clearTimeout(readyTimer);
            readyTimer = null;
          }
          if (forceKillTimer) {
            clearTimeout(forceKillTimer);
            forceKillTimer = null;
          }
          if (activeChild === child) activeChild = null;
          resolve({ code, signal, restartRequested, promoted, timedOut });
        });
      });

      if (shuttingDown) {
        return outcome.code ?? 0;
      }

      if (outcome.restartRequested || outcome.code === EXIT_CODE_SELF_UPDATE_RESTART) {
        console.log(
          JSON.stringify({
            event: "self_update_restarting",
            previousVersion: target.version,
          }),
        );
        continue;
      }

      // Automatic crash rollback: newly updated release exited or hung before startup promotion!
      if (target.kind === "hot" && target.isPendingVerification && !outcome.promoted) {
        const st = loadSelfUpdateState(resolvedDataDir);
        const rollbackTo =
          st.previousVersion && st.previousVersion !== target.version ? st.previousVersion : null;
        const reason = outcome.timedOut
          ? `v${target.version} did not become ready within ${Math.round(startupReadyTimeoutMs / 1000)}s; auto-rolled back to v${rollbackTo ?? builtin.version}.`
          : `v${target.version} exited during startup verification (code=${outcome.code ?? "null"}, signal=${outcome.signal ?? "none"}); auto-rolled back to v${rollbackTo ?? builtin.version}.`;
        console.error(
          JSON.stringify({
            event: "self_update_auto_rollback",
            failedVersion: target.version,
            rollbackTo: rollbackTo ?? builtin.version,
            reason,
          }),
        );
        try {
          saveSelfUpdateState(resolvedDataDir, {
            ...st,
            activeVersion: rollbackTo,
            previousVersion: null,
            pendingVersion: null,
            failedVersions: Array.from(new Set([...st.failedVersions, target.version])),
            lastRollbackReason: reason,
            lastUpdatedAt: new Date().toISOString(),
          });
        } catch {
          // ignore
        }
        continue;
      }

      return outcome.code ?? (outcome.signal ? 1 : 0);
    }
    return 0;
  } finally {
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
  }
})();
if (isMain) {
  // Snapshot inherited process.env BEFORE reading `.env` hints so large vars like `QUICK_TOKENS`
  // (>128KB with 60–100 OAuth accounts) are NEVER passed through Linux execve `fork()` (avoids E2BIG)
  // and `.env` edits always take effect fresh on every self-update respawn.
  const baseEnv: NodeJS.ProcessEnv = { ...process.env };
  const { envFilePath, values: dotEnvValues } = readDotEnvRaw();
  const mergedHints: Record<string, string | undefined> = { ...dotEnvValues, ...baseEnv };
  const dataDir =
    resolveGatewayDataDir(mergedHints, envFilePath) ?? path.resolve(process.cwd(), "data");
  const hintGrace = Number.parseInt(mergedHints.SELF_UPDATE_HEALTHY_MS || "", 10);
  const healthyGraceMs = Number.isFinite(hintGrace) && hintGrace >= 0 ? hintGrace : undefined;
  const builtinAppRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  runBootstrapSupervisor({
    dataDir,
    builtinAppRoot,
    baseEnv,
    ...(healthyGraceMs !== undefined ? { healthyGraceMs } : {}),
  })
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(
        JSON.stringify({
          event: "bootstrap_fatal_error",
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      process.exit(1);
    });
}
