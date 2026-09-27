/**
 * Host hand-off bookkeeping for image generation (host bridges: host_agent,
 * codex/agy/cursor host bridges).
 *
 * A host bridge cannot generate: it asks the host agent to save an image at a
 * target path and expects a rerun. On the rerun, an existing target is only
 * the host's output if this machine asked for it — with the same prompt — and
 * the file changed after the request was made. A file that was already there
 * (unchanged) or one written for a different prompt is not attributed to the
 * host; the bridge requests a fresh image instead.
 *
 * The request records the target's content hash at request time (or that it
 * was absent), so collection compares content rather than clocks or
 * timestamps (no mtime-granularity race, timestamp-preserving copies work).
 * "Changed since the request" is a proxy for host authorship: the bridge's
 * `host_output_collected` receipt records collection, not verified authorship. Collection is idempotent: a rerun after a partial
 * multi-frame hand-off still sees earlier frames as collected. Re-requesting
 * the same target and prompt keeps the original request, so a file the host
 * wrote in between is never orphaned. One marker per target, so several
 * frames (e.g. an avatar set) can be pending at once. Markers live on the
 * shared-tmp consumables floor; an expired one just means a fresh request.
 *
 * The prompt must be deterministic across the first run and the rerun.
 */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { logger } from './core.js';
import { readJsonIfPresent, writeJson } from './foundation/json.js';
import * as pathResolver from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile } from './secure-io.js';

interface HostImageHandoffRequest {
  provider_id: string;
  target: string;
  prompt: string;
  /** sha256 of the target before the host was asked: null when it did not exist. */
  prior_sha256: string | null;
  requested_at: string;
}

function resolveTarget(targetPath: string): string {
  return pathResolver.resolve(targetPath);
}

function contentHash(target: string): string | null {
  if (!safeExistsSync(target)) return null;
  try {
    const bytes = safeReadFile(target, { encoding: null }) as Buffer;
    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    return null; // vanished between the check and the read: same as absent
  }
}

function requestMarkerPath(target: string): string {
  const key = createHash('sha256').update(target).digest('hex').slice(0, 16);
  return pathResolver.sharedTmp(`host-image-handoff/${key}.json`);
}

function readRequest(target: string): HostImageHandoffRequest | null {
  const request = readJsonIfPresent<HostImageHandoffRequest>(requestMarkerPath(target));
  return request && request.target === target ? request : null;
}

/** Remember that the host was asked to produce `targetPath` for `prompt`. */
export function recordHostImageHandoffRequest(input: {
  providerId: string;
  targetPath: string;
  prompt: string;
}): void {
  const target = resolveTarget(input.targetPath);
  const existing = readRequest(target);
  // Same request again: keep the original baseline so a file the host wrote
  // since then still counts as its answer.
  if (existing?.prompt === input.prompt) return;
  if (existing) {
    logger.warn(
      `[host-image-handoff] ${path.basename(target)} was requested with a different prompt; the earlier hand-off is replaced (prompts must be deterministic across reruns).`
    );
  }
  const markerPath = requestMarkerPath(target);
  safeMkdir(path.dirname(markerPath), { recursive: true });
  const request: HostImageHandoffRequest = {
    provider_id: input.providerId,
    target,
    prompt: input.prompt,
    prior_sha256: contentHash(target),
    requested_at: new Date().toISOString(),
  };
  writeJson(markerPath, request);
}

/**
 * Whether `targetPath` holds the host's answer to a request with the same
 * prompt: the file exists and is not the file that was there when the host
 * was asked.
 */
export function isHostImageHandoffOutput(targetPath: string, prompt: string): boolean {
  const target = resolveTarget(targetPath);
  const request = readRequest(target);
  if (!request || request.prompt !== prompt) return false;
  const current = contentHash(target);
  return current !== null && current !== request.prior_sha256;
}
