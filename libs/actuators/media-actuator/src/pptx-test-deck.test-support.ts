/**
 * Synthetic PPTX fixture for the package-integrity and slide-replacement
 * tests. Built part by part so each test can break exactly one structural
 * rule. Content is neutral placeholder text.
 */
import AdmZip from 'adm-zip';

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PML = 'application/vnd.openxmlformats-officedocument.presentationml';

export const TEST_SLIDE_W = 12192000;
export const TEST_SLIDE_H = 6858000;
/**
 * Top of the master's visible footer mark; generated body shapes must stay
 * above it. The master footer placeholder (unused by the slides) and an empty
 * layout text box sit higher and must not shrink the body zone.
 */
export const TEST_FOOTER_TOP = 6356350;

function rels(entries: Array<[string, string, string, string?]>): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries
    .map(
      ([id, type, target, mode]) =>
        `<Relationship Id="${id}" Type="${type.startsWith('http') ? type : `${REL}/${type}`}" Target="${target}"${mode ? ` TargetMode="${mode}"` : ''}/>`
    )
    .join('')}</Relationships>`;
}

function sp(
  id: number,
  name: string,
  body: string,
  opts: { ph?: string; xfrm?: [number, number, number, number] } = {}
): string {
  const xfrm = opts.xfrm
    ? `<a:xfrm><a:off x="${opts.xfrm[0]}" y="${opts.xfrm[1]}"/><a:ext cx="${opts.xfrm[2]}" cy="${opts.xfrm[3]}"/></a:xfrm>`
    : '';
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr>${opts.ph ?? ''}</p:nvPr></p:nvSpPr><p:spPr>${xfrm}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${body}</p:txBody></p:sp>`;
}

function para(text: string): string {
  return `<a:p><a:r><a:rPr sz="1800"/><a:t>${text}</a:t></a:r></a:p>`;
}

