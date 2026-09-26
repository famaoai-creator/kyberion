/**
 * distillDocxDesign picture handling: files by default (small designs for
 * image-heavy documents), inline base64 on request, and both round-trip
 * through the native writer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import AdmZip from 'adm-zip';
import { distillDocxDesign } from './docx-utils.js';
import { generateNativeDocx } from './native-docx-engine/engine.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeRmSync } from '../secure-io.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

function docxWithPicture(marker: string): Buffer {
  const zip = new AdmZip();
  zip.addFile(
    '[Content_Types].xml',
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
    )
  );
  zip.addFile(
    '_rels/.rels',
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
    )
  );
  zip.addFile(
    'word/_rels/document.xml.rels',
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>'
    )
  );
  zip.addFile('word/media/image1.png', PNG);
  zip.addFile(
    'word/document.xml',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><w:document ${W_NS}><w:body><w:p><w:r><w:t>${marker}</w:t></w:r></w:p>` +
        '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="9525" cy="9525"/><wp:docPr id="1" name="Figure 1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>' +
        '</w:body></w:document>'
    )
  );
  return zip.toBuffer();
}

function drawings(design: any): any[] {
  const found: any[] = [];
  const walk = (node: any): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (node.type === 'drawing') found.push(node.drawing);
    Object.values(node).forEach(walk);
  };
  walk(design.body);
  return found;
}

describe('distillDocxDesign pictures', () => {
  let workDir = '';
  const createdImageDirs = new Set<string>();

  beforeAll(() => {
    workDir = pathResolver.sharedTmp(`docx-images-${randomUUID()}`);
    safeMkdir(workDir, { recursive: true });
  });

  afterAll(() => {
    if (workDir) safeRmSync(workDir, { recursive: true, force: true });
    for (const dir of createdImageDirs) safeRmSync(dir, { recursive: true, force: true });
  });

  it('writes pictures as files under a per-document dir by default', async () => {
    const first = await distillDocxDesign(docxWithPicture(`doc-a-${randomUUID()}`));
    const second = await distillDocxDesign(docxWithPicture(`doc-b-${randomUUID()}`));
    const [a] = drawings(first);
    const [b] = drawings(second);
    createdImageDirs.add(path.dirname(a.imagePath)).add(path.dirname(b.imagePath));

    expect(a.imageData).toBeUndefined();
    expect(safeExistsSync(a.imagePath)).toBe(true);
    expect(safeReadFile(a.imagePath, { encoding: null })).toEqual(PNG);
    // Same part name, different documents → different dirs, no overwrite.
    expect(path.basename(a.imagePath)).toBe('image1.png');
    expect(path.dirname(a.imagePath)).not.toBe(path.dirname(b.imagePath));
  });

  it('honours an explicit imageDir', async () => {
    const imageDir = path.join(workDir, 'pictures');
    const [drawing] = drawings(await distillDocxDesign(docxWithPicture('x'), { imageDir }));
    expect(drawing.imagePath).toBe(path.join(imageDir, 'image1.png'));
  });

  it('inlines base64 and writes no file with embedImages', async () => {
    const [drawing] = drawings(
      await distillDocxDesign(docxWithPicture('y'), {
        embedImages: true,
        imageDir: path.join(workDir, 'unused'),
      })
    );
    expect(Buffer.from(drawing.imageData, 'base64')).toEqual(PNG);
    expect(drawing.imagePath).toBeUndefined();
    expect(safeExistsSync(path.join(workDir, 'unused'))).toBe(false);
  });

  it('round-trips a file-referenced picture through the native writer', async () => {
    const design = await distillDocxDesign(docxWithPicture('z'), {
      imageDir: path.join(workDir, 'roundtrip-pictures'),
    });
    const outPath = path.join(workDir, 'roundtrip.docx');
    await generateNativeDocx(design, outPath);
    const media = new AdmZip(outPath).getEntry('word/media/image1.png')?.getData();
    expect(media).toEqual(PNG);
  });
});
