/**
 * Host hand-off bookkeeping for image generation (host bridges: host_agent,
 * codex/agy/cursor host bridges).
 *
 * A host bridge cannot generate: it asks the host agent to save an image at a
 * target path and expects a rerun. On the rerun, an existing target is only
 * the host's output if this machine asked for it — with the same prompt —
 * before the file was written. Anything else (a file that was already there,
 * one written for a different prompt, a second collection of the same file)
 * is not attributed to the host; the bridge requests a fresh image instead.
 *
 * One request marker per target (not one per bridge), so several frames can
 * be pending at once (e.g. an avatar set). Markers live on the shared-tmp
 * consumables floor; a hand-off older than its TTL is simply requested again.
 */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { readJsonIfPresent, writeJson } from './foundation/json.js';
import * as pathResolver from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeStat, safeUnlinkSync } from './secure-io.js';

interface HostImageHandoffRequest {
  provider_id: string;
  target: string;
  prompt: string;
  requested_at_ms: number;
}

function requestMarkerPath(targetPath: string): string {
  const key = createHash('sha256').update(path.resolve(targetPath)).digest('hex').slice(0, 16);
  return pathResolver.sharedTmp(`host-image-handoff/${key}.json`);
}

/** Remember that the host was asked to produce `targetPath` for `prompt`. */
export function recordHostImageHandoffRequest(input: {
  providerId: string;
  targetPath: string;
  prompt: string;
  nowMs?: number;
}): void {
  const markerPath = requestMarkerPath(input.targetPath);
  safeMkdir(path.dirname(markerPath), { recursive: true });
  const request: HostImageHandoffRequest = {
    provider_id: input.providerId,
    target: path.resolve(input.targetPath),
    prompt: input.prompt,
    requested_at_ms: input.nowMs ?? Date.now(),
  };
  writeJson(markerPath, request);
}

/**
 * Whether `targetPath` holds the host's answer to a pending request with the
 * same prompt (written after the request). A match consumes the request, so
 * the same file is never collected twice.
 */
export function claimHostImageHandoffOutput(targetPath: string, prompt: string): boolean {
  if (!safeExistsSync(targetPath)) return false;
  const markerPath = requestMarkerPath(targetPath);
  const request = readJsonIfPresent<HostImageHandoffRequest>(markerPath);
  if (
    !request ||
    request.target !== path.resolve(targetPath) ||
    request.prompt !== prompt ||
    safeStat(targetPath).mtimeMs <= request.requested_at_ms
  ) {
    return false;
  }
  safeUnlinkSync(markerPath);
  return true;
}
