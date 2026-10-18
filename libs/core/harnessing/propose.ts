/**
 * LLM propose stage (harness2 import): ask the reasoning backend for N
 * candidate overlays as pure JSON [{path, content}], surface-validate every
 * proposed file, and write the surviving overlays to candidate dirs.
 * No backend or unparseable output => explicit degrade result, not a crash.
 */

import * as path from 'node:path';
import { getReasoningBackend } from '../reasoning/reasoning-backend.js';
import { STRUCTURED_DELEGATION_PROMPT_HEADER } from '../reasoning/reasoning-delegation-policy.js';
import { getStubServedOps } from '../reasoning/stub-served-registry.js';
import { logger } from '../core.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeRmSync,
  safeWriteFile,
} from '../secure-io.js';
import { isValidRelPath, validateOverlay, type SurfaceSpec } from './surface-spec.js';

export interface ProposedFile {
  path: string;
  content: string;
}

export interface ProposeResult {
  backend_used: boolean;
  candidates: Array<{ label: string; overlayDir: string; files: string[] }>;
  rejected: Array<{ label: string; path: string; reason: string }>;
  error: string;
}

const PROPOSE_INSTRUCTION = (
  brief: string,
  spec: SurfaceSpec,
  index: number
) => `${STRUCTURED_DELEGATION_PROMPT_HEADER}

Schema: [{"path": "<relative file path>", "content": "<file text>"}] — a JSON array only.

You are proposing ONE candidate overlay for a contrastive harness-tuning probe.

Brief: ${brief}

Editable surface — you may ONLY propose files under these paths:
${spec.allowed_paths.map((p) => `- ${p}`).join('\n')}

Respond with ONLY a JSON array of files: [{"path": "<rel>", "content": "<text>"}].
Rules: paths are relative, no '..', no absolute paths, only inside the editable surface above. Omitted paths inherit the base — only include files you are changing. Vary the approach for candidate index ${index + 1} — do not restate the base.`;

function extractJsonArray(text: string): ProposedFile[] {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('no JSON array in propose output');
  const parsed = JSON.parse(m[0]) as unknown;
  if (!Array.isArray(parsed)) throw new Error('propose output is not an array');
  return parsed.map((item) => {
    const obj = item as { path?: unknown; content?: unknown };
    if (typeof obj.path !== 'string' || typeof obj.content !== 'string') {
      throw new Error('proposed file missing path/content strings');
    }
    return { path: obj.path, content: obj.content };
  });
}

export async function proposeCandidates(opts: {
  brief: string;
  surface: SurfaceSpec;
  count: number;
  /** Directory where candidate overlay dirs land (repo-scoped). */
  outDir: string;
  labelPrefix?: string;
}): Promise<ProposeResult> {
  const result: ProposeResult = { backend_used: false, candidates: [], rejected: [], error: '' };
  const outDir = assertSafeRepositoryPath(opts.outDir, { allowMissingLeaf: true });
  const prefix = opts.labelPrefix ?? 'llm';
  // The prefix becomes part of probe labels — it must satisfy the same charset
  // or it could escape the _proposed dir (e.g. '../x').
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(prefix)) {
    throw new Error(`[PROPOSE] invalid labelPrefix ${JSON.stringify(prefix)}`);
  }
  const stubServedBefore = getStubServedOps().length;

  let backend;
  try {
    backend = getReasoningBackend();
  } catch (error) {
    result.error = `no reasoning backend: ${error instanceof Error ? error.message : error}`;
    return result;
  }
  // getReasoningBackend never throws — it falls back to the stub. Per the
  // stub-taint policy a stub run is not a real proposal; honest accounting
  // reads the stub-served registry, not the registered backend's name (a
  // failover composite can still serve a stub candidate).
  result.backend_used = backend.name !== 'stub';
  if (!result.backend_used) {
    result.error = `degraded: only the stub backend is active (name=${backend.name}); proposals will be rejected`;
  }

  for (let i = 0; i < opts.count; i++) {
    const label = `${prefix}${i + 1}`;
    const overlayDir = path.join(outDir, label);
    let files: ProposedFile[];
    try {
      const raw = await backend.delegateTask(PROPOSE_INSTRUCTION(opts.brief, opts.surface, i));
      files = extractJsonArray(raw);
    } catch (error) {
      result.rejected.push({
        label,
        path: '.',
        reason: `propose call failed: ${error instanceof Error ? error.message : error}`,
      });
      continue;
    }
    // Sanitize + surface-validate before any write.
    const clean = files.filter((f) => {
      if (!isValidRelPath(f.path)) {
        result.rejected.push({ label, path: f.path, reason: 'unsafe path' });
        return false;
      }
      return true;
    });
    if (!clean.length) {
      result.rejected.push({ label, path: '.', reason: 'no usable files proposed' });
      continue;
    }
    try {
      // Recreate the overlay dir: leftovers from a previous run would silently
      // merge into this candidate and corrupt the probed evidence.
      if (safeExistsSync(overlayDir)) safeRmSync(overlayDir);
      safeMkdir(overlayDir, { recursive: true });
      for (const f of clean) {
        const target = assertSafeRepositoryPath(path.join(overlayDir, f.path), {
          allowMissingLeaf: true,
        });
        safeMkdir(path.dirname(target), { recursive: true });
        safeWriteFile(target, f.content);
      }
    } catch (error) {
      result.rejected.push({
        label,
        path: '.',
        reason: `overlay write failed: ${error instanceof Error ? error.message : error}`,
      });
      continue;
    }
    const validation = validateOverlay(overlayDir, opts.surface);
    if (!validation.ok) {
      result.rejected.push(
        ...validation.rejected_files.map((r) => ({ label, path: r.path, reason: r.reason }))
      );
      continue;
    }
    logger.info(`[propose:${label}] accepted ${validation.accepted_files.length} file(s)`);
    result.candidates.push({ label, overlayDir, files: validation.accepted_files });
  }
  // Any delegateTask served by the stub during this call taints the batch.
  const stubServed = getStubServedOps()
    .slice(stubServedBefore)
    .some((r) => r.op === 'delegateTask');
  if (stubServed) {
    result.backend_used = false;
    result.error = result.error || 'degraded: stub backend served one or more proposals';
  }
  return result;
}
