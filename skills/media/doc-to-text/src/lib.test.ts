import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extract } from './lib';
import * as fs from 'node:fs';
import pdf from 'pdf-parse';
import mammoth from 'mammoth';

vi.mock('node:fs');
vi.mock('pdf-parse');
vi.mock('mammoth');
vi.mock('xlsx');
vi.mock('tesseract.js');

describe('doc-to-text lib', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('extracts plain text successfully', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('Hello text'));
    const result = await extract('test.txt');
    expect(result.layers.content).toBe('Hello text');
  });

  it('extracts PDF text using mock', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('%PDF...'));
    vi.mocked(pdf).mockResolvedValue({ text: 'Extracted PDF', info: { Title: 'Doc' } } as any);
    
    const result = await extract('test.pdf');
    expect(result.layers.content).toBe('Extracted PDF');
  });

  it('extracts Word text using mock', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('docx-binary'));
    vi.mocked(mammoth.extractRawText).mockResolvedValue({ value: 'Extracted Word' } as any);
    
    const result = await extract('test.docx');
    expect(result.layers.content).toBe('Extracted Word');
  });

  it('throws error for unsupported format', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('...'));
    await expect(extract('test.exe')).rejects.toThrow('Unsupported file format');
  });
});
