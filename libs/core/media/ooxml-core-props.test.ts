import { describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import {
  extractOoxmlCoreProperties,
  extractOoxmlCoreTitle,
  parseOoxmlCorePropertiesXml,
} from './ooxml-core-props.js';

function zipWithCore(titleXml: string): Buffer {
  const zip = new AdmZip();
  zip.addFile(
    'docProps/core.xml',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
${titleXml}
</cp:coreProperties>`,
      'utf8'
    )
  );
  return zip.toBuffer();
}

describe('ooxml-core-props', () => {
  it('reads dc:title with XML entities and ignores writer placeholders', () => {
    expect(
      parseOoxmlCorePropertiesXml(
        '<cp:coreProperties xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Q3 &amp; Plan</dc:title></cp:coreProperties>'
      ).title
    ).toBe('Q3 & Plan');
    expect(extractOoxmlCoreTitle(zipWithCore('<dc:title>取締役会資料</dc:title>'))).toBe(
      '取締役会資料'
    );
    expect(
      extractOoxmlCoreTitle(zipWithCore('<dc:title>Kyberion Native Presentation</dc:title>'))
    ).toBeUndefined();
    expect(extractOoxmlCoreProperties(Buffer.from('not-a-zip')).title).toBeUndefined();
  });

  it('strips nested markup inside dc:title without regex tag sanitizers', () => {
    expect(
      parseOoxmlCorePropertiesXml(
        '<cp:coreProperties xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Safe <em>Title</em></dc:title></cp:coreProperties>'
      ).title
    ).toBe('Safe Title');
  });
});
