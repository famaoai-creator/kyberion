import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from '@agent/core/secure-io';

import {
  dedupeDeliverables,
  deliverableVisibleToTierAccess,
  inferDeliverableTier,
  resolveSafeExistingFile,
  type DeliverableInboxItem,
} from './deliverable-inbox';

function item(
  artifactId: string,
  path: string | undefined,
  updatedAt: string,
  extra: Partial<DeliverableInboxItem> = {}
): DeliverableInboxItem {
  return {
    artifactId,
    kind: 'doc',
    storageClass: 'artifact_store',
    path,
    updatedAt,
    ...extra,
  } as DeliverableInboxItem;
}

describe('deliverable inbox dedupe', () => {
  it('keeps the newest record per target and counts the ones it stood in for', () => {
    // The shape that made the inbox unreadable: one fixture path re-registered
    // under a fresh artifact id on every pipeline run.
    const deduped = dedupeDeliverables([
      item(
        'ART-3',
        'active/missions/public/MSN-A/evidence/good-doc.md',
        '2026-07-26T12:00:00.000Z'
      ),
      item(
        'ART-2',
        'active/missions/public/MSN-A/evidence/good-doc.md',
        '2026-07-26T11:00:00.000Z'
      ),
      item(
        'ART-1',
        'active/missions/public/MSN-A/evidence/good-doc.md',
        '2026-07-26T10:00:00.000Z'
      ),
    ]);

    expect(deduped).toHaveLength(1);
    expect(deduped[0].artifactId).toBe('ART-3');
    expect(deduped[0].supersededCount).toBe(2);
  });

  it('keeps distinct targets and leaves single records uncounted', () => {
    const deduped = dedupeDeliverables([
      item('ART-A', 'active/shared/tmp/deck.pptx', '2026-07-26T12:00:00.000Z'),
      item('ART-B', 'active/shared/tmp/notes.md', '2026-07-26T11:00:00.000Z'),
    ]);

    expect(deduped.map((entry) => entry.artifactId)).toEqual(['ART-A', 'ART-B']);
    expect(deduped.every((entry) => entry.supersededCount === undefined)).toBe(true);
  });

  it('never merges records that have no target to compare', () => {
    // No path and no external ref: the artifact id is the only identity, so two
    // such records are two deliverables, not one.
    const deduped = dedupeDeliverables([
      item('ART-X', undefined, '2026-07-26T12:00:00.000Z'),
      item('ART-Y', undefined, '2026-07-26T11:00:00.000Z'),
    ]);

    expect(deduped).toHaveLength(2);
  });

  it('groups by external ref when there is no local path', () => {
    const deduped = dedupeDeliverables([
      item('ART-N', undefined, '2026-07-26T12:00:00.000Z', {
        externalRef: 'https://drive.example/doc/1',
      }),
      item('ART-O', undefined, '2026-07-26T11:00:00.000Z', {
        externalRef: 'https://drive.example/doc/1',
      }),
    ]);

    expect(deduped).toHaveLength(1);
    expect(deduped[0].artifactId).toBe('ART-N');
    expect(deduped[0].supersededCount).toBe(1);
  });
});

describe('deliverable inbox tier projection', () => {
  it('resolves the governing tier from mission state before compatibility fallbacks', () => {
    expect(
      inferDeliverableTier(
        {
          artifact_id: 'ART-TIER',
          kind: 'doc',
          storage_class: 'artifact_store',
          metadata: { tier: 'public' },
        },
        'active/missions/personal/MSN/evidence/note.md',
        'confidential'
      )
    ).toBe('confidential');
    expect(
      inferDeliverableTier(
        {
          artifact_id: 'ART-TIER',
          kind: 'doc',
          storage_class: 'artifact_store',
          metadata: { sensitivity_tier: 'personal' },
        },
        'active/missions/public/MSN/evidence/note.md'
      )
    ).toBe('personal');
  });

  it('fails closed for unknown tiers and rejects personal from a masked viewer', () => {
    expect(
      deliverableVisibleToTierAccess(item('ART-UNKNOWN', undefined, '2026-07-26T12:00:00.000Z'), [
        'public',
        'confidential',
      ])
    ).toBe(false);
    expect(
      deliverableVisibleToTierAccess(
        item('ART-PERSONAL', undefined, '2026-07-26T12:00:00.000Z', { tier: 'personal' }),
        ['public', 'confidential']
      )
    ).toBe(false);
    expect(
      deliverableVisibleToTierAccess(
        item('ART-PUBLIC', undefined, '2026-07-26T12:00:00.000Z', { tier: 'public' }),
        ['public', 'confidential']
      )
    ).toBe(true);
  });
});

describe('deliverable inbox resource boundary', () => {
  it('does not follow symlinked artifact or mission files', () => {
    const dir = pathResolver.sharedTmp(`deliverable-inbox-boundary-${process.pid}`);
    const target = path.join(dir, 'target.json');
    const link = path.join(dir, 'linked.json');
    safeMkdir(dir, { recursive: true });
    safeWriteFile(target, '{}');
    safeSymlinkSync(target, link);

    expect(resolveSafeExistingFile(target)).toBe(target);
    expect(resolveSafeExistingFile(link)).toBeNull();
    safeRmSync(dir, { recursive: true, force: true });
  });
});
