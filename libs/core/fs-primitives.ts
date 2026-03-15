import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Minimal low-level filesystem helpers for foundational modules that cannot
 * depend on secure-io without creating import cycles.
 *
 * Design constraints:
 * - Read/exists helpers stay low-level so path-resolver can probe parent dirs.
 * - Mutating helpers are limited to the active project root.
 * - This module is foundation-only and should not be used by feature code.
 */
function foundationRoot(): string {
  let current = path.resolve(process.cwd());
  const root = path.parse(current).root;

  while (current !== root) {
    if (
      fs.existsSync(path.join(current, 'package.json')) &&
      (fs.existsSync(path.join(current, 'libs')) || fs.existsSync(path.join(current, 'knowledge')))
    ) {
      return current;
    }
    current = path.dirname(current);
  }

  return path.resolve(process.cwd());
}

function assertFoundationWritePath(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  const root = foundationRoot();
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`[FOUNDATION_IO_VIOLATION] Write outside project root is not allowed: ${resolved}`);
  }
  return resolved;
}

export function rawExistsSync(targetPath: string): boolean {
  return fs.existsSync(targetPath);
}

export function rawReadTextFile(targetPath: string): string {
  return fs.readFileSync(targetPath, 'utf8');
}

export function rawReadBuffer(targetPath: string): Buffer {
  return fs.readFileSync(targetPath);
}

export function rawWriteFile(targetPath: string, data: string | Buffer): void {
  fs.writeFileSync(assertFoundationWritePath(targetPath), data);
}

export function rawMkdirp(targetPath: string): void {
  fs.mkdirSync(assertFoundationWritePath(targetPath), { recursive: true });
}

export function rawUnlinkSync(targetPath: string): void {
  fs.unlinkSync(assertFoundationWritePath(targetPath));
}

export function rawStatSync(targetPath: string): fs.Stats {
  return fs.statSync(targetPath);
}
