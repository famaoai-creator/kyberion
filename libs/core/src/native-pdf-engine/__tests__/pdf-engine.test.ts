/**
 * Native PDF Engine — Unit Tests
 *
 * Tests protocol validation and structure.
 */
import { describe, it, expect } from 'vitest';
import type { PdfDesignProtocol } from '../../types/pdf-protocol.js';

describe('Native PDF Engine', () => {

  describe('PdfDesignProtocol structure', () => {

    it('should create a valid protocol with markdown source', () => {
      const protocol: PdfDesignProtocol = {
        version: '1.0.0',
        generatedAt: new Date().toISOString(),
        source: {
          format: 'markdown',
          body: '# Test\n\nHello world',
          title: 'Test Document',
        },
      };
      expect(protocol.source.format).toBe('markdown');
      expect(protocol.source.body).toContain('# Test');
      expect(protocol.version).toBe('1.0.0');
    });

    it('should create a valid protocol with HTML source', () => {
      const protocol: PdfDesignProtocol = {
        version: '1.0.0',
        generatedAt: new Date().toISOString(),
        source: {
          format: 'html',
          body: '<h1>Test</h1><p>Hello world</p>',
        },
      };
      expect(protocol.source.format).toBe('html');
    });

    it('should support composition options', () => {
      const protocol: PdfDesignProtocol = {
        version: '1.0.0',
        generatedAt: new Date().toISOString(),
        source: { format: 'markdown', body: '# Test' },
        compositionOptions: {
          outputPath: '/tmp/test.pdf',
          format: 'A4',
          margin: { top: '15mm', bottom: '15mm', left: '20mm', right: '20mm' },
          landscape: true,
          printBackground: true,
          theme: {
            title: 'Custom Theme',
            body: 'body { font-family: serif; }',
          },
        },
      };
      expect(protocol.compositionOptions?.format).toBe('A4');
      expect(protocol.compositionOptions?.landscape).toBe(true);
      expect(protocol.compositionOptions?.theme?.body).toContain('serif');
    });

    it('should support metadata from extraction', () => {
      const protocol: PdfDesignProtocol = {
        version: '1.0.0',
        generatedAt: new Date().toISOString(),
        source: { format: 'html', body: '' },
        metadata: {
          title: '報告書',
          author: 'Kyberion',
          pageCount: 5,
          creator: 'Native PDF Engine',
        },
      };
      expect(protocol.metadata?.title).toBe('報告書');
      expect(protocol.metadata?.pageCount).toBe(5);
    });

    it('should support content pages from extraction', () => {
      const protocol: PdfDesignProtocol = {
        version: '1.0.0',
        generatedAt: new Date().toISOString(),
        source: { format: 'html', body: '' },
        content: {
          text: 'Page 1 text\fPage 2 text',
          pages: [
            { pageNumber: 1, width: 595, height: 842, text: 'Page 1 text' },
            { pageNumber: 2, width: 595, height: 842, text: 'Page 2 text' },
          ],
        },
      };
      expect(protocol.content?.pages.length).toBe(2);
      expect(protocol.content?.pages[0].text).toBe('Page 1 text');
    });

    it('should support aesthetic layer', () => {
      const protocol: PdfDesignProtocol = {
        version: '1.0.0',
        generatedAt: new Date().toISOString(),
        source: { format: 'html', body: '' },
        aesthetic: {
          fonts: ['Helvetica', 'Times-Roman'],
          layout: 'single-column',
          elements: [
            { type: 'text', x: 72, y: 100, width: 200, height: 12, text: 'Hello', fontSize: 12, fontName: 'Helvetica' },
          ],
          branding: { logoPresence: true, primaryColor: '#2563eb', tone: 'professional' },
        },
      };
      expect(protocol.aesthetic?.fonts).toContain('Helvetica');
      expect(protocol.aesthetic?.layout).toBe('single-column');
      expect(protocol.aesthetic?.branding?.logoPresence).toBe(true);
    });
  });

  describe('Engine input validation', () => {

    it('should reject empty source body', async () => {
      const { generateNativePdf } = await import('../engine.js');
      const protocol: PdfDesignProtocol = {
        version: '1.0.0',
        generatedAt: new Date().toISOString(),
        source: { format: 'markdown', body: '' },
      };
      await expect(generateNativePdf(protocol, '/tmp/test.pdf')).rejects.toThrow('source.body');
    });

    it('should reject non-existent output directory', async () => {
      const { generateNativePdf } = await import('../engine.js');
      const protocol: PdfDesignProtocol = {
        version: '1.0.0',
        generatedAt: new Date().toISOString(),
        source: { format: 'markdown', body: '# Test' },
      };
      await expect(generateNativePdf(protocol, '/nonexistent/dir/test.pdf')).rejects.toThrow('output directory');
    });
  });
});
