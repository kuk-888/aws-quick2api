import { fork, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "./core/config.js";
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
      const target = resolveBootTarget({ dataDir: opts.dataDir, builtinAppRoot: builtin.appRoot });
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        ...(opts.extraEnv ?? {}),
        AWS_QUICK_SUPERVISED: "1",
        AWS_QUICK_BUILTIN_ROOT: builtin.appRoot,
        AWS_QUICK_BUILTIN_VERSION: builtin.version,
        AWS_QUICK_ACTIVE_RELEASE_DIR: target.releaseDir ?? "",
      };

      const outcome = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
        restartRequested: boolean;
        promoted: boolean;
      }>((resolve) => {
        let restartRequested = false;
        let promoted = !target.isPendingVerification;
        let healthyTimer: NodeJS.Timeout | null = null;

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
          const st = loadSelfUpdateState(opts.dataDir);
          if (st.pendingVersion === target.version) {
            try {
              saveSelfUpdateState(opts.dataDir, {
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

        child.on("message", (msg: unknown) => {
          if (!msg || typeof msg !== "object") return;
          const rec = msg as { type?: string };
          if (rec.type === "self_update_restart") {
            restartRequested = true;
          } else if (rec.type === "gateway_ready" && target.isPendingVerification && !promoted) {
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
          if (activeChild === child) activeChild = null;
          resolve({ code, signal, restartRequested, promoted });
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

      // Automatic crash rollback: newly updated release exited before startup promotion!
      if (target.kind === "hot" && target.isPendingVerification && !outcome.promoted) {
        const st = loadSelfUpdateState(opts.dataDir);
        const rollbackTo =
          st.previousVersion && st.previousVersion !== target.version ? st.previousVersion : null;
        const reason = `v${target.version} exited during startup verification (code=${outcome.code ?? "null"}, signal=${outcome.signal ?? "none"}); auto-rolled back to v${rollbackTo ?? builtin.version}.`;
        console.error(
          JSON.stringify({
            event: "self_update_auto_rollback",
            failedVersion: target.version,
            rollbackTo: rollbackTo ?? builtin.version,
            reason,
          }),
        );
        try {
          saveSelfUpdateState(opts.dataDir, {
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
  loadDotEnv();
  const dataDir = path.resolve(process.env.DATA_DIR?.trim() || path.resolve(process.cwd(), "data"));
  const builtinAppRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  runBootstrapSupervisor({ dataDir, builtinAppRoot })
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
