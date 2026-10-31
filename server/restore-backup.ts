import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DB_NAME, MANIFEST_NAME, readManifest, snapshotFile, verifySnapshot } from "./backup-files";

/** Offline operation only: never imports configuration or opens the live gateway. */
export function restoreGatewayBackup(snapshotDirectory: string, destinationDirectory: string) {
  const source = realpathSync(snapshotDirectory);
  const target = path.resolve(destinationDirectory);
  const parent = path.dirname(target);
  if (!existsSync(parent) || !lstatSync(parent).isDirectory()) throw new Error("destination parent directory must already exist");
  const actualTarget = path.join(realpathSync(parent), path.basename(target));
  const inside = (base: string, candidate: string) => { const relative = path.relative(base, candidate); return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative)); };
  if (inside(source, actualTarget) || inside(actualTarget, source)) throw new Error("restore destination must be separate from the snapshot");
  if (existsSync(target) && (lstatSync(target).isSymbolicLink() || !lstatSync(target).isDirectory() || readdirSync(target).length)) {
    throw new Error("restore destination must be a new or empty directory");
  }
  const manifest = readManifest(source);
  if (!manifest) throw new Error("snapshot manifest is missing or invalid");
  const verification = verifySnapshot(source, manifest);
  if (!verification.ok) throw new Error(verification.error ?? "snapshot verification failed");
  const staging = path.join(parent, `.indirect-restore-${randomUUID()}`);
  if (!inside(realpathSync(parent), path.join(realpathSync(parent), path.basename(staging)))) throw new Error("invalid restore staging path");
  mkdirSync(staging, { mode: 0o700 });
  try {
    for (const entry of manifest.files) {
      const destination = path.join(staging, ...entry.path.split("/"));
      mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      copyFileSync(snapshotFile(source, entry.path), destination);
      if (entry.path.startsWith("secret/")) chmodSync(destination, 0o600);
    }
    copyFileSync(path.join(source, MANIFEST_NAME), path.join(staging, "restore-manifest.json"));
    const secretName = manifest.secretFromEnv ? "secret/INDIRECT_SECRET.env" : "secret/.secret";
    const stored = readFileSync(snapshotFile(source, secretName), "utf8");
    const secret = manifest.secretFromEnv ? Buffer.from(stored.trim(), "base64").toString("utf8") : stored.trim();
    if (secret.length < 32) throw new Error("snapshot credential secret is invalid");
    writeFileSync(path.join(staging, ".secret"), secret, { mode: 0o600 });
    const copied = verifySnapshot(staging, manifest);
    if (!copied.ok) throw new Error(copied.error ?? "restored copy verification failed");
    // Recheck immediately before publication. An unexpected writer must never
    // have its data replaced by an operator's restore command.
    if (existsSync(target)) {
      if (lstatSync(target).isSymbolicLink() || readdirSync(target).length) throw new Error("restore destination is no longer empty");
      // Non-recursive removal of the explicitly selected empty directory only.
      rmdirSync(target);
    }
    renameSync(staging, target);
    return { destination: target, database: path.join(target, DB_NAME), secretFile: path.join(target, ".secret"), schemaVersion: manifest.schemaVersion, files: manifest.files.length };
  } catch (error) {
    // staging is a fresh UUID child of the verified destination parent.
    const expected = path.join(parent, path.basename(staging));
    if (staging === expected && path.basename(staging).startsWith(".indirect-restore-")) rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    throw error;
  }
}