function slideXml(shapes: string, extra = ''): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${extra}</p:sld>`;
}

/**
 * Slide 1: inherited title, a two-run subtitle, a body text box, a picture, a
 * chart with an embedded workbook, a modern comment and notes.
 */
export function slide1Xml(): string {
  return slideXml(
    sp(2, 'Title 1', para('Section heading'), { ph: '<p:ph type="title"/>' }) +
      sp(
        3,
        'Subtitle 2',
        '<a:p><a:pPr algn="l"/><a:r><a:rPr sz="2000" b="1"/><a:t>Old </a:t></a:r><a:r><a:rPr sz="2000"/><a:t>subtitle</a:t></a:r><a:endParaRPr sz="2000"/></a:p>',
        { xfrm: [457200, 1000000, 5000000, 400000] }
      ) +
      sp(4, 'Body 3', para('Body text that will be replaced'), {
        xfrm: [457200, 2000000, 6000000, 1500000],
      }) +
      '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="6" name="Chart 5"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="457200" y="4000000"/><a:ext cx="4000000" cy="1500000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId5"/></a:graphicData></a:graphic></p:graphicFrame>' +
      '<p:pic><p:nvPicPr><p:cNvPr id="5" name="Picture 4"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="7000000" y="2000000"/><a:ext cx="3000000" cy="2000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>',
    '<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" nodeType="tmRoot"/></p:par></p:tnLst></p:timing>' +
      '<p:extLst><p:ext uri="{6950BFC3-D8DA-4A85-94F7-54DA5524770B}"><p188:commentRel xmlns:p188="http://schemas.microsoft.com/office/powerpoint/2018/8/main" r:id="rId6"/></p:ext></p:extLst>'
  );
}

export function slide2Xml(): string {
  return slideXml(sp(2, 'Title 1', para('Closing'), { ph: '<p:ph type="title"/>' }));
}

export function buildTestDeckParts(): Map<string, string | Buffer> {
  const parts = new Map<string, string | Buffer>();
  parts.set(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="fntdata" ContentType="application/x-fontdata"/><Override PartName="/ppt/presentation.xml" ContentType="${PML}.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${PML}.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${PML}.slideLayout+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="${PML}.slide+xml"/><Override PartName="/ppt/slides/slide2.xml" ContentType="${PML}.slide+xml"/><Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="${PML}.notesSlide+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/changesInfos/changesInfo1.xml" ContentType="application/vnd.ms-powerpoint.changesinfo+xml"/><Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/><Override PartName="/ppt/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/><Override PartName="/ppt/comments/modernComment_1.xml" ContentType="application/vnd.ms-powerpoint.comments+xml"/></Types>`
  );
  parts.set('_rels/.rels', rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]));
  parts.set(
    'ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst><p:sldSz cx="${TEST_SLIDE_W}" cy="${TEST_SLIDE_H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`
  );
  parts.set(
    'ppt/_rels/presentation.xml.rels',
    rels([
      ['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'],
      ['rId2', 'slide', 'slides/slide1.xml'],
      ['rId3', 'slide', 'slides/slide2.xml'],
      ['rId4', 'theme', 'theme/theme1.xml'],
      [
        'rId5',
        'http://schemas.microsoft.com/office/2016/11/relationships/changesInfo',
        'changesInfos/changesInfo1.xml',
      ],
    ])
  );
  parts.set(
    'ppt/slideMasters/slideMaster1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sldMaster ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${sp(2, 'Title Placeholder 1', para('Master title'), { ph: '<p:ph type="title"/>', xfrm: [457200, 300000, 11000000, 650000] })}${sp(3, 'Footer Placeholder 2', para('Footer'), { ph: '<p:ph type="ftr" idx="11"/>', xfrm: [4038600, 6000000, 4114800, 365125] })}${sp(4, 'Footer Mark 3', para('Footer mark'), { xfrm: [457200, TEST_FOOTER_TOP, 2000000, 365125] })}</p:spTree></p:cSld><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`
  );
  parts.set(
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    rels([
      ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
      ['rId2', 'theme', '../theme/theme1.xml'],
    ])
  );
  parts.set(
    'ppt/slideLayouts/slideLayout1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sldLayout ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${sp(2, 'Title 1', para('Layout title'), { ph: '<p:ph type="title"/>' })}${sp(3, 'Empty Box 2', '<a:p><a:endParaRPr/></a:p>', { xfrm: [9900000, 5800000, 184731, 307777] })}</p:spTree></p:cSld></p:sldLayout>`
  );
  parts.set(
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']])
  );
  parts.set(
    'ppt/theme/theme1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Test"/>`
  );
  parts.set('ppt/slides/slide1.xml', slide1Xml());
  parts.set(
    'ppt/slides/_rels/slide1.xml.rels',
    rels([
      ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
      ['rId2', 'image', '../media/image1.png'],
      ['rId3', 'notesSlide', '../notesSlides/notesSlide1.xml'],
      ['rId4', 'hyperlink', 'https://example.invalid/', 'External'],
      ['rId5', 'chart', '../charts/chart1.xml'],
      [
        'rId6',
        'http://schemas.microsoft.com/office/2018/10/relationships/comments',
        '../comments/modernComment_1.xml',
      ],
    ])
  );
  parts.set(
    'ppt/charts/chart1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${REL}"><c:externalData r:id="rId1"/></c:chartSpace>`
  );
  parts.set(
    'ppt/charts/_rels/chart1.xml.rels',
    rels([['rId1', 'package', '../embeddings/Microsoft_Excel_Worksheet1.xlsx']])
  );
  parts.set(
    'ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx',
    Buffer.from([0x50, 0x4b, 0x05, 0x06])
  );
  parts.set(
    'ppt/comments/modernComment_1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p188:cmLst xmlns:p188="http://schemas.microsoft.com/office/powerpoint/2018/8/main"/>`
  );
  parts.set('ppt/slides/slide2.xml', slide2Xml());
  parts.set(
    'ppt/slides/_rels/slide2.xml.rels',
    rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']])
  );
  parts.set(
    'ppt/notesSlides/notesSlide1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:notes ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${sp(2, 'Notes 1', para('Speaker note'))}</p:spTree></p:cSld></p:notes>`
  );
  parts.set(
    'ppt/notesSlides/_rels/notesSlide1.xml.rels',
    rels([['rId1', 'slide', '../slides/slide1.xml']])
  );
  parts.set('ppt/media/image1.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  parts.set(
    'ppt/changesInfos/changesInfo1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<pc:chgInfo xmlns:pc="http://schemas.microsoft.com/office/powerpoint/2013/main/command"/>`
  );
  return parts;
}

export function zipParts(parts: Map<string, string | Buffer>): Buffer {
  const zip = new AdmZip();
  for (const [name, data] of parts) {
    zip.addFile(name, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  }
  return zip.toBuffer();
}

export function buildTestDeck(mutate?: (parts: Map<string, string | Buffer>) => void): Buffer {
  const parts = buildTestDeckParts();
  mutate?.(parts);
  return zipParts(parts);
}

export function unzipText(buffer: Buffer): Map<string, string> {
  const zip = new AdmZip(buffer);
  const out = new Map<string, string>();
  for (const entry of zip.getEntries()) {
    if (!entry.isDirectory) out.set(entry.entryName, entry.getData().toString('utf8'));
  }
  return out;
}
