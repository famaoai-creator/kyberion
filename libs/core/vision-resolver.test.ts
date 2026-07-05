import { afterEach, describe, expect, it } from 'vitest';
import {
  compareGoldenRulePriority,
  resolveGoldenRulePriorityOrder,
  resolveVision,
} from './vision-resolver.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';

describe('vision-resolver', () => {
  const tmpRoot = pathResolver.sharedTmp('vision-resolver-test');

  afterEach(() => {
    if (safeExistsSync(tmpRoot)) {
      safeRmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('keeps the golden rule priority order deterministic', () => {
    expect(compareGoldenRulePriority('logical_integrity', 'vision_alignment')).toBeLessThan(0);
    expect(compareGoldenRulePriority('execution_speed', 'adaptive_resilience')).toBeLessThan(0);
    expect(resolveGoldenRulePriorityOrder().join(' > ')).toBe(
      'logical_integrity > vision_alignment > execution_speed > adaptive_resilience'
    );
  });

  it('resolves tenant vision and exposes steering text for golden-rule evaluation', () => {
    safeMkdir(`${tmpRoot}/customer/acme`, { recursive: true });
    safeMkdir(`${tmpRoot}/vision`, { recursive: true });
    safeWriteFile(
      `${tmpRoot}/customer/acme/vision.md`,
      `# ACME Vision\n\n## Steering\n- Logical integrity first\n- Vision alignment second\n- Speed when safe\n- Resilience when conditions change\n`
    );
    safeWriteFile(`${tmpRoot}/vision/_default.md`, '# Default Vision');

    const vision = resolveVision('acme', tmpRoot);

    expect(vision.source_kind).toBe('customer');
    expect(vision.sections.steering[0]).toContain('Logical integrity first');
    expect(resolveGoldenRulePriorityOrder(vision)[0]).toBe('logical_integrity');
  });
});
