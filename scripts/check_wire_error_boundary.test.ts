import { describe, expect, it } from 'vitest';
import { findWireErrorBoundaryViolations } from './check_wire_error_boundary.js';

describe('wire error boundary checker', () => {
  it('rejects raw exception interpolation in a wire text response', () => {
    expect(
      findWireErrorBoundaryViolations('return { text: `failed: ${err}` };', 'fixture.ts')
    ).toEqual([expect.stringContaining('fixture.ts')]);
  });

  it('accepts the shared formatter', () => {
    expect(
      findWireErrorBoundaryViolations(
        "return { text: formatWireError(err, 'failed') };",
        'fixture.ts'
      )
    ).toEqual([]);
  });

  it('rejects raw exception messages in a Chronos JSON response', () => {
    expect(
      findWireErrorBoundaryViolations(
        'return NextResponse.json({ error: error.message }, { status: 500 });',
        'presence/displays/chronos-mirror-v2/src/app/api/example/route.ts'
      )
    ).toEqual([expect.stringContaining('raw exception message')]);
    expect(
      findWireErrorBoundaryViolations(
        'return NextResponse.json({ error: error?.message }, { status: 500 });',
        'presence/displays/chronos-mirror-v2/src/app/api/example/route.ts'
      )
    ).toEqual([expect.stringContaining('raw exception message')]);
  });

  it('rejects conditional raw exception messages and debug fields', () => {
    expect(
      findWireErrorBoundaryViolations(
        'return NextResponse.json({ error: error instanceof Error ? error.message : "bad", debugStack: error.stack });',
        'presence/displays/chronos-mirror-v2/src/app/api/example/route.ts'
      )
    ).toEqual([
      expect.stringContaining('raw exception message'),
      expect.stringContaining('raw debug error fields'),
    ]);
  });

  it('rejects raw exception messages in Presence Studio JSON responses', () => {
    expect(
      findWireErrorBoundaryViolations(
        'return res.status(500).json({ ok: false, error: error?.message || String(error) });',
        'presence/displays/presence-studio/server.ts'
      )
    ).toEqual([expect.stringContaining('raw exception message')]);
    expect(
      findWireErrorBoundaryViolations(
        'return res.status(503).json({ ok: false, error: `Voice hub failed: ${error?.message}` });',
        'presence/displays/presence-studio/server.ts'
      )
    ).toEqual([expect.stringContaining('raw exception message')]);
  });

  it('rejects raw exception messages in Browser Bridge responses', () => {
    expect(
      findWireErrorBoundaryViolations(
        'return { ok: false, error: `failed: ${err.message}` };',
        'scripts/browser_bridge_host.ts'
      )
    ).toEqual([expect.stringContaining('browser bridge response')]);
    expect(
      findWireErrorBoundaryViolations(
        'return { ok: false, error: formatWireError(err, "failed") };',
        'scripts/browser_bridge_host.ts'
      )
    ).toEqual([]);
  });

  it('rejects raw exception messages in Computer Surface JSON responses', () => {
    expect(
      findWireErrorBoundaryViolations(
        'return res.status(403).json({ ok: false, error: error instanceof Error ? error.message : "Forbidden." });',
        'presence/displays/computer-surface/server.ts'
      )
    ).toEqual([expect.stringContaining('raw exception message')]);
  });
});
