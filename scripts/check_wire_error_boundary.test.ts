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
  });
});
