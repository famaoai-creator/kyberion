import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeWriteFile } from '@agent/core/secure-io';
import { migrateLegacyPads } from './migrate.js';
import { PadRecordStore } from './storage.js';

describe('legacy pad migration', () => {
  it('holds records when the old handoff has no scope', () => {
    const root = pathResolver.sharedTmp(`personal-pads-migrate-${Date.now()}/memory-capture`);
    const session = `${root}/sessions/old-1`;
    safeMkdir(session, { recursive: true });
    safeWriteFile(`${session}/handoff.json`, JSON.stringify({ viewer_principal: 'human:alice' }), {
      mkdir: true,
      encoding: 'utf8',
    });
    const report = migrateLegacyPads({ roots: [root] });
    expect(report.scanned).toBe(1);
    expect(report.held).toBe(1);
    expect(report.items[0]?.reason).toContain('scope');
  });

  it('does not duplicate a root handoff and its session handoff', () => {
    const root = pathResolver.sharedTmp(`personal-pads-migrate-apply-${Date.now()}/memory-capture`);
    const session = `${root}/sessions/old-1`;
    safeMkdir(session, { recursive: true });
    safeWriteFile(`${session}/notes.md`, '移行本文', { mkdir: true, encoding: 'utf8' });
    const handoff = JSON.stringify({
      title: '移行',
      viewer_principal: 'human:alice',
      scope: { scope_kind: 'tenant', tier: 'public', tenant_slug: 'tenant-a' },
      notes_path: `${session}/notes.md`,
    });
    safeWriteFile(`${root}/handoff.json`, handoff, { mkdir: true, encoding: 'utf8' });
    safeWriteFile(`${session}/handoff.json`, handoff, { mkdir: true, encoding: 'utf8' });
    const storageRoot = pathResolver.sharedTmp(`personal-pads-migrate-dest-${Date.now()}`);
    const report = migrateLegacyPads({
      roots: [root],
      storageRoot,
      dryRun: false,
    });
    expect(report.migrated).toBe(1);
    expect(report.items.filter((item) => item.status === 'skipped')).toHaveLength(1);
    const repeated = migrateLegacyPads({
      roots: [root],
      storageRoot,
      dryRun: false,
    });
    expect(repeated.migrated).toBe(0);
    expect(repeated.items.filter((item) => item.status === 'skipped')).toHaveLength(2);
  });

  it('copies a legacy attachment into the scoped artifact store and verifies the body hash', () => {
    const root = pathResolver.sharedTmp(`personal-pads-migrate-attachment-${Date.now()}/doc-drop`);
    const session = `${root}/sessions/old-1`;
    const source = `${session}/attachments/note.txt`;
    safeMkdir(session, { recursive: true });
    safeWriteFile(source, '添付本文', { mkdir: true, encoding: 'utf8' });
    safeWriteFile(`${session}/notes.md`, '移行本文', { mkdir: true, encoding: 'utf8' });
    safeWriteFile(
      `${root}/handoff.json`,
      JSON.stringify({
        title: '添付移行',
        viewer_principal: 'human:alice',
        scope: { scope_kind: 'tenant', tier: 'public', tenant_slug: 'tenant-a' },
        notes_path: `${session}/notes.md`,
        attachments: [{ name: 'note.txt', mime: 'text/plain', path: source }],
      }),
      { mkdir: true, encoding: 'utf8' }
    );
    const storageRoot = pathResolver.sharedTmp(
      `personal-pads-migrate-attachment-dest-${Date.now()}`
    );
    const report = migrateLegacyPads({ roots: [root], storageRoot, dryRun: false });
    expect(report.migrated).toBe(1);
    const recordId = report.items[0]?.record_id;
    expect(recordId).toBeTruthy();
    const record = new PadRecordStore(
      { scope_kind: 'tenant', tier: 'public', tenant_slug: 'tenant-a' },
      'human:alice',
      'doc-drop',
      undefined,
      storageRoot
    ).get(recordId!);
    expect(record?.artifact_refs).toHaveLength(1);
    expect(record?.content_sha256).toBe(report.items[0]?.content_sha256);
  });

  it('reconstructs body text from every legacy handoff shape without guessing scope', () => {
    const rootBase = pathResolver.sharedTmp(`personal-pads-migrate-shapes-${Date.now()}`);
    const write = (
      padId: string,
      handoff: Record<string, unknown>,
      files: Record<string, string> = {}
    ) => {
      const root = `${rootBase}/${padId}`;
      safeMkdir(root, { recursive: true });
      for (const [name, body] of Object.entries(files)) {
        safeWriteFile(`${root}/${name}`, body, { mkdir: true, encoding: 'utf8' });
      }
      safeWriteFile(
        `${root}/handoff.json`,
        JSON.stringify({
          viewer_principal: 'human:alice',
          scope: { scope_kind: 'tenant', tier: 'public', tenant_slug: 'tenant-a' },
          ...handoff,
        }),
        { mkdir: true, encoding: 'utf8' }
      );
      return root;
    };
    const roots = [
      write(
        'memory-capture',
        { notes_path: `${rootBase}/memory-capture/notes.md` },
        { 'notes.md': 'memory' }
      ),
      write(
        'meeting-notepad',
        {
          notes_path: `${rootBase}/meeting-notepad/notes.md`,
          transcript_path: `${rootBase}/meeting-notepad/transcript.md`,
        },
        { 'notes.md': 'notes', 'transcript.md': 'transcript' }
      ),
      write(
        'sketch-input',
        { image_path: `${rootBase}/sketch-input/latest.png`, instruction: 'sketch' },
        { 'latest.png': 'png-sketch' }
      ),
      write(
        'clipboard-inbox',
        { items_path: `${rootBase}/clipboard-inbox/items.json` },
        {
          'items.json': JSON.stringify({ items: [{ label: 'source', text: 'clip' }] }),
        }
      ),
      write(
        'daily-desk',
        {
          journal_path: `${rootBase}/daily-desk/journal.md`,
          todo_path: `${rootBase}/daily-desk/todo.md`,
          now_path: `${rootBase}/daily-desk/now.md`,
        },
        { 'journal.md': 'journal', 'todo.md': 'todo', 'now.md': 'now' }
      ),
      write(
        'doc-drop',
        { attachments: [{ name: 'brief.md', path: `${rootBase}/doc-drop/brief.md` }] },
        {
          'brief.md': 'brief',
        }
      ),
      write(
        'screenshot-annotate',
        { image_path: `${rootBase}/screenshot-annotate/latest.png`, instruction: 'annotate' },
        { 'latest.png': 'png-screenshot' }
      ),
      write('personal-workbench', { entry: { body: 'workbench' } }),
    ];
    const report = migrateLegacyPads({ roots });
    expect(report.scanned).toBe(8);
    expect(report.held).toBe(0);
    expect(report.items.every((item) => item.status === 'ready')).toBe(true);
  });

  it('uses source and attachment hashes for idempotency and preserves canonical payload fields', () => {
    const root = pathResolver.sharedTmp(
      `personal-pads-migrate-fingerprint-${Date.now()}/screenshot-annotate`
    );
    const session = `${root}/sessions`;
    safeMkdir(session, { recursive: true });
    const first = `${session}/first.png`;
    const second = `${session}/second.png`;
    safeWriteFile(first, 'image-one', { mkdir: true, encoding: 'utf8' });
    safeWriteFile(second, 'image-two', { mkdir: true, encoding: 'utf8' });
    const makeHandoff = (image_path: string, capture_session_id: string) => ({
      title: '同じ注釈',
      viewer_principal: 'human:alice',
      scope: { scope_kind: 'tenant', tier: 'public', tenant_slug: 'tenant-a' },
      image_path,
      capture_session_id,
      instruction: '同じ注釈',
    });
    safeWriteFile(`${root}/first.json`, JSON.stringify(makeHandoff(first, 'capture-one')), {
      mkdir: true,
      encoding: 'utf8',
    });
    safeWriteFile(
      `${root}/second-handoff.json`,
      JSON.stringify(makeHandoff(second, 'capture-two')),
      {
        mkdir: true,
        encoding: 'utf8',
      }
    );
    // The migrator scans handoff.json only; keep two captures in separate roots
    // to exercise the same-scope duplicate rule without changing the contract.
    const rootTwo = pathResolver.sharedTmp(
      `personal-pads-migrate-fingerprint-${Date.now()}-two/screenshot-annotate`
    );
    safeMkdir(rootTwo, { recursive: true });
    safeWriteFile(`${root}/handoff.json`, JSON.stringify(makeHandoff(first, 'capture-one')), {
      mkdir: true,
      encoding: 'utf8',
    });
    safeWriteFile(`${rootTwo}/latest.png`, 'image-two', { mkdir: true, encoding: 'utf8' });
    safeWriteFile(
      `${rootTwo}/handoff.json`,
      JSON.stringify(makeHandoff(`${rootTwo}/latest.png`, 'capture-two')),
      { mkdir: true, encoding: 'utf8' }
    );
    const storageRoot = pathResolver.sharedTmp(
      `personal-pads-migrate-fingerprint-dest-${Date.now()}`
    );
    const report = migrateLegacyPads({ roots: [root, rootTwo], storageRoot, dryRun: false });
    expect(report.migrated).toBe(2);
    const store = new PadRecordStore(
      { scope_kind: 'tenant', tier: 'public', tenant_slug: 'tenant-a' },
      'human:alice',
      'screenshot-annotate',
      undefined,
      storageRoot
    );
    const records = store.list().records;
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.payload.annotation === '同じ注釈')).toBe(true);
    expect(records.every((record) => record.artifact_refs[0]?.field_id === 'image_name')).toBe(
      true
    );
  });

  it('keeps the original screenshot, clipboard text, and structured meeting minutes editable', () => {
    const base = `personal-pads-migrate-reopen-${Date.now()}`;
    const scope = { scope_kind: 'tenant', tier: 'public', tenant_slug: 'tenant-a' } as const;
    const makeRoot = (padId: string) => pathResolver.sharedTmp(`${base}/${padId}`);
    const screenshotRoot = makeRoot('screenshot-annotate');
    const screenshotSession = `${screenshotRoot}/sessions/capture-1`;
    safeWriteFile(`${screenshotRoot}/latest.png`, 'latest-image', {
      mkdir: true,
      encoding: 'utf8',
    });
    safeWriteFile(`${screenshotSession}/original.png`, 'original-image', {
      mkdir: true,
      encoding: 'utf8',
    });
    safeWriteFile(
      `${screenshotRoot}/handoff.json`,
      JSON.stringify({
        viewer_principal: 'human:alice',
        scope,
        capture_session_id: 'capture-1',
        image_path: `${screenshotRoot}/latest.png`,
        session_image_path: `${screenshotSession}/original.png`,
        instruction: 'annotate',
      }),
      { mkdir: true, encoding: 'utf8' }
    );

    const clipboardRoot = makeRoot('clipboard-inbox');
    safeWriteFile(
      `${clipboardRoot}/items.json`,
      JSON.stringify({ items: [{ label: 'source', text: 'clip text' }] }),
      { mkdir: true, encoding: 'utf8' }
    );
    safeWriteFile(
      `${clipboardRoot}/handoff.json`,
      JSON.stringify({
        viewer_principal: 'human:alice',
        scope,
        items_path: `${clipboardRoot}/items.json`,
        instruction: 'keep',
      }),
      { mkdir: true, encoding: 'utf8' }
    );

    const meetingRoot = makeRoot('meeting-notepad');
    safeWriteFile(`${meetingRoot}/notes.md`, 'notes', { mkdir: true, encoding: 'utf8' });
    safeWriteFile(`${meetingRoot}/transcript.md`, 'transcript', { mkdir: true, encoding: 'utf8' });
    safeWriteFile(
      `${meetingRoot}/minutes.json`,
      JSON.stringify({
        summary: 'summary',
        decisions: ['decision'],
        action_items: ['owner: do it'],
        open_questions: ['question'],
      }),
      { mkdir: true, encoding: 'utf8' }
    );
    safeWriteFile(`${meetingRoot}/minutes.md`, '# Minutes\n\n## Summary\nsummary', {
      mkdir: true,
      encoding: 'utf8',
    });
    safeWriteFile(
      `${meetingRoot}/handoff.json`,
      JSON.stringify({
        viewer_principal: 'human:alice',
        scope,
        title: 'meeting',
        notes_path: `${meetingRoot}/notes.md`,
        transcript_path: `${meetingRoot}/transcript.md`,
        minutes_path: `${meetingRoot}/minutes.md`,
        minutes_json_path: `${meetingRoot}/minutes.json`,
      }),
      { mkdir: true, encoding: 'utf8' }
    );

    const storageRoot = pathResolver.sharedTmp(`${base}-dest`);
    expect(
      migrateLegacyPads({
        roots: [screenshotRoot, clipboardRoot, meetingRoot],
        storageRoot,
        dryRun: false,
      }).migrated
    ).toBe(3);
    const screenshot = new PadRecordStore(
      scope,
      'human:alice',
      'screenshot-annotate',
      undefined,
      storageRoot
    ).list().records[0];
    expect(
      Buffer.from(
        new PadRecordStore(
          scope,
          'human:alice',
          'screenshot-annotate',
          undefined,
          storageRoot
        ).readArtifact(screenshot!.record_id, screenshot!.artifact_refs[0]!.artifact_id)!
          .data_base64,
        'base64'
      ).toString()
    ).toBe('original-image');
    const clipboard = new PadRecordStore(
      scope,
      'human:alice',
      'clipboard-inbox',
      undefined,
      storageRoot
    ).list().records[0];
    expect(clipboard?.payload).toMatchObject({
      body: 'source: clip text',
      items: 'source: clip text',
    });
    const meeting = new PadRecordStore(
      scope,
      'human:alice',
      'meeting-notepad',
      undefined,
      storageRoot
    ).list().records[0];
    expect(meeting?.payload).toMatchObject({
      summary: 'summary',
      decisions: 'decision',
      action_items: 'owner: do it',
      open_questions: 'question',
    });
  });

  it('re-migrates when canonical payload semantics change for the same source', () => {
    const root = pathResolver.sharedTmp(
      `personal-pads-migrate-payload-revision-${Date.now()}/meeting-notepad`
    );
    const minutes = `${root}/minutes.json`;
    safeWriteFile(`${root}/notes.md`, 'stable notes', { mkdir: true, encoding: 'utf8' });
    safeWriteFile(
      minutes,
      JSON.stringify({
        summary: 'old summary',
        decisions: [],
        action_items: [],
        open_questions: [],
      }),
      {
        mkdir: true,
        encoding: 'utf8',
      }
    );
    safeWriteFile(
      `${root}/handoff.json`,
      JSON.stringify({
        viewer_principal: 'human:alice',
        scope: { scope_kind: 'tenant', tier: 'public', tenant_slug: 'tenant-a' },
        notes_path: `${root}/notes.md`,
        minutes_json_path: minutes,
      }),
      { mkdir: true, encoding: 'utf8' }
    );
    const storageRoot = pathResolver.sharedTmp(
      `personal-pads-migrate-payload-revision-dest-${Date.now()}`
    );
    expect(migrateLegacyPads({ roots: [root], storageRoot, dryRun: false }).migrated).toBe(1);

    safeWriteFile(
      minutes,
      JSON.stringify({
        summary: 'repaired summary',
        decisions: [],
        action_items: [],
        open_questions: [],
      }),
      {
        mkdir: true,
        encoding: 'utf8',
      }
    );
    const rerun = migrateLegacyPads({ roots: [root], storageRoot, dryRun: false });
    expect(rerun.migrated).toBe(1);
    expect(rerun.items[0]?.status).toBe('migrated');
    const records = new PadRecordStore(
      { scope_kind: 'tenant', tier: 'public', tenant_slug: 'tenant-a' },
      'human:alice',
      'meeting-notepad',
      undefined,
      storageRoot
    ).list().records;
    expect(records).toHaveLength(2);
    expect(records.some((record) => record.payload.summary === 'repaired summary')).toBe(true);
  });
});

