import { afterEach, describe, expect, it } from 'vitest';
import { safeRmSync } from '../secure-io.js';
import { readJsonLines } from '../foundation/json.js';
import type { DotCharter } from './dot-charter.js';
import { DOT_PROMPT_SECTIONS, DOT_WAKE_TOOLS } from './dot-extension-registry.js';
import {
  applyDotMemoryOps,
  boundDotMemory,
  distillDotMemory,
  dotMemoryPromptLines,
  dotUpdateMemoryTool,
  emptyDotMemory,
  isoWeekKey,
  parseDotMemoryOp,
  readDotMemory,
  DOT_MEMORY_PROMPT_BUDGET,
  type DotMemoryOp,
} from './dot-memory.js';
import { DOT_MEMORY_DISTILL_FILE, dotStatePath } from './dot-state-paths.js';

const TEST_ROOT = 'active/shared/tmp/dot-memory-tests';
const NOW = new Date('2026-10-05T00:00:00Z');
const CHARTER = {
  kind: 'dot-charter',
  dot_id: 'mem-dot',
  scope: { tier: 'public' },
  attention: { triggers: [] },
  runtime: { heartbeat_id: 'x' },
} as unknown as DotCharter;
const ctx = { rootDir: TEST_ROOT, now: () => NOW };

afterEach(() => safeRmSync(TEST_ROOT, { recursive: true, force: true }));

