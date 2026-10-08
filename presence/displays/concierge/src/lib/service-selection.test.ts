import { describe, expect, it } from 'vitest';
import { resolveSelectedServices } from './settings-view';
describe('persisted service selection', () => {
  const catalog = [
    { id: 'github', configured: true },
    { id: 'slack', configured: false },
    { id: 'notion', configured: false },
  ];
  it('keeps explicit deselection even for a registered service', () => {
    expect(resolveSelectedServices(catalog, [], ['slack'])).toEqual([]);
  });
  it('restores selections without re-enabling defaults and drops unknown IDs', () => {
    expect(resolveSelectedServices(catalog, ['notion', 'notion', 'unknown'], ['slack'])).toEqual([
      'notion',
    ]);
  });
  it('retains compatibility only for receipts without selections', () => {
    expect(resolveSelectedServices(catalog, undefined, ['slack'])).toEqual(['github', 'slack']);
  });
});
