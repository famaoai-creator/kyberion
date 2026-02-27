import { describe, it, expect, vi, beforeEach } from 'vitest';
import textract from 'textract';
import fs from 'fs';
import { extractTextFromFile } from './lib.js';

vi.mock('textract', () => ({
  default: {
    fromFileWithPath: vi.fn(),
  },
}));

describe('doc-to-text lib', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should extract text from file successfully', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.mocked(textract.fromFileWithPath).mockImplementation((path, callback) => {
      callback(null, 'Extracted content from doc');
    });

    const result = await extractTextFromFile('/test/doc.pdf');
    expect(result.body).toBe('Extracted content from doc');
    expect(result.length).toBe('Extracted content from doc'.length);
    expect(result.file).toBe('/test/doc.pdf');
  });

  it('should handle extraction errors correctly', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.mocked(textract.fromFileWithPath).mockImplementation((path, callback) => {
      callback(new Error('Unknown internal error'), '');
    });

    await expect(extractTextFromFile('/test/fail.pdf')).rejects.toThrow(
      'Extraction failed for fail.pdf'
    );
  });

  it('should throw error for unsupported file formats', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    await expect(extractTextFromFile('/test/image.exe')).rejects.toThrow('Unsupported file format');
  });
});
