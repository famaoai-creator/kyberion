import AdmZip from 'adm-zip';
import * as fs from 'fs';
import * as path from 'path';
import type { PptxDesignProtocol } from '../types/pptx-protocol.js';
import { generateContentTypes } from './content-types.js';
import { generateGlobalRels, generatePresentationRels, generateSlideRels, generateLayoutRels, generateMasterRels } from './rels.js';
import { generatePresentation } from './presentation.js';
import { generateTheme } from './theme.js';
import { buildShape, buildConnector, buildImage, buildTable, buildSmartArt } from './builders.js';

export async function generateNativePptx(protocol: PptxDesignProtocol, outputPath: string): Promise<void> {
  if (!protocol?.slides?.length) {
    throw new Error('generateNativePptx: protocol must have at least one slide');
  }
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    throw new Error(`generateNativePptx: output directory does not exist: ${dir}`);
  }

  // === RAWPARTS MODE: inject all original parts and patch slide text ===
  // When rawParts is present, we rebuild from the original ZIP structure,
  // only replacing slide XMLs with patched versions based on semantic element changes.
  if (protocol.rawParts && Object.keys(protocol.rawParts).length > 0) {
    const zip = new AdmZip();

    // 1. Inject all raw parts (everything except slide XMLs)
    for (const [entryName, base64Data] of Object.entries(protocol.rawParts)) {
      zip.addFile(entryName, Buffer.from(base64Data, 'base64'));
    }

    // 2. For each slide, apply text changes from semantic elements onto raw XML
    for (const slide of protocol.slides) {
      const slideNumber = parseInt(slide.id.match(/\d+/)?.[0] || '0');
      if (!slideNumber) continue;

      let slideXml = slide.rawSlideXml || '';
      if (!slideXml) continue;

      // Extract original text from raw XML for comparison
      const origTexts = extractTextFromSlideXml(slide.rawSlideXml || '');
      const newTexts = slide.elements
        .filter(el => el.type === 'text' && el.text)
        .map(el => el.text!);

      // Build replacement map: original text → new text (for changed entries)
      const textReplacements: { [key: string]: string } = {};
      for (let i = 0; i < Math.min(origTexts.length, newTexts.length); i++) {
        if (origTexts[i] !== newTexts[i]) {
          textReplacements[origTexts[i]] = newTexts[i];
        }
      }

      // Apply text replacements to raw XML using proven <a:t> patching
      if (Object.keys(textReplacements).length > 0) {
        for (const [orig, repl] of Object.entries(textReplacements)) {
          const escapedOrig = escapeXml(orig);
          const escapedRepl = escapeXml(repl);

          // Strategy 1: Direct <a:t> replacement
          const pattern = `<a:t>${escapedOrig}</a:t>`;
          if (slideXml.includes(pattern)) {
            slideXml = slideXml.split(pattern).join(`<a:t>${escapedRepl}</a:t>`);
            continue;
          }

          // Strategy 2: Multi-run concatenated text within paragraphs
          const paragraphs = slideXml.match(/<a:p[> ][\s\S]*?<\/a:p>/g) || [];
          for (const para of paragraphs) {
            const textParts = para.match(/<a:t>([^<]*)<\/a:t>/g);
            if (!textParts) continue;
            const combined = textParts.map(t => t.replace(/<\/?a:t>/g, '')).join('');
            if (combined === escapedOrig) {
              let newPara = para;
              let firstRun = true;
              newPara = newPara.replace(/<a:t>[^<]*<\/a:t>/g, () => {
                if (firstRun) {
                  firstRun = false;
                  return `<a:t>${escapedRepl}</a:t>`;
                }
                return '<a:t></a:t>';
              });
              slideXml = slideXml.replace(para, newPara);
            }
          }
        }
      }

      // Write slide XML (original or patched)
      zip.addFile(`ppt/slides/slide${slideNumber}.xml`, Buffer.from(slideXml, 'utf8'));

      // Write slide rels
      if (slide.rawSlideRelsXml) {
        zip.addFile(`ppt/slides/_rels/slide${slideNumber}.xml.rels`, Buffer.from(slide.rawSlideRelsXml, 'utf8'));
      }
    }

    zip.writeZip(outputPath);
    return;
  }

  // === SEMANTIC RECONSTRUCTION MODE (original behavior) ===
  const zip = new AdmZip();

  const slideCount = protocol.slides.length;
  const masterCount = protocol.rawMasters?.length || 1;
  const layoutCount = protocol.rawLayouts?.length || 2;

  // Pre-count diagrams, charts, and notes for Content_Types
  let totalDiagrams = 0;
  let totalCharts = 0;
  let totalNotes = 0;
  for (const slide of protocol.slides) {
    if (slide.notesXml) totalNotes++;
    for (const el of slide.elements) {
      if (el.type === 'smartart' && el.smartArtData) totalDiagrams++;
      if (el.type === 'chart' && el.chartData) totalCharts++;
    }
  }

  // 1. Core package files
  zip.addFile('[Content_Types].xml', Buffer.from(generateContentTypes(slideCount, layoutCount, masterCount, totalDiagrams, totalCharts, totalNotes), 'utf8'));
  zip.addFile('_rels/.rels', Buffer.from(generateGlobalRels(), 'utf8'));
  zip.addFile('docProps/core.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Kyberion Native Presentation</dc:title></cp:coreProperties>`, 'utf8'));
  zip.addFile('docProps/app.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Kyberion Native PPTX Engine</Application></Properties>`, 'utf8'));

  // 2. Presentation Root
  zip.addFile('ppt/presentation.xml', Buffer.from(generatePresentation(slideCount, masterCount, Math.round(protocol.canvas.w * 914400), Math.round(protocol.canvas.h * 914400), protocol.extensions), 'utf8'));
  zip.addFile('ppt/_rels/presentation.xml.rels', Buffer.from(generatePresentationRels(slideCount, masterCount), 'utf8'));
  zip.addFile('ppt/presProps.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentationPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:extLst><p:ext uri="{E76CE94A-603C-4142-B9EB-6D1370010A27}"><p14:discardImageEditData xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" val="0"/></p:ext></p:extLst></p:presentationPr>`, 'utf8'));
  zip.addFile('ppt/viewProps.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:viewPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:slideViewPr><p:cSldViewPr><p:cViewPr><p:scale><a:sx n="102" d="100"/><a:sy n="102" d="100"/></p:scale><p:origin x="-108" y="-120"/></p:cViewPr><p:guideLst/></p:cSldViewPr></p:slideViewPr><p:notesTextViewPr><p:cViewPr><p:scale><a:sx n="100" d="100"/><a:sy n="100" d="100"/></p:scale><p:origin x="0" y="0"/></p:cViewPr></p:notesTextViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`, 'utf8'));
  zip.addFile('ppt/tableStyles.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`, 'utf8'));
  
  // 3. Theme (use raw XML if available for faithful round-trip)
  const themeXml = protocol.rawThemeXml || generateTheme(protocol.theme);
  zip.addFile('ppt/theme/theme1.xml', Buffer.from(themeXml, 'utf8'));

  // 4. Slide Master & Layouts
  let imageCounter = 1;

  if ((protocol.rawMasters?.length || protocol.rawMasterXml) && protocol.rawLayouts) {
    // === RAW PASSTHROUGH MODE: inject original masters/layouts/themes/media ===

    // Inject all slide masters and their themes
    if (protocol.rawMasters && protocol.rawMasters.length > 0) {
      protocol.rawMasters.forEach((master, i) => {
        const num = i + 1;
        zip.addFile(`ppt/slideMasters/slideMaster${num}.xml`, Buffer.from(master.xml, 'utf8'));
        if (master.relsXml) {
          zip.addFile(`ppt/slideMasters/_rels/slideMaster${num}.xml.rels`, Buffer.from(master.relsXml, 'utf8'));
        }
        // Inject associated themes (theme2.xml, theme3.xml, etc. for masters beyond the first)
        if (master.themeXml && num > 1) {
          zip.addFile(`ppt/theme/theme${num}.xml`, Buffer.from(master.themeXml, 'utf8'));
        }
      });
    } else if (protocol.rawMasterXml) {
      // Legacy single-master fallback
      zip.addFile('ppt/slideMasters/slideMaster1.xml', Buffer.from(protocol.rawMasterXml, 'utf8'));
      if (protocol.rawMasterRelsXml) {
        zip.addFile('ppt/slideMasters/_rels/slideMaster1.xml.rels', Buffer.from(protocol.rawMasterRelsXml, 'utf8'));
      } else {
        zip.addFile('ppt/slideMasters/_rels/slideMaster1.xml.rels', Buffer.from(generateMasterRels(layoutCount), 'utf8'));
      }
    }

    protocol.rawLayouts.forEach((layout, i) => {
      const num = i + 1;
      zip.addFile(`ppt/slideLayouts/slideLayout${num}.xml`, Buffer.from(layout.xml, 'utf8'));
      if (layout.relsXml) {
        zip.addFile(`ppt/slideLayouts/_rels/slideLayout${num}.xml.rels`, Buffer.from(layout.relsXml, 'utf8'));
      } else {
        zip.addFile(`ppt/slideLayouts/_rels/slideLayout${num}.xml.rels`, Buffer.from(generateLayoutRels(1), 'utf8'));
      }
    });

    // Inject master/layout media files
    if (protocol.masterMedia) {
      for (const media of protocol.masterMedia) {
        zip.addFile(`ppt/media/${media.fileName}`, Buffer.from(media.data, 'base64'));
      }
      // Advance imageCounter past master media to avoid filename collisions with slide images
      const maxMasterIdx = protocol.masterMedia.reduce((max, m) => {
        const numMatch = m.fileName.match(/image(\d+)/);
        return numMatch ? Math.max(max, parseInt(numMatch[1])) : max;
      }, 0);
      if (maxMasterIdx >= imageCounter) imageCounter = maxMasterIdx + 1;
    }
  } else {
    // === SEMANTIC RECONSTRUCTION MODE (default) ===
    let masterSpTree = `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`;
    let titleLayoutSpTree = `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`;
    let standardLayoutSpTree = `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`;
    let masterIdCounter = 2;

    const masterOnlyCount = protocol.master.masterOnlyCount ?? protocol.master.elements.length;
    protocol.master.elements.forEach((el, idx) => {
      const isMasterOnly = idx < masterOnlyCount;

      if (el.type === 'shape' || el.type === 'text') {
        const shapeXml = buildShape(el, masterIdCounter++);
        if (isMasterOnly) {
          // Master-only elements go to master spTree only
          masterSpTree += shapeXml;
        } else {
          // Layout-derived placeholder elements go to layouts, not master
          standardLayoutSpTree += shapeXml;
          if (el.placeholderType === 'ctrTitle' || el.placeholderType === 'title' || el.placeholderType === 'subTitle') {
            titleLayoutSpTree += shapeXml;
          }
        }
      } else if (el.type === 'line') {
        if (isMasterOnly) masterSpTree += buildConnector(el, masterIdCounter++);
      } else if (el.type === 'raw' && el.rawXml) {
        let finalXml = el.rawXml;
        if (el.rawRels) {
          for (const [oldRId, imgPath] of Object.entries(el.rawRels) as [string, any][]) {
            const ext = path.extname(imgPath).toLowerCase() || '.png';
            const targetName = `image${imageCounter}${ext}`;
            const newRId = `rId${masterIdCounter++}`;
            finalXml = finalXml.replace(new RegExp(`r:embed="${oldRId}"`, 'g'), `r:embed="${newRId}"`);
          }
        }
        if (isMasterOnly) masterSpTree += finalXml;
      }
    });
    masterSpTree += `</p:spTree>`;
    titleLayoutSpTree += `</p:spTree>`;
    standardLayoutSpTree += `</p:spTree>`;

    const masterBg = protocol.master.bgXml || `<p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>`;
    const masterClrMap = protocol.master.clrMapXml || `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>`;
    const masterTxStyles = protocol.master.txStylesXml || `<p:txStyles>
    <p:titleStyle>
      <a:lvl1pPr algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1">
        <a:lnSpc><a:spcPct val="90000"/></a:lnSpc>
        <a:spcBef><a:spcPct val="0"/></a:spcBef>
        <a:buNone/>
        <a:defRPr sz="4400" kern="1200">
          <a:solidFill><a:schemeClr val="tx1"/></a:solidFill>
          <a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/>
        </a:defRPr>
      </a:lvl1pPr>
    </p:titleStyle>
    <p:bodyStyle>
      <a:lvl1pPr marL="228600" indent="-228600" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1">
        <a:lnSpc><a:spcPct val="90000"/></a:lnSpc>
        <a:spcBef><a:spcPts val="1000"/></a:spcBef>
        <a:buFont typeface="Arial" panose="020B0604020202020204" pitchFamily="34" charset="0"/>
        <a:buChar char="&#x2022;"/>
        <a:defRPr sz="2800" kern="1200">
          <a:solidFill><a:schemeClr val="tx1"/></a:solidFill>
          <a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/>
        </a:defRPr>
      </a:lvl1pPr>
    </p:bodyStyle>
    <p:otherStyle>
      <a:defPPr>
        <a:defRPr lang="ja-JP"/>
      </a:defPPr>
    </p:otherStyle>
  </p:txStyles>`;

    // Build sldLayoutIdLst dynamically for all layouts
    let sldLayoutIdLst = '<p:sldLayoutIdLst>';
    for (let i = 0; i < layoutCount; i++) {
      sldLayoutIdLst += `<p:sldLayoutId id="${2147483650 + i}" r:id="rId${i + 1}"/>`;
    }
    sldLayoutIdLst += '</p:sldLayoutIdLst>';

    const masterXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>${masterBg}${masterSpTree}</p:cSld>
  ${masterClrMap}
  ${sldLayoutIdLst}
  ${masterTxStyles}
  ${protocol.master.extensions || ''}
</p:sldMaster>`;

    // showMasterSp="0" removes the black sidebar from the title slide
    const titleLayoutXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="title" showMasterSp="0" preserve="1">
  <p:cSld name="Title Layout">${titleLayoutSpTree}</p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`;

    const standardLayoutXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="obj" preserve="1">
  <p:cSld name="Standard Layout">${standardLayoutSpTree}</p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`;

    zip.addFile('ppt/slideMasters/slideMaster1.xml', Buffer.from(masterXml, 'utf8'));
    zip.addFile('ppt/slideMasters/_rels/slideMaster1.xml.rels', Buffer.from(generateMasterRels(layoutCount), 'utf8'));
    zip.addFile('ppt/slideLayouts/slideLayout1.xml', Buffer.from(titleLayoutXml, 'utf8'));
    zip.addFile('ppt/slideLayouts/_rels/slideLayout1.xml.rels', Buffer.from(generateLayoutRels(1), 'utf8'));
    zip.addFile('ppt/slideLayouts/slideLayout2.xml', Buffer.from(standardLayoutXml, 'utf8'));
    zip.addFile('ppt/slideLayouts/_rels/slideLayout2.xml.rels', Buffer.from(generateLayoutRels(1), 'utf8'));
  }

  // 5. Slides (imageCounter declared here, also used by master raw elements above via hoisting)
  let diagramCounter = 1;
  protocol.slides.forEach((slide, sIdx) => {
    const slideNumber = sIdx + 1;
    let slideSpTree = `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`;
    
    const slideExtras: { id: string, type: string, target: string }[] = [];
    let slideIdCounter = 2;

    slide.elements.forEach(el => {
      let rIdLink: string | undefined = undefined;
      if (el.linkTarget) {
        rIdLink = `rId${slideIdCounter++}`;
        slideExtras.push({ id: rIdLink, type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink', target: el.linkTarget });
      }

      if (el.type === 'shape' || el.type === 'text') {
        slideSpTree += buildShape(el, slideIdCounter++, rIdLink);
      } else if (el.type === 'line') {
        slideSpTree += buildConnector(el, slideIdCounter++, rIdLink);
      } else if (el.type === 'table') {
        slideSpTree += buildTable(el, slideIdCounter++);
      } else if (el.type === 'image' && (el.imagePath || el.imageData)) {
        const ext = el.imagePath ? path.extname(el.imagePath).toLowerCase() || '.png' : '.png';
        const targetName = `image${imageCounter}${ext}`;
        const rId = `rId${slideIdCounter++}`;

        slideExtras.push({ id: rId, type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image', target: `../media/${targetName}` });
        slideSpTree += buildImage(el, slideIdCounter++, rId, rIdLink);

        // Prefer imageData (base64) for lossless round-trip; fall back to imagePath
        if (el.imageData) {
          zip.addFile(`ppt/media/${targetName}`, Buffer.from(el.imageData, 'base64'));
        } else if (el.imagePath && fs.existsSync(el.imagePath)) {
          zip.addFile(`ppt/media/${targetName}`, fs.readFileSync(el.imagePath));
        }
        imageCounter++;
      } else if (el.type === 'smartart' && el.smartArtData) {
        const dmId = `rId${slideIdCounter++}`;
        const loId = `rId${slideIdCounter++}`;
        const qsId = `rId${slideIdCounter++}`;
        const csId = `rId${slideIdCounter++}`;
        
        const dNum = diagramCounter++;
        
        if (el.smartArtData.dataXml) zip.addFile(`ppt/diagrams/data${dNum}.xml`, Buffer.from(el.smartArtData.dataXml, 'utf8'));
        if (el.smartArtData.layoutXml) zip.addFile(`ppt/diagrams/layout${dNum}.xml`, Buffer.from(el.smartArtData.layoutXml, 'utf8'));
        if (el.smartArtData.quickStyleXml) zip.addFile(`ppt/diagrams/quickStyle${dNum}.xml`, Buffer.from(el.smartArtData.quickStyleXml, 'utf8'));
        if (el.smartArtData.colorsXml) zip.addFile(`ppt/diagrams/colors${dNum}.xml`, Buffer.from(el.smartArtData.colorsXml, 'utf8'));

        slideExtras.push({ id: dmId, type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramData', target: `../diagrams/data${dNum}.xml` });
        slideExtras.push({ id: loId, type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramLayout', target: `../diagrams/layout${dNum}.xml` });
        slideExtras.push({ id: qsId, type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramQuickStyle', target: `../diagrams/quickStyle${dNum}.xml` });
        slideExtras.push({ id: csId, type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramColors', target: `../diagrams/colors${dNum}.xml` });

        if (el.smartArtData.rels && Object.keys(el.smartArtData.rels).length > 0) {
          let dataRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`;
          for (const [key, rel] of Object.entries(el.smartArtData.rels) as [string, any][]) {
            dataRelsXml += `\n  <Relationship Id="${key}" Type="${rel.type}" Target="${rel.target}"/>`;
          }
          dataRelsXml += `\n</Relationships>`;
          zip.addFile(`ppt/diagrams/_rels/data${dNum}.xml.rels`, Buffer.from(dataRelsXml, 'utf8'));
        }

        slideSpTree += buildSmartArt(el, slideIdCounter, dmId, loId, qsId, csId);
      } else if (el.type === 'chart' && el.chartData) {
        const cId = `rId${slideIdCounter++}`;
        const cNum = diagramCounter++; // reuse counter for generic elements
        
        if (el.chartData.chartXml) zip.addFile(`ppt/charts/chart${cNum}.xml`, Buffer.from(el.chartData.chartXml, 'utf8'));
        if (el.chartData.workbookBlob && el.chartData.workbookTarget) {
          const wbPath = `ppt/embeddings/${path.basename(el.chartData.workbookTarget)}`;
          zip.addFile(wbPath, Buffer.from(el.chartData.workbookBlob, 'base64'));
        }

        slideExtras.push({ id: cId, type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart', target: `../charts/chart${cNum}.xml` });

        if (el.chartData.rels && Object.keys(el.chartData.rels).length > 0) {
          let chartRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`;
          for (const [key, rel] of Object.entries(el.chartData.rels) as [string, any][]) {
            chartRelsXml += `\n  <Relationship Id="${key}" Type="${rel.type}" Target="${rel.target}"/>`;
          }
          chartRelsXml += `\n</Relationships>`;
          zip.addFile(`ppt/charts/_rels/chart${cNum}.xml.rels`, Buffer.from(chartRelsXml, 'utf8'));
        }

        // Just inject the raw XML of the chart frame if available, otherwise fallback
        if (el.rawXml) {
          slideSpTree += el.rawXml.replace(/r:id="[^"]*"/, `r:id="${cId}"`);
        }
      } else if (el.type === 'raw' && el.rawXml) {
        let finalXml = el.rawXml;
        if (el.rawRels) {
          for (const [oldRId, imgPath] of Object.entries(el.rawRels) as [string, any][]) {
            const ext = path.extname(imgPath).toLowerCase() || '.png';
            const targetName = `image${imageCounter}${ext}`;
            const newRId = `rId${slideIdCounter++}`;
            
            slideExtras.push({ id: newRId, type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image', target: `../media/${targetName}` });
            finalXml = finalXml.replace(new RegExp(`r:embed="${oldRId}"`, 'g'), `r:embed="${newRId}"`);
            
            if (fs.existsSync(imgPath)) {
              zip.addFile(`ppt/media/${targetName}`, fs.readFileSync(imgPath));
            }
            imageCounter++;
          }
        }
        // Basic replacement of old IDs if they conflict, though it's safer to leave them if they don't break.
        // We inject the raw XML directly. This perfectly preserves <p:grpSp> groups!
        slideSpTree += finalXml;
      }
    });
    slideSpTree += `</p:spTree>`;

    let bgXml = '';
    if (slide.bgXml) {
      bgXml = slide.bgXml;
    } else if (slide.backgroundFill) {
      bgXml = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${slide.backgroundFill.replace('#','')}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`;
    }

    const layoutId = slide.layoutIndex ?? (slideNumber === 1 ? 1 : 2);

    const slideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>${bgXml}${slideSpTree}</p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
  ${slide.transitionXml || ''}
  ${slide.extensions || ''}
</p:sld>`;

    if (slide.notesXml) {
      const nId = `rId${slideIdCounter++}`;
      zip.addFile(`ppt/notesSlides/notesSlide${slideNumber}.xml`, Buffer.from(slide.notesXml, 'utf8'));
      slideExtras.push({ id: nId, type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide', target: `../notesSlides/notesSlide${slideNumber}.xml` });
    }

    zip.addFile(`ppt/slides/slide${slideNumber}.xml`, Buffer.from(slideXml, 'utf8'));
    zip.addFile(`ppt/slides/_rels/slide${slideNumber}.xml.rels`, Buffer.from(generateSlideRels(layoutId, slideExtras), 'utf8'));
  });

  zip.writeZip(outputPath);
}

/**
 * Patch text content in an existing PPTX without reconstruction.
 * Clones the original ZIP and only modifies <a:t> text nodes in slide XMLs.
 * This preserves all masters, layouts, themes, media, fonts, and structure perfectly.
 */
export function patchPptxText(
  sourcePath: string,
  outputPath: string,
  textReplacements: { [original: string]: string },
): void {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`patchPptxText: source file does not exist: ${sourcePath}`);
  }
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    throw new Error(`patchPptxText: output directory does not exist: ${dir}`);
  }

  const zip = new AdmZip(sourcePath);

  // Build a mapping of escaped XML text for safe replacement
  const xmlReplacements: { original: string, replacement: string }[] = [];
  for (const [orig, repl] of Object.entries(textReplacements)) {
    xmlReplacements.push({ original: escapeXml(orig), replacement: escapeXml(repl) });
  }

  // Process each slide XML
  const slideEntries = zip.getEntries().filter(e =>
    e.entryName.startsWith('ppt/slides/slide') && e.entryName.endsWith('.xml')
  );

  for (const entry of slideEntries) {
    let xml = entry.getData().toString('utf8');
    let modified = false;

    // Strategy 1: Replace full <a:t> content matches
    for (const { original, replacement } of xmlReplacements) {
      const pattern = `<a:t>${original}</a:t>`;
      if (xml.includes(pattern)) {
        xml = xml.split(pattern).join(`<a:t>${replacement}</a:t>`);
        modified = true;
      }
    }

    // Strategy 2: For multi-run text, try to find and replace concatenated text
    // across adjacent <a:t> tags within the same <a:p> paragraph
    for (const [orig, repl] of Object.entries(textReplacements)) {
      if (modified && !xml.includes(escapeXml(orig))) continue;
      // Find paragraphs containing the text spread across runs
      const escapedOrig = escapeXml(orig);
      const paragraphs = xml.match(/<a:p[> ][\s\S]*?<\/a:p>/g) || [];
      for (const para of paragraphs) {
        const textParts = para.match(/<a:t>([^<]*)<\/a:t>/g);
        if (!textParts) continue;
        const combined = textParts.map(t => t.replace(/<\/?a:t>/g, '')).join('');
        if (combined === escapedOrig) {
          // Replace: keep the first run's formatting, put all text there, empty others
          const escapedRepl = escapeXml(repl);
          let newPara = para;
          let firstRun = true;
          newPara = newPara.replace(/<a:t>[^<]*<\/a:t>/g, (match) => {
            if (firstRun) {
              firstRun = false;
              return `<a:t>${escapedRepl}</a:t>`;
            }
            return '<a:t></a:t>';
          });
          xml = xml.replace(para, newPara);
          modified = true;
        }
      }
    }

    if (modified) {
      zip.updateFile(entry.entryName, Buffer.from(xml, 'utf8'));
    }
  }

  zip.writeZip(outputPath);
}

function escapeXml(str: string): string {
  return str
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unescapeXml(str: string): string {
  return str
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

/**
 * Extract concatenated text per shape from raw slide XML.
 * Groups <a:t> text by their parent <p:sp>/<p:grpSp> shape,
 * returning one string per text-bearing shape (matching extractObjects order).
 */
function extractTextFromSlideXml(xml: string): string[] {
  const results: string[] = [];
  // Match each shape's <p:txBody> and concatenate its <a:t> nodes
  const shapes = xml.match(/<p:sp[ >][\s\S]*?<\/p:sp>/g) || [];
  for (const shape of shapes) {
    const txBody = shape.match(/<p:txBody>[\s\S]*?<\/p:txBody>/);
    if (!txBody) continue;
    const textParts = txBody[0].match(/<a:t>([^<]*)<\/a:t>/g);
    if (!textParts || textParts.length === 0) continue;
    const combined = textParts
      .map(t => unescapeXml(t.replace(/<\/?a:t>/g, '')))
      .join('');
    if (combined.trim()) results.push(combined);
  }
  return results;
}
