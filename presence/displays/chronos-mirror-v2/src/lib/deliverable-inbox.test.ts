import { describe, expect, it } from 'vitest';

import { dedupeDeliverables, type DeliverableInboxItem } from './deliverable-inbox';

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
