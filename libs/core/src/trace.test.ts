import { describe, it, expect } from 'vitest';
import { TraceContext } from './trace.js';

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
});
