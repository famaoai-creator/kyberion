/**
 * serve-brief.ts — MO-11 AG-02: the mission-brief approval surface.
 *
 * Serves a mission's alignment brief on 127.0.0.1 with the report-review layer
 * (✏️/💬/🎤) plus a decision bar, and writes the Sovereign's verdict into the
 * SAME approval record every other surface uses.
 *
 *   KYBERION_PERSONA=<p> node_modules/.bin/tsx \
 *     scripts/mission-alignment-gate/serve-brief.ts --mission <ID> [--port 8137]
 *
 * What this is NOT: a second approval channel. The decision goes through
 * applySurfaceApprovalDecision exactly as the concierge, Slack and terminal
 * surfaces do — this file only renders the request and forwards the verdict.
 * If it stopped existing, the alignment gate would still work everywhere else.
 *
 * Authentication is recorded honestly: the surface is `brief`, whose default
 * authMethod is `local_token` (MO-11 S-3). A per-launch token bound to loopback
 * proves possession, not identity, and the audit trail says so rather than
 * claiming `surface_session`.
 */
import http from 'node:http';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

import { safeExistsSync, safeReadFile } from '@agent/core/secure-io';
import {
  applySurfaceApprovalDecision,
  findMissionPath,
  listApprovalRequests,
  normalizeRejectionReasonCategory,
  type ApprovalRequestRecord,
} from '@agent/core';
import { t as catalogT } from '@agent/core/t';

import { renderMissionBriefHtml, type MissionBrief } from './render-brief.js';

const ALIGNMENT_CHANNEL = 'brief';
const MAX_BODY_BYTES = 256 * 1024;

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const missionId = (argValue('--mission') || argValue('-m') || '').trim().toUpperCase();
const port = Number(argValue('--port') || 8137);
if (!missionId) {
  console.error('usage: serve-brief --mission <MISSION_ID> [--port 8137]');
  process.exit(1);
}

const missionDir = findMissionPath(missionId);
if (!missionDir) {
  console.error(`mission directory for ${missionId} not found`);
  process.exit(1);
}
const briefPath = path.join(missionDir, 'evidence', 'mission-brief.json');
if (!safeExistsSync(briefPath)) {
  console.error(`alignment brief not found: ${briefPath}`);
  process.exit(1);
}

const TOKEN = randomBytes(16).toString('hex');

function readBrief(): MissionBrief {
  return JSON.parse(safeReadFile(briefPath, { encoding: 'utf8' }) as string) as MissionBrief;
}

/**
 * The mission's alignment approval. Re-read on every request so the page always
 * reflects the store — including a decision just made on another surface.
 */
function currentApproval(): ApprovalRequestRecord | undefined {
  return listApprovalRequests({ storageChannels: [ALIGNMENT_CHANNEL], kind: 'mission_gate' }).find(
    (record) =>
      record.source?.missionId?.toUpperCase() === missionId &&
      record.correlationId === `mission-alignment-${missionId}`
  );
}

function renderPage(): string {
  const approval = currentApproval();
  return renderMissionBriefHtml(readBrief(), {
    ...(approval
      ? {
          approval: {
            requestId: approval.id,
            status: approval.status,
            ...(approval.decidedBy ? { decidedBy: approval.decidedBy } : {}),
            ...(approval.decidedAt ? { decidedAt: approval.decidedAt } : {}),
            ...(approval.decidedAuthMethod
              ? { decidedAuthMethod: approval.decidedAuthMethod }
              : {}),
            endpoint: '/decision',
            token: TOKEN,
          },
        }
      : {}),
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('request body too large'));
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function handleDecision(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.headers['x-rv-token'] !== TOKEN) return json(res, 403, { ok: false, error: 'bad token' });
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/u.test(origin)) {
    return json(res, 403, { ok: false, error: 'bad origin' });
  }

  const body = JSON.parse((await readBody(req)) || '{}');
  const decision =
    body?.decision === 'approved' || body?.decision === 'rejected' ? body.decision : null;
  const decidedBy = typeof body?.decidedBy === 'string' ? body.decidedBy.trim() : '';
  if (!decision) return json(res, 400, { ok: false, error: 'decision must be approved|rejected' });
  // The audit trail is worthless without a name attached to the verdict.
  if (!decidedBy) return json(res, 400, { ok: false, error: 'decidedBy is required' });

  // Never trust the page's idea of which request it is deciding: resolve the
  // mission's current approval server-side and require the two to agree.
  const approval = currentApproval();
  if (!approval)
    return json(res, 404, { ok: false, error: 'no mission_gate approval for mission' });
  if (body?.requestId && body.requestId !== approval.id) {
    return json(res, 409, {
      ok: false,
      error: 'the page is bound to a stale approval request; reload',
    });
  }
  if (approval.status !== 'pending') {
    return json(res, 409, {
      ok: false,
      error: `already ${approval.status} (decided by ${approval.decidedBy ?? '?'}); reload`,
    });
  }

  const reasonCategory =
    decision === 'rejected' ? normalizeRejectionReasonCategory(body?.reasonCategory) : undefined;
  if (decision === 'rejected' && !reasonCategory) {
    return json(res, 400, { ok: false, error: 'rejected requires a valid reasonCategory' });
  }

  try {
    const updated = applySurfaceApprovalDecision({
      surface: 'brief',
      requestId: approval.id,
      decision,
      channel: approval.channel,
      threadTs: approval.threadTs,
      decidedBy,
      storageChannel: ALIGNMENT_CHANNEL,
      ...(typeof body?.note === 'string' && body.note.trim() ? { note: body.note.trim() } : {}),
      ...(reasonCategory ? { reasonCategory } : {}),
    });
    console.log(
      `[decision] ${updated.status} ${updated.id} by ${decidedBy} (auth=${updated.decidedAuthMethod})`
    );
    return json(res, 200, {
      ok: true,
      status: updated.status,
      requestId: updated.id,
      authMethod: updated.decidedAuthMethod,
    });
  } catch (error) {
    return json(res, 409, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const server = http.createServer((req, res) => {
  void (async () => {
    try {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(renderPage());
        return;
      }
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200);
        res.end('ok');
        return;
      }
      if (req.method === 'GET' && req.url === '/approval') {
        const approval = currentApproval();
        return json(res, 200, {
          ok: true,
          approval: approval
            ? { id: approval.id, status: approval.status, decidedBy: approval.decidedBy }
            : null,
        });
      }
      if (req.method === 'POST' && req.url === '/decision') {
        await handleDecision(req, res);
        return;
      }
      res.writeHead(404);
      res.end('not found');
    } catch (error) {
      json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  })();
});

server.listen(port, '127.0.0.1', () => {
  const approval = currentApproval();
  console.log(`Mission brief approval surface → http://127.0.0.1:${port}/`);
  console.log(`  mission  : ${missionId}`);
  console.log(`  brief    : ${briefPath}`);
  console.log(
    `  approval : ${approval ? `${approval.id} (${approval.status})` : catalogT('mission_alignment:server_approval_missing')}`
  );
  console.log(`  token    : ${TOKEN.slice(0, 6)}…  (127.0.0.1 only, authMethod=local_token)`);
  console.log(`  ${catalogT('mission_alignment:server_decision_notice')}`);
});
