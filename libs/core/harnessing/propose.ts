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
import { lookupLessons, seedPromptFromLessons } from './experience-library.js';

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
  index: number,
  seedBlock = ''
) => `${STRUCTURED_DELEGATION_PROMPT_HEADER}

Schema: [{"path": "<relative file path>", "content": "<file text>"}] — a JSON array only.

You are proposing ONE candidate overlay for a contrastive harness-tuning probe.

Brief: ${brief}
${seedBlock ? `\n${seedBlock}\n` : ''}
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
  /** Optional experience library: the domain's prior lessons seed the
   *  propose prompt (looked up once, before the loop). */
  library?: { root: string; domain: string; asOf?: string };
}): Promise<ProposeResult> {
  const result: ProposeResult = { backend_used: false, candidates: [], rejected: [], error: '' };
  const outDir = assertSafeRepositoryPath(opts.outDir, { allowMissingLeaf: true });
  if (!Number.isInteger(opts.count) || opts.count < 1 || opts.count > 10) {
    throw new Error('[PROPOSE] count must be an integer 1..10');
  }
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
    // Do not run the loop at all: stub output would either fail JSON parsing
    // (wasted calls) or, if it ever parsed, produce overlays with no real
    // reasoning behind them. Degrading empty is the honest outcome.
    result.error = `degraded: only the stub backend is active (name=${backend.name}); propose skipped`;
    return result;
  }

  // Experience-library seeding (harness2 retain): a proposer sees the
  // domain's prior lessons so candidates build on recorded evidence. The
  // lookup runs once — every candidate shares the same evidence window —
  // and only when a real backend is active (the stub early-return is
  // above). A lookup failure degrades to an unseeded prompt, not a crash.
  let seedBlock = '';
  if (opts.library) {
    try {
      seedBlock = seedPromptFromLessons(
        lookupLessons({
          libraryRoot: opts.library.root,
          domain: opts.library.domain,
          ...(opts.library.asOf ? { asOf: opts.library.asOf } : {}),
          cue: opts.brief,
        })
      );
    } catch (error) {
      logger.warn(
        `[propose] experience-library lookup failed; continuing unseeded: ${
          error instanceof Error ? error.message : error
        }`
      );
    }
  }

  for (let i = 0; i < opts.count; i++) {
    const label = `${prefix}${i + 1}`;
    const overlayDir = path.join(outDir, label);
    let files: ProposedFile[];
    try {
      const raw = await backend.delegateTask(
        PROPOSE_INSTRUCTION(opts.brief, opts.surface, i, seedBlock)
      );
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
  // Any delegateTask served by the stub mid-loop (failover) taints the batch —
  // purge the affected candidates so stub-authored overlays can't reach a probe.
  // Any stub-served op in the window taints the batch — a backend can route
  // internally through 'prompt' etc., so don't filter on op. A saturated
  // registry (records dropped at cap) is treated conservatively as tainted.
  const registry = getStubServedOps();
  const stubServed = registry.length >= 500 || registry.slice(stubServedBefore).length > 0;
  if (stubServed) {
    result.backend_used = false;
    result.error = result.error || 'degraded: stub backend served one or more proposals';
    for (const c of result.candidates.splice(0)) {
      result.rejected.push({
        label: c.label,
        path: '.',
        reason: 'candidate discarded: stub-served backend',
      });
    }
  }
  return result;
}
