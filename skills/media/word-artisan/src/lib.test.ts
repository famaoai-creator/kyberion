import { describe, it, expect, vi, beforeEach } from 'vitest';
import HTMLtoDOCX from 'html-to-docx';
import { generateWordArtifact, WordMasterSpecs } from './lib.js';

vi.mock('html-to-docx', () => ({
  default: vi.fn().mockResolvedValue(Buffer.from('mock docx')),
}));

describe('word-artisan lib', () => {
  const mockSpecs: WordMasterSpecs = {
    master_name: 'Standard',
    typography: {
      body: { font: 'Arial', size: 11, line_height: '1.5', color: '#000' },
      heading_1: { size: 18, alignment: 'center', color: '#333' },
      heading_2: { size: 14, border_bottom: '1pt solid #000', color: '#444' },
    },
    table_style: {
      header_bg: '#eee',
      border_color: '#000',
    },
    layout: { margins: { top: 1440 } },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call HTMLtoDOCX with correctly formatted HTML and specs', async () => {
    const artifact = { title: 'Title', body: '# Title\nSome text', format: 'markdown' as const };
    const buffer = await generateWordArtifact(artifact, mockSpecs);

    expect(buffer.toString()).toBe('mock docx');
    expect(HTMLtoDOCX).toHaveBeenCalledWith(
      expect.stringContaining('<h1>Title</h1>'),
      null,
      expect.objectContaining({
        title: 'Title',
        margins: { top: 1440 },
        fontSize: 22, // 11 * 2
      })
    );
  });

  it('should throw detailed error if generation fails', async () => {
    vi.mocked(HTMLtoDOCX).mockRejectedValueOnce(new Error('Internal Parser Error'));

    const artifact = { title: 'Fail', body: '# Fail', format: 'markdown' as const };
    await expect(generateWordArtifact(artifact, mockSpecs)).rejects.toThrow(
      'Word generation failed: Internal Parser Error'
    );
  });
});