describe('dot memory ops', () => {
  it('is registered as a wake tool and prompt section', () => {
    expect(DOT_WAKE_TOOLS.map((t) => t.name)).toContain('dot_update_memory');
    expect(DOT_PROMPT_SECTIONS.map((s) => s.id)).toContain('dot-memory');
  });

  it('parses and rejects ops', () => {
    expect(parseDotMemoryOp({ op: 'add_note', text: 'x'.repeat(900) })).toMatchObject({
      ok: true,
      value: { text: 'x'.repeat(400) },
    });
    expect(parseDotMemoryOp({ op: 'add_note' }).ok).toBe(false);
    expect(parseDotMemoryOp({ op: 'close_item', id: '../x' }).ok).toBe(false);
    expect(parseDotMemoryOp({ op: 'resolve_hypothesis', id: 'h-1', status: 'open' }).ok).toBe(
      false
    );
    expect(parseDotMemoryOp({ op: 'zap' }).ok).toBe(false);
  });

  it('applies ops with stable ids, close and resolve', () => {
    const ops: DotMemoryOp[] = [
      { op: 'add_note', text: 'a' },
      { op: 'add_item', text: 'do it' },
      { op: 'add_hypothesis', text: 'h', confidence: 2 },
      { op: 'close_item', id: 'i-1' },
      { op: 'resolve_hypothesis', id: 'h-1', status: 'confirmed' },
      { op: 'close_item', id: 'i-9' },
    ];
    const { doc, errors } = applyDotMemoryOps(emptyDotMemory('d', NOW), ops, NOW, 8192);
    expect(doc.open_items[0]).toMatchObject({ id: 'i-1', status: 'closed' });
    expect(doc.hypotheses[0]).toMatchObject({ id: 'h-1', confidence: 1, status: 'confirmed' });
    expect(errors).toEqual(["close_item: no item 'i-9'"]);
  });

  it('caps lists at 20 evicting closed items first, then oldest', () => {
    let doc = emptyDotMemory('d', NOW);
    doc = applyDotMemoryOps(
      doc,
      [
        { op: 'add_item', text: 'first' },
        { op: 'close_item', id: 'i-1' },
      ],
      NOW,
      99999
    ).doc;
    for (let round = 0; round < 3; round++) {
      doc = applyDotMemoryOps(
        doc,
        Array.from(
          { length: 8 },
          (_, i) => ({ op: 'add_item', text: `i${round}${i}` }) as DotMemoryOp
        ),
        NOW,
        99999
      ).doc;
    }
    expect(doc.open_items).toHaveLength(20);
    expect(doc.open_items.find((i) => i.text === 'first')).toBeUndefined();
    for (let i = 0; i < 25; i++) doc.notes.push({ id: `n-${i}`, text: 't', at: 'x' });
    expect(boundDotMemory(doc, 99999).notes.map((n) => n.id)[0]).toBe('n-5');
  });

  it('enforces the byte budget deterministically: closed, resolved, notes, then open', () => {
    const doc = emptyDotMemory('d', NOW);
    const big = 'z'.repeat(400);
    doc.open_items.push(
      { id: 'i-1', text: big, status: 'closed', at: 'a' },
      { id: 'i-2', text: big, status: 'open', at: 'a' }
    );
    doc.hypotheses.push({ id: 'h-1', text: big, confidence: 0.5, status: 'refuted', at: 'a' });
    doc.notes.push({ id: 'n-1', text: big, at: 'a' }, { id: 'n-2', text: big, at: 'a' });
    const bounded = boundDotMemory(doc, 1000);
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(1000);
    expect(bounded.open_items.map((i) => i.id)).toEqual(['i-2']);
    expect(bounded.hypotheses).toHaveLength(0);
    expect(boundDotMemory(doc, 1000)).toEqual(bounded);
  });

  it('tool.apply persists, honors disable and max_bytes', () => {
    const errors = dotUpdateMemoryTool.apply(CHARTER, [{ op: 'add_note', text: 'remember' }], ctx);
    expect(errors).toEqual([]);
    expect(readDotMemory(CHARTER, ctx).notes[0].text).toBe('remember');
    const off = { ...CHARTER, memory: { enabled: false } } as DotCharter;
    expect(dotUpdateMemoryTool.apply(off, [{ op: 'add_note', text: 'n' }], ctx)).toHaveLength(1);
    expect(dotMemoryPromptLines(off, ctx)).toEqual([]);
    const tiny = { ...CHARTER, memory: { max_bytes: 600 } } as DotCharter;
    dotUpdateMemoryTool.apply(
      tiny,
      Array.from({ length: 5 }, () => ({ op: 'add_note', text: 'q'.repeat(300) })),
      ctx
    );
    expect(JSON.stringify(readDotMemory(tiny, ctx)).length).toBeLessThanOrEqual(600);
  });

  it('prompt lines stay within budget and prefer open work', () => {
    const ops: DotMemoryOp[] = [{ op: 'add_item', text: 'open thing' }];
    for (let i = 0; i < 10; i++) ops.push({ op: 'add_note', text: 'n'.repeat(300) });
    dotUpdateMemoryTool.apply(CHARTER, ops, ctx);
    const lines = dotMemoryPromptLines(CHARTER, ctx);
    expect(lines.join('\n').length).toBeLessThanOrEqual(DOT_MEMORY_PROMPT_BUDGET + 10);
    expect(lines[1]).toContain('open thing');
  });
});

describe('distillDotMemory', () => {
  it('computes ISO weeks', () => {
    expect(isoWeekKey(new Date('2026-10-05T00:00:00Z'))).toBe('2026-W41');
    expect(isoWeekKey(new Date('2026-01-01T00:00:00Z'))).toBe('2026-W01');
  });

  it('distills resolved hypotheses once per week', async () => {
    dotUpdateMemoryTool.apply(
      CHARTER,
      [
        { op: 'add_hypothesis', text: 'cache is stale' },
        { op: 'resolve_hypothesis', id: 'h-1', status: 'confirmed' },
      ],
      ctx
    );
    const first = await distillDotMemory(CHARTER, ctx);
    expect(first).toMatchObject({ key: 'distill:2026-W41', confirmed: 1, refuted: 0 });
    expect(await distillDotMemory(CHARTER, ctx)).toBeUndefined();
    const rows = readJsonLines(`${TEST_ROOT}/${dotStatePath(CHARTER, DOT_MEMORY_DISTILL_FILE)}`);
    expect(rows).toHaveLength(1);
    // next week: the same hypothesis is not distilled again
    expect(
      await distillDotMemory(CHARTER, { ...ctx, now: () => new Date('2026-10-12T00:00:00Z') })
    ).toBeUndefined();
  });
});
