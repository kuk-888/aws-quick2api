#!/usr/bin/env node
/**
 * Builds the verified hot-update bundle (`aws-quick2api-dist-v<VERSION>.tar.gz` + `SHA256SUMS.txt`)
 * uploaded to GitHub Releases so both Docker and host deployments can self-update cleanly from
 * the Web Console without requiring `docker.sock` or `git`.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTarGzBuffer } from "../dist/src/services/tar-archive.js";
import { computeRuntimeDepsHash } from "../dist/src/services/self-updater.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

function parseOutDir() {
  const idx = process.argv.indexOf("--out");
  if (idx >= 0 && process.argv[idx + 1]) {
    return path.resolve(process.cwd(), process.argv[idx + 1]);
  }
  return path.join(REPO_ROOT, "release-assets");
}

function collectFilesRecursive(rootDir, currentDir, out) {
  const items = fs.readdirSync(currentDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const item of items) {
    const abs = path.join(currentDir, item.name);
    if (item.isDirectory()) {
      collectFilesRecursive(rootDir, abs, out);
    } else if (item.isFile()) {
      // Only include runtime `.js` / `.json` files (skip `.map`, `.d.ts`, macOS `._*`)
      if (item.name.startsWith("._")) continue;
      if (!item.name.endsWith(".js") && !item.name.endsWith(".json")) continue;
      out.push(path.relative(rootDir, abs).split(path.sep).join("/"));
    }
  }
}

function main() {
  const pkgPath = path.join(REPO_ROOT, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const version = String(pkg.version || "").trim();
  if (!version) {
    throw new Error("package.json is missing a valid `version` field.");
  }

  const distSrcDir = path.join(REPO_ROOT, "dist", "src");
  if (!fs.existsSync(path.join(distSrcDir, "server.js"))) {
    throw new Error("dist/src/server.js not found. Run `npm run build` first.");
  }

  const depsHash = computeRuntimeDepsHash(pkg);
  const majorMatch = /(\d+)/.exec(String(pkg.engines?.node ?? ""));
  const nodeMinMajor = majorMatch ? Number.parseInt(majorMatch[1], 10) : 22;

  const manifest = {
    version,
    depsHash,
    nodeMinMajor,
    builtAt: new Date().toISOString(),
    entry: "dist/src/server.js",
  };

  const relFiles = [];
  collectFilesRecursive(REPO_ROOT, distSrcDir, relFiles);

  const entries = [
    {
      path: "update-manifest.json",
      content: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    },
    {
      path: "package.json",
      content: fs.readFileSync(pkgPath),
    },
    ...relFiles.map((rel) => ({
      path: rel,
      content: fs.readFileSync(path.join(REPO_ROOT, rel)),
    })),
  ];

  const outDir = parseOutDir();
  fs.mkdirSync(outDir, { recursive: true });
  const bundleName = `aws-quick2api-dist-v${version}.tar.gz`;
  const bundlePath = path.join(outDir, bundleName);
  const checksumPath = path.join(outDir, "SHA256SUMS.txt");

  const gzBuf = createTarGzBuffer(entries);
  const sha256 = crypto.createHash("sha256").update(gzBuf).digest("hex");

  fs.writeFileSync(bundlePath, gzBuf);
  fs.writeFileSync(checksumPath, `${sha256}  ${bundleName}\n`, "utf8");

  console.log(
    JSON.stringify({
      event: "update_bundle_built",
      version,
      depsHash,
      files: entries.length,
      bundlePath,
      bundleBytes: gzBuf.byteLength,
      sha256,
      checksumPath,
    }),
  );
}

main();
