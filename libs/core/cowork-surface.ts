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
import { nowIso } from './foundation/time.js';
import { assertSafeRepositoryPath, safeExistsSync, safeReaddir } from './secure-io.js';
import { writeGovernedArtifactJson, ensureGovernedArtifactDir } from './artifact-store.js';
import type { IntentResolutionContract } from './intent-resolution-contract.js';
import {
  loadCoworkArtifactPacketAtPath,
  validateCoworkArtifactPacket,
  type CoworkArtifactPacket as ValidatedCoworkArtifactPacket,
} from './cowork-artifact-packet.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type CoworkArtifactPacket = ValidatedCoworkArtifactPacket;

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
  intentResolution?: IntentResolutionContract;
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
  options: DeliverToCoworkOptions = {}
): string {
  const deliveryId = `COWORK-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`;

  ensureGovernedArtifactDir(GOVERNED_ROLE, outboxLogicalDir());

  const packet: CoworkArtifactPacket = {
    delivery_id: deliveryId,
    delivered_at: nowIso(),
    mission_id: options.missionId,
    trace_id: options.traceId,
    title: options.title ?? 'Kyberion Result',
    summary: options.summary ?? 'A Kyberion operation completed.',
    next_action: options.nextAction,
    ...(options.intentResolution ? { intent_resolution: options.intentResolution } : {}),
    artifacts,
  };

  const validatedPacket = validateCoworkArtifactPacket(packet, outboxLogicalPath(deliveryId));
  writeGovernedArtifactJson(GOVERNED_ROLE, outboxLogicalPath(deliveryId), validatedPacket);

  return deliveryId;
}

/**
 * List pending (unread) delivery packets in the Cowork outbox.
 */
export function listCoworkOutbox(): CoworkArtifactPacket[] {
  let outboxPath: string;
  try {
    outboxPath = assertSafeRepositoryPath(pathResolver.resolve(outboxLogicalDir()), {
      allowMissingLeaf: true,
    });
  } catch {
    return [];
  }
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
      const filePath = assertSafeRepositoryPath(path.join(outboxPath, file));
      results.push(loadCoworkArtifactPacketAtPath(filePath));
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
  intentResolution?: IntentResolutionContract;
}): CoworkArtifactPacket {
  const deliveryId = `COWORK-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`;
  const summary = params.result.length > 500 ? params.result.slice(0, 500) + '…' : params.result;

  return {
    delivery_id: deliveryId,
    delivered_at: nowIso(),
    mission_id: params.missionId,
    trace_id: params.traceId,
    title: params.title,
    summary,
    next_action: params.nextAction,
    ...(params.intentResolution ? { intent_resolution: params.intentResolution } : {}),
    artifacts: [
      {
        content: params.result,
        content_type: 'text/plain',
        description: 'Full output',
      },
    ],
  };
}
