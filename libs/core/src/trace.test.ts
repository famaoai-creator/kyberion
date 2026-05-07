import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TraceContext, persistTrace, finalizeAndPersist } from './trace.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TEST_TMP_BASE = path.join(PROJECT_ROOT, 'tests', '_tmp');

function makeTestTmpDir(label: string): string {
  if (!fs.existsSync(TEST_TMP_BASE)) fs.mkdirSync(TEST_TMP_BASE, { recursive: true });
  return fs.mkdtempSync(path.join(TEST_TMP_BASE, `trace-${label}-`));
}

describe('trace', () => {
  describe('TraceContext', () => {
    it('creates a valid trace with traceId', () => {
      const ctx = new TraceContext('test-trace');

      expect(ctx.traceId).toBeTruthy();
      expect(typeof ctx.traceId).toBe('string');
      expect(ctx.traceId.length).toBeGreaterThan(0);
    });

    it('startSpan/endSpan creates child spans', () => {
      const ctx = new TraceContext('root');

      const spanId = ctx.startSpan('child-span', { step: 'first' });
      expect(spanId).toBeTruthy();

      ctx.endSpan('ok');

      const trace = ctx.finalize();
      expect(trace.rootSpan.children).toHaveLength(1);
      expect(trace.rootSpan.children[0].name).toBe('child-span');
      expect(trace.rootSpan.children[0].status).toBe('ok');
      expect(trace.rootSpan.children[0].endTime).toBeTruthy();
    });

    it('addEvent adds events to current span', () => {
      const ctx = new TraceContext('root');

      ctx.addEvent('step-started', { op: 'click' });
      ctx.addEvent('step-completed');

      const trace = ctx.finalize();
      expect(trace.rootSpan.events).toHaveLength(2);
      expect(trace.rootSpan.events[0].name).toBe('step-started');
      expect(trace.rootSpan.events[0].attributes).toEqual({ op: 'click' });
      expect(trace.rootSpan.events[1].name).toBe('step-completed');
    });

    it('addArtifact adds artifacts to current span', () => {
      const ctx = new TraceContext('root');

      ctx.addArtifact('screenshot', '/tmp/screen.png', 'Homepage capture');

      const trace = ctx.finalize();
      expect(trace.rootSpan.artifacts).toHaveLength(1);
      expect(trace.rootSpan.artifacts[0].type).toBe('screenshot');
      expect(trace.rootSpan.artifacts[0].path).toBe('/tmp/screen.png');
      expect(trace.rootSpan.artifacts[0].description).toBe('Homepage capture');
    });

    it('finalize closes open spans and sets status', () => {
      const ctx = new TraceContext('root');

      // Start spans without ending them
      ctx.startSpan('unclosed-1');
      ctx.startSpan('unclosed-2');

      const trace = ctx.finalize();

      // Open spans should be force-closed with error status
      const child = trace.rootSpan.children[0];
      expect(child.status).toBe('error');
      expect(child.endTime).toBeTruthy();

      // Root should reflect error status due to child errors
      expect(trace.rootSpan.status).toBe('error');
      expect(trace.metadata.completedAt).toBeTruthy();
    });

    it('summary returns correct counts', () => {
      const ctx = new TraceContext('root');

      ctx.startSpan('span-1');
      ctx.addEvent('event-1');
      ctx.addArtifact('file', '/tmp/a.txt');
      ctx.endSpan('ok');

      ctx.startSpan('span-2');
      ctx.addEvent('event-2');
      ctx.endSpan('error', 'something failed');

      const summary = ctx.summary();
      expect(summary.traceId).toBe(ctx.traceId);
      expect(summary.spans).toBe(3); // root + 2 children
      expect(summary.events).toBe(2);
      expect(summary.artifacts).toBe(1);
      expect(summary.errors).toBe(1); // span-2 has error
    });

    it('nested spans (3 levels deep) work correctly', () => {
      const ctx = new TraceContext('root');

      ctx.startSpan('level-1');
      ctx.startSpan('level-2');
      ctx.startSpan('level-3');
      ctx.addEvent('deep-event');
      ctx.endSpan('ok');  // close level-3
      ctx.endSpan('ok');  // close level-2
      ctx.endSpan('ok');  // close level-1

      const trace = ctx.finalize();

      expect(trace.rootSpan.children).toHaveLength(1);
      const l1 = trace.rootSpan.children[0];
      expect(l1.name).toBe('level-1');
      expect(l1.children).toHaveLength(1);

      const l2 = l1.children[0];
      expect(l2.name).toBe('level-2');
      expect(l2.children).toHaveLength(1);

      const l3 = l2.children[0];
      expect(l3.name).toBe('level-3');
      expect(l3.events).toHaveLength(1);
      expect(l3.events[0].name).toBe('deep-event');

      const summary = ctx.summary();
      expect(summary.spans).toBe(4); // root + 3 levels
    });
  });

  describe('persistTrace', () => {
    let savedPersona: string | undefined;
    let savedRole: string | undefined;

    beforeEach(() => {
      savedPersona = process.env.KYBERION_PERSONA;
      savedRole = process.env.MISSION_ROLE;
      process.env.KYBERION_PERSONA = 'ecosystem_architect';
      process.env.MISSION_ROLE = 'mission_controller';
    });

    afterEach(() => {
      if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
      else process.env.KYBERION_PERSONA = savedPersona;
      if (savedRole === undefined) delete process.env.MISSION_ROLE;
      else process.env.MISSION_ROLE = savedRole;
    });

    it('appends a single JSONL line and creates the directory', () => {
      const tmpDir = makeTestTmpDir('persist');
      const ctx = new TraceContext('persist-test', { actuator: 'test-actuator' });
      ctx.startSpan('child');
      ctx.addEvent('did-something');
      ctx.endSpan('ok');
      const trace = ctx.finalize();

      const written = persistTrace(trace, { dir: tmpDir });
      expect(fs.existsSync(written)).toBe(true);

      const lines = fs.readFileSync(written, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.traceId).toBe(trace.traceId);
      expect(parsed.rootSpan.name).toBe('persist-test');
      expect(parsed._persistedAt).toBeTruthy();

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('appends multiple traces to the same daily file', () => {
      const tmpDir = makeTestTmpDir('persist');

      for (let i = 0; i < 3; i++) {
        const ctx = new TraceContext(`trace-${i}`);
        const trace = ctx.finalize();
        persistTrace(trace, { dir: tmpDir });
      }

      const files = fs.readdirSync(tmpDir);
      expect(files).toHaveLength(1);
      const lines = fs.readFileSync(path.join(tmpDir, files[0]), 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(3);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('finalizeAndPersist', () => {
    let savedPersona: string | undefined;
    let savedRole: string | undefined;

    beforeEach(() => {
      savedPersona = process.env.KYBERION_PERSONA;
      savedRole = process.env.MISSION_ROLE;
      process.env.KYBERION_PERSONA = 'ecosystem_architect';
      process.env.MISSION_ROLE = 'mission_controller';
    });

    afterEach(() => {
      if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
      else process.env.KYBERION_PERSONA = savedPersona;
      if (savedRole === undefined) delete process.env.MISSION_ROLE;
      else process.env.MISSION_ROLE = savedRole;
    });

    it('finalizes the context and persists in one call', () => {
      const tmpDir = makeTestTmpDir('persist');
      const ctx = new TraceContext('combined');
      const { trace, path: written } = finalizeAndPersist(ctx, { dir: tmpDir });

      expect(trace.rootSpan.endTime).toBeTruthy();
      expect(fs.existsSync(written)).toBe(true);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });
});
