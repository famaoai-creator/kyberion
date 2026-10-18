/**
 * Editable-surface declaration (harness2 SurfaceSpec import).
 *
 * A surface spec declares which relative paths a candidate overlay may write,
 * plus optional file-count and size caps. Files outside the surface are
 * rejected before the probe runs — omitted paths inherit from the base copy
 * (omitted-is-inherited), so the spec bounds the *delta* a candidate may make.
 */

import * as path from 'node:path';
import {
  assertSafeRepositoryPath,
  loadJson,
  safeExistsSync,
  safeLstat,
  safeReaddir,
} from '../secure-io.js';

export interface SurfaceSpec {
  /** Allowed relative paths: exact, 'dir/' prefix, or glob with * segments. */
  allowed_paths: string[];
  max_files?: number;
  max_file_bytes?: number;
}

export interface OverlayValidation {
  ok: boolean;
  accepted_files: string[];
  rejected_files: Array<{ path: string; reason: string }>;
}

function relList(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of safeReaddir(dir).sort()) {
    const p = path.join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    const stat = safeLstat(p);
    if (stat.isDirectory()) out.push(...relList(p, rel));
    else if (stat.isFile()) out.push(rel);
  }
  return out;
}

/** Does rel match an allowed-path pattern? 'a/b.txt' exact; 'a/' prefix; 'a/*.txt' one-star-glob. */
function allowed(rel: string, patterns: string[]): boolean {
  for (const pat of patterns) {
    if (pat === rel) return true;
    if (pat.endsWith('/') && rel.startsWith(pat)) return true;
    if (pat.includes('*')) {
      const rx = new RegExp(
        `^${pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`
      );
      if (rx.test(rel)) return true;
    }
  }
  return false;
}

/** A rel path must be clean: no absolute, no '..', no empty segments —
 *  on either separator. Backslash is rejected outright so win32 semantics
 *  can never smuggle '..' past the '/'-based check. */
export function isValidRelPath(rel: string): boolean {
  if (!rel || rel.includes('\\') || path.isAbsolute(rel)) return false;
  return !rel.split('/').some((seg) => seg === '..' || seg === '');
}

export function loadSurfaceSpec(specPath: string): SurfaceSpec {
  const resolved = assertSafeRepositoryPath(specPath);
  const parsed = loadJson<SurfaceSpec>(resolved);
  if (!Array.isArray(parsed.allowed_paths) || parsed.allowed_paths.length === 0) {
    throw new Error('[SURFACE_SPEC] allowed_paths must be a non-empty array');
  }
  for (const p of parsed.allowed_paths) {
    if (!isValidRelPath(p) && !p.endsWith('/')) {
      throw new Error(`[SURFACE_SPEC] invalid allowed_path ${JSON.stringify(p)}`);
    }
  }
  return parsed;
}

export function validateOverlay(overlayDir: string, spec: SurfaceSpec): OverlayValidation {
  const dir = assertSafeRepositoryPath(overlayDir, { allowMissingLeaf: true });
  if (!safeExistsSync(dir)) {
    return {
      ok: false,
      accepted_files: [],
      rejected_files: [{ path: '.', reason: 'overlay dir missing' }],
    };
  }
  const files = relList(dir);
  const rejected: Array<{ path: string; reason: string }> = [];
  const accepted: string[] = [];
  if (spec.max_files !== undefined && files.length > spec.max_files) {
    return {
      ok: false,
      accepted_files: [],
      rejected_files: [
        { path: '.', reason: `file count ${files.length} exceeds max_files ${spec.max_files}` },
      ],
    };
  }
  for (const rel of files) {
    if (!allowed(rel, spec.allowed_paths)) {
      rejected.push({ path: rel, reason: 'off-surface path' });
      continue;
    }
    if (spec.max_file_bytes !== undefined) {
      const size = safeLstat(path.join(dir, rel)).size;
      if (size > spec.max_file_bytes) {
        rejected.push({
          path: rel,
          reason: `file ${size}B exceeds max_file_bytes ${spec.max_file_bytes}`,
        });
        continue;
      }
    }
    accepted.push(rel);
  }
  return { ok: rejected.length === 0, accepted_files: accepted, rejected_files: rejected };
}
