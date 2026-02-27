import { describe, it, expect, vi, beforeEach } from 'vitest';
import puppeteer from 'puppeteer';
import { composePDF } from './lib.js';

vi.mock('puppeteer', () => ({
  default: {
    launch: vi.fn(),
  },
}));

describe('pdf-composer lib', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should launch puppeteer and generate PDF', async () => {
    const mockPage = {
      setContent: vi.fn().mockResolvedValue(undefined),
      pdf: vi.fn().mockResolvedValue(Buffer.from('PDF Content')),
    };
    const mockBrowser = {
      newPage: vi.fn().mockResolvedValue(mockPage),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(puppeteer.launch).mockResolvedValue(mockBrowser as any);

    const artifact = { title: 'Test', body: '# Hello PDF', format: 'markdown' as const };
    const result = await composePDF(artifact, { outputPath: '/test/out.pdf' });

    expect(result.output).toBe('/test/out.pdf');
    expect(puppeteer.launch).toHaveBeenCalled();
    expect(mockPage.setContent).toHaveBeenCalledWith(
      expect.stringContaining('<h1>Hello PDF</h1>'),
      expect.any(Object)
    );
    expect(mockPage.pdf).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/test/out.pdf', format: 'A4' })
    );
    expect(mockBrowser.close).toHaveBeenCalled();
  });

  it('should close browser even on failure', async () => {
    const mockPage = {
      setContent: vi.fn().mockRejectedValue(new Error('Render error')),
    };
    const mockBrowser = {
      newPage: vi.fn().mockResolvedValue(mockPage),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(puppeteer.launch).mockResolvedValue(mockBrowser as any);

    const artifact = { title: 'Fail', body: '# Fail', format: 'markdown' as const };
    await expect(composePDF(artifact, { outputPath: '/test/fail.pdf' })).rejects.toThrow(
      'Render error'
    );
    expect(mockBrowser.close).toHaveBeenCalled();
  });
});
