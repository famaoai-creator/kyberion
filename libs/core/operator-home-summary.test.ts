import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const secureIo = vi.hoisted(() => ({
  safeAppendFileSync: (filePath: string, data: string) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, data, 'utf8');
  },
  safeCreateExclusiveFileSync: (filePath: string, data: string | Buffer = '') => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, data);
  },
  safeExistsSync: (filePath: string) => fs.existsSync(filePath),
  safeMkdir: (dirPath: string) => fs.mkdirSync(dirPath, { recursive: true }),
  safeReadFile: (filePath: string, options: { encoding?: BufferEncoding | null } = {}) =>
    options.encoding === null ? fs.readFileSync(filePath) : fs.readFileSync(filePath, 'utf8'),
  safeUnlinkSync: (filePath: string) => {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  },
  safeWriteFile: (filePath: string, data: string | Buffer) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, data);
  },
  safeReaddir: (dirPath: string) => fs.readdirSync(dirPath),
}));

vi.mock('./secure-io.js', () => secureIo);

describe('operator home summary', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = path.join(os.tmpdir(), `kyberion-home-${randomUUID()}`);
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}');
    process.env.KYBERION_ROOT = tmpRoot;
  });

  afterEach(async () => {
    delete process.env.KYBERION_ROOT;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    vi.resetModules();
  });

  it('summarizes approval, inbox, mission, and next-action state', async () => {
    const { addInboxEntry } = await import('./deliverable-inbox.js');
    const { collectOperatorHomeSummary } = await import('./operator-home-summary.js');

    fs.mkdirSync(path.join(tmpRoot, 'active/missions/public/MSN-1'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, 'active/missions/public/MSN-1/mission-state.json'),
      JSON.stringify(
        {
          mission_id: 'MSN-1',
          status: 'active',
          tier: 'public',
          mission_type: 'delivery',
          tenant_slug: 'tenant-a',
          assigned_persona: 'operator',
          history: [{ ts: '2026-07-06T00:00:00.000Z', event: 'START', note: 'started' }],
          intent: {
            goal_summary: 'Ship the report',
            success_condition: 'Report is shipped',
          },
        },
        null,
        2
      )
    );
    addInboxEntry({
      missionId: 'MSN-1',
      title: 'Deliverable ready',
      artifactPaths: ['active/missions/public/MSN-1/evidence/report.md'],
      summary: 'Report delivered',
    });

    const summary = collectOperatorHomeSummary({ limit: 5 });

    expect(summary.status).toBe('attention');
    expect(summary.counts.activeMissions).toBe(1);
    expect(summary.counts.unreadInbox).toBe(1);
    expect(summary.nextAction.title.length).toBeGreaterThan(0);
    expect(summary.inboxEntries).toHaveLength(1);
  });

  it('surfaces a pending software quality decision for the accountable human', async () => {
    const qualityDir = path.join(tmpRoot, 'active/shared/runtime/qa');
    fs.mkdirSync(qualityDir, { recursive: true });
    fs.writeFileSync(
      path.join(qualityDir, 'latest-quality-report.json'),
      JSON.stringify({
        report_id: 'QUALITY-RUN-1',
        project_id: 'project-1',
        subject_ref: 'git:abc',
        recommendation: 'no_go',
        human_decision: 'pending',
        accountable_human_id: 'human:owner',
        generated_at: '2026-07-12T00:00:00.000Z',
        residual_risks: ['Critical defect remains.'],
        evidence_refs: ['trace:1'],
      })
    );
    const { collectOperatorHomeSummary } = await import('./operator-home-summary.js');
    const summary = collectOperatorHomeSummary();
    expect(summary.status).toBe('attention');
    expect(summary.counts.pendingQualityDecisions).toBe(1);
    expect(summary.qualitySummary).toMatchObject({
      recommendation: 'no_go',
      accountableHumanId: 'human:owner',
    });
    expect(summary.nextAction.title).toContain('quality');
  });
});
