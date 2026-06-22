/**
 * Cowork Surface Provider (Phase 1 — G2/軸C)
 *
 * Delivers Kyberion mission/pipeline artifacts to the Claude Cowork workspace
 * via the coordination outbox channel:
 *   active/shared/coordination/channels/cowork/outbox/{id}.json
 *
 * Architecture rules (AGENTS.md):
 *   - All file I/O via secure-io (writeGovernedArtifactJson/ensureGovernedArtifactDir)
 *   - Artifacts carry mission_id + trace_id for audit trail linkage
 *   - Operator Interaction Packet (OIP) format — no raw ADF exposed to end users
 */

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReaddir, safeReadFile } from './secure-io.js';
import { writeGovernedArtifactJson, ensureGovernedArtifactDir } from './artifact-store.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CoworkArtifactPacket {
  /** Unique delivery ID for deduplication. */
  delivery_id: string;
  /** ISO timestamp. */
  delivered_at: string;
  /** Mission that produced this artifact (if applicable). */
  mission_id?: string;
  /** Pipeline trace ID (if applicable). */
  trace_id?: string;
  /** Human-readable title shown in Cowork. */
  title: string;
  /** Short summary of what was produced (Operator Interaction Packet). */
  summary: string;
  /** Next suggested action for the operator. */
  next_action?: string;
  /** Artifact payload: relative path(s) or inline content. */
  artifacts: CoworkArtifact[];
}

export interface CoworkArtifact {
  /** Relative path from the repo root, or 'inline' if content is embedded. */
  path?: string;
  /** Inline content (for small payloads). Mutually exclusive with path. */
  content?: string;
  /** MIME type hint. */
  content_type: string;
  /** Human-readable description. */
  description?: string;
}

export interface DeliverToCoworkOptions {
  missionId?: string;
  traceId?: string;
  title?: string;
  summary?: string;
  nextAction?: string;
}

// ─── Outbox helpers ───────────────────────────────────────────────────────────

const COWORK_OUTBOX_CHANNEL = 'cowork';
const GOVERNED_ROLE = 'surface_runtime' as const;

function outboxLogicalDir(): string {
  return `active/shared/coordination/channels/${COWORK_OUTBOX_CHANNEL}/outbox`;
}

function outboxLogicalPath(deliveryId: string): string {
  return `${outboxLogicalDir()}/${deliveryId}.json`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Deliver an artifact packet to the Cowork outbox.
 * Cowork (via the MCP `kyberion.surface.cowork.deliver` tool) polls or reads
 * this outbox to surface results to the operator.
 *
 * Returns the delivery_id for tracking.
 */
export function deliverToCowork(
  artifacts: CoworkArtifact[],
  options: DeliverToCoworkOptions = {},
): string {
  const deliveryId = `COWORK-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`;

  ensureGovernedArtifactDir(GOVERNED_ROLE, outboxLogicalDir());

  const packet: CoworkArtifactPacket = {
    delivery_id: deliveryId,
    delivered_at: new Date().toISOString(),
    mission_id: options.missionId,
    trace_id: options.traceId,
    title: options.title ?? 'Kyberion Result',
    summary: options.summary ?? 'A Kyberion operation completed.',
    next_action: options.nextAction,
    artifacts,
  };

  writeGovernedArtifactJson(GOVERNED_ROLE, outboxLogicalPath(deliveryId), packet);

  return deliveryId;
}

/**
 * List pending (unread) delivery packets in the Cowork outbox.
 */
export function listCoworkOutbox(): CoworkArtifactPacket[] {
  const outboxPath = pathResolver.resolve(outboxLogicalDir());
  if (!safeExistsSync(outboxPath)) return [];

  let files: string[];
  try {
    files = safeReaddir(outboxPath);
  } catch {
    return [];
  }

  const results: CoworkArtifactPacket[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = safeReadFile(path.join(outboxPath, file), { encoding: 'utf8' }) as string;
      results.push(JSON.parse(raw) as CoworkArtifactPacket);
    } catch {
      // Skip corrupt entries
    }
  }

  return results.sort((a, b) => a.delivered_at.localeCompare(b.delivered_at));
}

/**
 * Build an Operator Interaction Packet (OIP) from a pipeline result string.
 * Extracts the first 500 chars as summary; wraps in standard OIP envelope.
 */
export function buildOperatorInteractionPacket(params: {
  title: string;
  result: string;
  missionId?: string;
  traceId?: string;
  nextAction?: string;
}): CoworkArtifactPacket {
  const deliveryId = `COWORK-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`;
  const summary = params.result.length > 500
    ? params.result.slice(0, 500) + '…'
    : params.result;

  return {
    delivery_id: deliveryId,
    delivered_at: new Date().toISOString(),
    mission_id: params.missionId,
    trace_id: params.traceId,
    title: params.title,
    summary,
    next_action: params.nextAction,
    artifacts: [
      {
        content: params.result,
        content_type: 'text/plain',
        description: 'Full output',
      },
    ],
  };
}
