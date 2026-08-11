/**
 * mission_alignment_request.ts — MO-11 AG-02
 *
 * Opens the Sovereign alignment approval for a mission: reads the mission's
 * brief, binds a hash of it to a `mission_gate` approval request, and puts that
 * request into the surface-agnostic approval store.
 *
 * From that moment the request is visible — and decidable — on every surface at
 * once: the concierge queue, chronos, presence-studio, Slack, the terminal
 * tools, and the mission-brief HTML page. Whichever surface the Sovereign uses,
 * the same record is updated through decideApprovalRequest, and
 * `mission_alignment_decision --strict` reads that one record.
 *
 * The payload binding is the point: `accountability.payloadHash` pins the
 * approval to the exact brief that was approved, so editing the brief
 * afterwards invalidates the gate instead of silently inheriting the verdict.
 *
 *   node dist/scripts/mission_alignment_request.js --mission <ID> [--json]
 */

import * as path from 'node:path';

import { createStandardYargs } from '@agent/core/cli-utils';
import { safeExistsSync, safeReadFile } from '@agent/core/secure-io';
import { t as catalogT, type VocabularyKey } from '@agent/core/t';
import {
  computeApprovalPayloadHash,
  createApprovalRequest,
  findMissionPath,
  listApprovalRequests,
  type ApprovalRequestRecord,
} from '@agent/core';

import { ALIGNMENT_BRIEF_RELATIVE_PATH } from './mission_alignment_decision.js';

/** The alignment approval always lands in the brief channel, whichever surface decides it. */
export const ALIGNMENT_APPROVAL_CHANNEL = 'brief';

function mt(key: VocabularyKey, params?: Record<string, string | number>): string {
  return catalogT(key, params);
}

export interface OpenAlignmentApprovalResult {
  missionId: string;
  created: boolean;
  requestId?: string;
  payloadHash?: string;
  briefPath: string;
  reason?: string;
}

interface MissionBriefShape {
  title?: string;
  intent?: string;
  victoryConditions?: string[];
}

/**
 * Opens (or reuses) the mission's pending alignment approval.
 *
 * Reuse is deliberate: re-running must not scatter duplicate pending requests
 * across the surfaces. A pending request whose hash no longer matches the brief
 * is NOT reused — the brief changed before anyone decided, so the stale request
 * would bind the wrong content.
 */
export function openAlignmentApproval(
  missionIdInput: string,
  options: { requestedBy?: string } = {}
): OpenAlignmentApprovalResult {
  const missionId = missionIdInput.trim().toUpperCase();
  const missionDir = findMissionPath(missionId);
  if (!missionDir) {
    return {
      missionId,
      created: false,
      briefPath: '',
      reason: `Mission directory for ${missionId} not found.`,
    };
  }

  const briefPath = path.join(missionDir, ALIGNMENT_BRIEF_RELATIVE_PATH);
  if (!safeExistsSync(briefPath)) {
    return {
      missionId,
      created: false,
      briefPath,
      reason: `Alignment brief not found at ${briefPath}. Author it before requesting approval.`,
    };
  }

  let brief: MissionBriefShape & Record<string, unknown>;
  try {
    brief = JSON.parse(safeReadFile(briefPath, { encoding: 'utf8' }) as string);
  } catch (error) {
    return {
      missionId,
      created: false,
      briefPath,
      reason: `Alignment brief is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!brief || typeof brief !== 'object' || Array.isArray(brief)) {
    return {
      missionId,
      created: false,
      briefPath,
      reason: 'Alignment brief must be a JSON object.',
    };
  }

  const payloadHash = computeApprovalPayloadHash(brief);

  const existing = findPendingAlignmentApproval(missionId);
  if (existing) {
    if (existing.accountability?.payloadHash === payloadHash) {
      return { missionId, created: false, requestId: existing.id, payloadHash, briefPath };
    }
    return {
      missionId,
      created: false,
      requestId: existing.id,
      briefPath,
      reason:
        `A pending alignment approval (${existing.id}) is bound to a different version of the brief. ` +
        `Cancel it before requesting approval for the updated brief.`,
    };
  }

  const record = createApprovalRequest('surface_runtime', {
    channel: ALIGNMENT_APPROVAL_CHANNEL,
    storageChannel: ALIGNMENT_APPROVAL_CHANNEL,
    threadTs: missionId,
    correlationId: `mission-alignment-${missionId}`,
    requestedBy: options.requestedBy || 'planner',
    kind: 'mission_gate',
    draft: {
      title: mt('mission_alignment:approval_title', { title: brief.title || missionId }),
      summary: brief.intent || mt('mission_alignment:approval_summary', { missionId }),
      details: formatVictoryConditions(brief.victoryConditions),
      severity: 'high',
    },
    source: { missionId },
    requestedByContext: {
      surface: 'brief',
      actorId: options.requestedBy || 'planner',
      actorRole: 'planner',
      missionId,
    },
    // Binds the approval to this exact brief. mission_alignment_decision
    // re-computes the hash at gate time and fails closed on any drift.
    accountability: { finalDecision: 'human_only', payloadHash },
  });

  return { missionId, created: true, requestId: record.id, payloadHash, briefPath };
}

function findPendingAlignmentApproval(missionId: string): ApprovalRequestRecord | undefined {
  return listApprovalRequests({
    storageChannels: [ALIGNMENT_APPROVAL_CHANNEL],
    kind: 'mission_gate',
    status: 'pending',
  }).find(
    (record) =>
      record.source?.missionId?.toUpperCase() === missionId &&
      record.correlationId === `mission-alignment-${missionId}`
  );
}

function formatVictoryConditions(conditions: string[] | undefined): string | undefined {
  if (!conditions?.length) return undefined;
  return ['Victory Conditions:', ...conditions.map((entry) => `- ${entry}`)].join('\n');
}

export async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option('mission', { alias: 'm', type: 'string', demandOption: true })
    .option('requested-by', { type: 'string' })
    .option('json', { type: 'boolean', default: false })
    .parseSync();

  const result = openAlignmentApproval(String(argv.mission), {
    ...(argv['requested-by'] ? { requestedBy: String(argv['requested-by']) } : {}),
  });

  if (argv.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.requestId && !result.reason) {
    process.stdout.write(
      `[alignment-request] ${result.created ? 'opened' : 'reusing'} ${result.requestId} for ${result.missionId}\n` +
        `  brief : ${result.briefPath}\n` +
        `  bound : ${result.payloadHash?.slice(0, 16)}…\n` +
        `  ${mt('mission_alignment:approval_surfaces_notice')}\n`
    );
  } else {
    process.stdout.write(`[alignment-request] ${result.reason}\n`);
  }

  process.exitCode = result.reason ? 1 : 0;
}

if (process.argv[1] && /mission_alignment_request\.(ts|js)$/u.test(process.argv[1])) void main();
