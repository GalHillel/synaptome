import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Ownership of files and entries Synaptome writes outside its own home (plan NG, M1). Three rules:
 *  1. Everything written is recorded with a hash of exactly what was written.
 *  2. Removal takes away only what still matches that hash; anything the user changed is kept and reported.
 *  3. A multi-file change is a transaction: if any step fails, every file is put back as it was and every directory
 *     it created is removed again (when empty), so a failed change leaves nothing behind.
 */

export class OwnershipError extends Error {
  constructor(message: string, readonly file?: string) {
    super(message);
  }
}

export const sha256 = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');

/** JSON with sorted keys, so the same value always hashes the same whatever the key order on disk. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as any)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
export const valueSha = (v: unknown) => sha256(stableJson(v));

/** Writes through a temporary file in the same folder and renames it over the target, so a reader never sees half a file. */
export function writeAtomic(file: string, content: string | Buffer) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, content);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** Parses a JSON file; a file that does not parse is an error that names the file (it is never overwritten). */
export function readJsonStrict(file: string): any {
  const text = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new OwnershipError(`${file} is not valid JSON; it was left exactly as it is`, file);
  }
}

export const jsonText = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

/**
 * A set of file changes that either all happen or none do. Every write keeps the file's previous bytes (or notes it
 * did not exist) the first time the file is touched; `rollback` restores them in reverse order.
 */
export class Transaction {
  private touched: { file: string; before: Buffer | null }[] = [];
  private madeDirs: string[] = [];

  private mkdirs(dir: string) {
    const missing: string[] = [];
    for (let d = dir; !fs.existsSync(d); d = path.dirname(d)) missing.unshift(d);
    for (const d of missing) {
      fs.mkdirSync(d);
      this.madeDirs.push(d);
    }
  }

  write(file: string, content: string | Buffer) {
    if (!this.touched.some((t) => t.file === file)) this.touched.push({ file, before: fs.existsSync(file) ? fs.readFileSync(file) : null });
    this.mkdirs(path.dirname(file));
    writeAtomic(file, content);
  }

  remove(file: string) {
    if (!fs.existsSync(file)) return;
    if (!this.touched.some((t) => t.file === file)) this.touched.push({ file, before: fs.readFileSync(file) });
    fs.rmSync(file);
  }

  /** Directories this transaction created, deepest first (for records of what to clean up later). */
  createdDirs() {
    return [...this.madeDirs].reverse();
  }

  rollback() {
    for (const t of [...this.touched].reverse()) {
      try {
        if (t.before == null) fs.rmSync(t.file, { force: true });
        else {
          fs.mkdirSync(path.dirname(t.file), { recursive: true });
          writeAtomic(t.file, t.before);
        }
      } catch {
        /* best effort: keep restoring the rest */
      }
    }
    removeEmptyDirs(this.createdDirs());
    this.touched = [];
    this.madeDirs = [];
  }
}

/** Removes the given directories, deepest first, but only those that are empty. Returns those removed. */
export function removeEmptyDirs(dirs: string[]): string[] {
  const removed: string[] = [];
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    try {
      if (fs.existsSync(d) && fs.statSync(d).isDirectory() && !fs.readdirSync(d).length) {
        fs.rmdirSync(d);
        removed.push(d);
      }
    } catch {
      /* not ours to force */
    }
  }
  return removed;
}

export type RemovalResult = 'removed' | 'kept-edited' | 'missing';

/** Removes a file only if its content still hashes to what was written. */
export function removeFileIfUnchanged(file: string, expectedSha: string, txn?: Transaction): RemovalResult {
  if (!fs.existsSync(file)) return 'missing';
  if (sha256(fs.readFileSync(file)) !== expectedSha) return 'kept-edited';
  if (txn) txn.remove(file);
  else fs.rmSync(file);
  return 'removed';
}
