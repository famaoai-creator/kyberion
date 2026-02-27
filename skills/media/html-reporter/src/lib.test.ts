import { describe, it, expect } from 'vitest';
import { generateHTMLArtifact } from './lib.js';

describe('html-reporter lib', () => {
  const mockInput = {
    title: 'Input Title',
    body: '# Test Report\n- Item 1\n- Item 2',
    format: 'markdown' as const,
  };

  it('should generate valid HTML DocumentArtifact from markdown input', async () => {
    const artifact = await generateHTMLArtifact(mockInput, { title: 'My Report' });

    expect(artifact.format).toBe('html');
    expect(artifact.title).toBe('My Report');
    expect(artifact.body).toContain('<!DOCTYPE html>');
    expect(artifact.body).toContain('<title>My Report</title>');
    expect(artifact.body).toContain('<h1>Test Report</h1>');
    expect(artifact.body).toContain('<li>Item 1</li>');
  });

  it('should support custom styles', async () => {
    const customStyles = 'body { background: red; }';
    const artifact = await generateHTMLArtifact(mockInput, { styles: customStyles });

    expect(artifact.body).toContain(customStyles);
  });

  it('should set the correct language', async () => {
    const artifact = await generateHTMLArtifact(mockInput, { lang: 'en' });
    expect(artifact.body).toContain('<html lang="en">');
  });

  it('should escape malicious script in title (XSS protection)', async () => {
    const maliciousTitle = 'Report <script>alert("xss")</script>';
    const artifact = await generateHTMLArtifact(mockInput, { title: maliciousTitle });
    expect(artifact.body).toContain('&lt;script&gt;');
    expect(artifact.body).not.toContain('<script>');
  });
});
