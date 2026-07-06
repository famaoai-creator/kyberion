import { describe, expect, it } from 'vitest';
import { getOpInputContract, listOpInputContracts, validateOpInput } from './op-input-contracts.js';

describe('op-input-contracts', () => {
  it('exposes browser and system input contracts', () => {
    expect(getOpInputContract('browser', 'click')).toEqual(
      expect.objectContaining({
        summary: expect.stringContaining('Click'),
        examples: expect.arrayContaining([
          expect.objectContaining({ selector: expect.any(String) }),
        ]),
      })
    );
    expect(getOpInputContract('system', 'write_file')).toEqual(
      expect.objectContaining({
        schema: expect.objectContaining({ type: 'object' }),
      })
    );
    expect(listOpInputContracts('file').write_artifact).toEqual(
      expect.objectContaining({
        examples: expect.arrayContaining([
          expect.objectContaining({ output_path: expect.any(String) }),
        ]),
      })
    );
  });

  it('rejects browser input missing selector or ref', () => {
    const result = validateOpInput('browser', 'click', { text: 'ignored' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.join(' ')).toMatch(/selector|ref/);
    }
  });

  it('rejects file writes without a path', () => {
    const result = validateOpInput('file', 'write', { content: 'hello' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.join(' ')).toMatch(/path/);
    }
  });
});
