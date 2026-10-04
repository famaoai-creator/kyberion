import { describe, expect, it, vi } from 'vitest';
import { buildStructuredSlideBody } from './media-structured-pptx.js';

const box = { bodyX: 0.5, bodyY: 1.2, bodyW: 12, bodyH: 5.5, bodyLines: [] };

describe('structured slide components', () => {
  it('reports items dropped past a component cap instead of losing them silently', () => {
    const reportTruncation = vi.fn();
    const wbs = Array.from({ length: 25 }, (_, i) => `Task ${i + 1}`);
    const elements = buildStructuredSlideBody({ wbs }, { ...box, reportTruncation });
    expect(elements && elements.length).toBeGreaterThan(0);
    expect(reportTruncation).toHaveBeenCalledWith('wbs', 20, 25);
  });

  it('does not report when everything fits the cap', () => {
    const reportTruncation = vi.fn();
    buildStructuredSlideBody({ wbs: ['A', 'B', 'C'] }, { ...box, reportTruncation });
    expect(reportTruncation).not.toHaveBeenCalled();
  });
});