// R7: the reconstructed legacy bodies (Japanese fixed strings) are hashed into
// the migration idempotency identity. Changing their wording would re-import
// every legacy record as a duplicate, so body, content hash and key are
// golden-pinned here.
describe('legacy migration identity (golden)', () => {
  const scope = { scope_kind: 'tenant', tier: 'public', tenant_slug: 'tenant-golden' };

  function migrateOne(padId: string, handoff: (session: string) => Record<string, unknown>) {
    const base = pathResolver.sharedTmp(`personal-pads-migrate-golden-${padId}-${Date.now()}`);
    const root = `${base}/${padId}`;
    const session = `${root}/sessions/golden-1`;
    safeMkdir(session, { recursive: true });
    safeWriteFile(`${session}/handoff.json`, JSON.stringify(handoff(session)), {
      mkdir: true,
      encoding: 'utf8',
    });
    const storageRoot = `${base}-dest`;
    const report = migrateLegacyPads({ roots: [root], storageRoot, dryRun: false });
    expect(report.migrated, JSON.stringify(report.items)).toBe(1);
    const record = new PadRecordStore(
      scope as never,
      'human:golden',
      padId as never,
      undefined,
      storageRoot
    ).list({ limit: 10 }).records[0];
    return { item: report.items[0], record };
  }

  it('sketch-input: an image-only handoff', () => {
    const { item, record } = migrateOne('sketch-input', (session) => {
      safeWriteFile(`${session}/sketch.png`, 'golden-png-bytes', { mkdir: true, encoding: 'utf8' });
      return {
        session_id: 'golden-sketch-1',
        viewer_principal: 'human:golden',
        scope,
        instruction: '',
        image_path: `${session}/sketch.png`,
      };
    });
    expect(record.body).toBe('（画像 artifact）');
    expect(item.content_sha256).toBe(GOLDEN.sketch.content);
    expect(record.idempotency_key).toBe(GOLDEN.sketch.key);
  });

  it('doc-drop: attachments + instruction', () => {
    const { item, record } = migrateOne('doc-drop', (session) => {
      safeWriteFile(`${session}/spec.txt`, 'golden-attachment', { mkdir: true, encoding: 'utf8' });
      return {
        session_id: 'golden-doc-1',
        viewer_principal: 'human:golden',
        scope,
        instruction: 'check the spec',
        attachments: [{ name: 'spec.txt', mime: 'text/plain', path: `${session}/spec.txt` }],
      };
    });
    expect(record.body).toBe('添付: spec.txt\n確認メモ: check the spec');
    expect(item.content_sha256).toBe(GOLDEN.doc.content);
    expect(record.idempotency_key).toBe(GOLDEN.doc.key);
  });
});

const GOLDEN = {
  sketch: {
    content: 'f9c3986f61e96be9dd7092d8e1aec53c7b3d1efa9756fa5b4dea971d956366a3',
    key: 'legacy:2:5a56b97903d9d1cd7da6324609733d86bbffc45f939f3f7c90d8589c07846fbe',
  },
  doc: {
    content: 'ec69d0f22c8a58e2e5f9c8fad3558ba2731b7fd7b2bbeca46b03ca335d24e6bb',
    key: 'legacy:2:0d1452ade31bdff851d1a17f64565b28d64a7e364a644813157aca8bfc577d17',
  },
};
