import { describe, expect, it } from 'vitest';
import { loadMissionTemplateCatalog, validateMissionTemplateCatalog } from './mission-creation.js';

describe('mission template catalog', () => {
  it('loads the mission creation templates through the governed catalog', () => {
    const catalog = loadMissionTemplateCatalog();
    expect(catalog.templates.map((template) => template.name)).toEqual([
      'development',
      'meeting_facilitation',
      'operations',
      'operations_report',
    ]);
    expect(catalog.templates[0]?.files[0]?.path).toBe('TASK_BOARD.md');
    // mission-state.json is written by mission creation itself (with `tier`);
    // a template-scaffolded legacy copy stranded missions invisible after a
    // mid-create crash, so no template may ship one.
    for (const template of catalog.templates) {
      expect(template.files.map((file) => file.path)).not.toContain('mission-state.json');
    }
  });

  it('rejects unknown template fields and escaping file paths', () => {
    expect(() =>
      validateMissionTemplateCatalog({
        templates: [
          {
            name: 'unsafe',
            files: [{ path: '../outside.txt', content_template: 'x' }],
            unexpected: true,
          },
        ],
      })
    ).toThrow(/Invalid catalog mission-templates/);
  });
});
