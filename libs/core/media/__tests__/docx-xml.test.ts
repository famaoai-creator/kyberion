import { describe, expect, it } from 'vitest';
import {
  cleanDocxText,
  diagramPartContentType,
  escapeDocxXml,
  normalizeSymChar,
  scrapeDiagramText,
  scrapeOmmlText,
  splitDocxTextToXml,
} from '../docx-xml.js';
import { distillDocxDesign } from '../docx-utils.js';
import { generateNativeDocx } from '../native-docx-engine/engine.js';
import { docxToMarkdown } from '../protocol-to-markdown.js';
import { pathResolver } from '../../path-resolver.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import AdmZip from 'adm-zip';
import JSZip from 'jszip';
import type { DocxDesignProtocol } from '../../contracts/docx-protocol.js';

describe('docx-xml (WordCraft-aligned)', () => {
  it('escapes whitespace as character references', () => {
    expect(escapeDocxXml('a&b\nc"')).toBe('a&amp;b&#10;c&quot;');
  });

  it('decodes entities and cleans control chars', () => {
    expect(cleanDocxText('A &amp; B')).toBe('A & B');
    expect(cleanDocxText('line\u0001break')).toBe('linebreak');
  });

  it('normalizes sym char attributes', () => {
    expect(normalizeSymChar('0xF061')).toBe('F061');
    expect(normalizeSymChar('U+0041')).toBe('0041');
  });

  it('splits text into tabs, breaks and hyphens', () => {
    const xml = splitDocxTextToXml('a\tb\u00ad c\u2011d\ne');
    expect(xml).toContain('<w:tab/>');
    expect(xml).toContain('<w:softHyphen/>');
    expect(xml).toContain('<w:noBreakHyphen/>');
    expect(xml).toContain('<w:br/>');
    expect(xml).toContain('>a</w:t>');
  });
});

describe('docx specials round-trip', () => {
  it('writes and reads softHyphen / entity text / lvlOverride', async () => {
    const out = pathResolver.sharedTmp('tests/native-docx/wordcraft-port.docx');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const protocol: DocxDesignProtocol = {
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      theme: { colors: { dk1: '000000', lt1: 'FFFFFF' } },
      styles: { definitions: [] },
      relationships: [],
      headersFooters: [],
      sections: [],
      body: [
        {
          type: 'paragraph',
          paragraph: {
            content: [
              {
                type: 'run',
                run: {
                  content: [
                    { type: 'text', text: 'soft' },
                    { type: 'softHyphen' },
                    { type: 'text', text: 'hyphen & more' },
                  ],
                },
              },
            ],
          },
        },
      ],
      numbering: {
        abstractNums: [
          {
            abstractNumId: 0,
            levels: [{ ilvl: 0, numFmt: 'decimal', lvlText: '%1.' }],
          },
        ],
        nums: [{ numId: 1, abstractNumId: 0, overrides: [{ ilvl: 0, startOverride: 5 }] }],
      },
    };

    await generateNativeDocx(protocol, out);
    const zip = new AdmZip(out);
    const docXml = zip.readAsText('word/document.xml');
    expect(docXml).toContain('<w:softHyphen/>');
    expect(docXml).toContain('&amp;');

    const numXml = zip.readAsText('word/numbering.xml');
    expect(numXml).toContain('w:startOverride');
    expect(numXml).toContain('w:val="5"');

    const distilled = await distillDocxDesign(out);
    const texts = distilled.body
      .flatMap((b) => (b.type === 'paragraph' ? b.paragraph.content : []))
      .flatMap((c) => (c.type === 'run' ? c.run.content : []));
    expect(texts.some((t) => t.type === 'softHyphen')).toBe(true);
    expect(texts.some((t) => t.type === 'text' && t.text.includes('&'))).toBe(true);
    expect(distilled.numbering?.nums[0]?.overrides?.[0]?.startOverride).toBe(5);
  });
});

describe('docx OMML + SmartArt distill (WordCraft-aligned thin slice)', () => {
  it('scrapes OMML and diagram text helpers', () => {
    expect(
      scrapeOmmlText('<m:oMath><m:r><m:t>a</m:t></m:r><m:r><m:t>2</m:t></m:r></m:oMath>')
    ).toBe('a2');
    expect(
      scrapeDiagramText('<dgm:pt><dgm:t>Goal</dgm:t></dgm:pt><a:t>Step 1</a:t><a:t>Step 1</a:t>')
    ).toEqual(['Goal', 'Step 1']);
    expect(diagramPartContentType('word/diagrams/data1.xml')).toContain('diagramData');
  });

  it('keeps inline OMML and diagram parts through distill → markdown', async () => {
    const zip = new JSZip();
    zip.file(
      '[Content_Types].xml',
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/diagrams/data1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml"/>
</Types>`
    );
    zip.file(
      '_rels/.rels',
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
    );
    zip.file(
      'word/document.xml',
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>
  <w:p><w:r><w:t>Before</w:t></w:r><m:oMath><m:r><m:t>E=mc</m:t></m:r><m:sSup><m:e><m:r><m:t>2</m:t></m:r></m:e></m:sSup></m:oMath></w:p>
  <m:oMathPara><m:oMath><m:r><m:t>x+y</m:t></m:r></m:oMath></m:oMathPara>
  <w:sectPr/>
</w:body></w:document>`
    );
    zip.file(
      'word/_rels/document.xml.rels',
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramData" Target="diagrams/data1.xml"/>
</Relationships>`
    );
    zip.file(
      'word/diagrams/data1.xml',
      `<?xml version="1.0"?><dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <dgm:ptLst><dgm:pt><dgm:t>Launch</dgm:t></dgm:pt><dgm:pt><a:t>Measure</a:t></dgm:pt></dgm:ptLst>
</dgm:dataModel>`
    );

    const buf = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
    const design = await distillDocxDesign(buf);
    expect(design.passthroughParts?.some((p) => p.path === 'word/diagrams/data1.xml')).toBe(true);
    const md = docxToMarkdown(design);
    expect(md).toContain('$E=mc2$');
    expect(md).toContain('$x+y$');
    expect(md).toContain('Launch');
    expect(md).toContain('Measure');
  });
});
