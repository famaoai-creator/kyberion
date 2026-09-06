import { describe, expect, it } from 'vitest';
import { addPlanFrontmatter, parseFrontmatter } from './check_improvement_plan_metadata.js';
import { pathResolver } from '@agent/core/path-resolver';
import { readImprovementPlanTextFile } from './check_improvement_plan_metadata.js';

describe('improvement plan metadata', () => {
  it('rejects a directory replacement before metadata parsing', () => {
    expect(() => readImprovementPlanTextFile(pathResolver.rootResolve('scripts'))).toThrow(
      'must be a regular file'
    );
  });

  it('adds stable metadata without changing the plan body', () => {
    const body = '# Plan\n\n本文';
    const next = addPlanFrontmatter(body, 'EXAMPLE_PLAN.ja.md');
    expect(parseFrontmatter(next)).toMatchObject({
      title: 'EXAMPLE PLAN',
      tags: '[improvement-plan, 2026-08]',
      last_updated: '2026-08-25',
      status: 'active',
    });
    expect(next).toContain('# Plan\n\n本文');
  });

  it('does not duplicate existing frontmatter', () => {
    const body = '---\ntitle: Existing\nstatus: partial\n---\n\n# Plan';
    expect(addPlanFrontmatter(body, 'ignored')).toBe(body);
  });

  it('preserves multiline tags while normalizing status', async () => {
    const { normalizePlanFrontmatter } = await import('./check_improvement_plan_metadata.js');
    const body = `---\ntitle: Example\ntags:\n  [\n    tenant,\n    governance,\n  ]\nlast_updated: 2026-08-01\nstatus: in_progress\n---\n\n# Example\n`;
    const next = normalizePlanFrontmatter(body, 'plan.ja.md');
    expect(next).toContain('tenant,');
    expect(next).toContain('governance,');
    expect(next).toContain('status: active');
    expect(next).not.toContain('tags: [improvement-plan, 2026-08]');
  });
});
