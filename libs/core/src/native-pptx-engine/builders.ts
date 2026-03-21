import type { PptxElement, PptxPos, PptxStyle } from '../types/pptx-protocol.js';

function inToEmu(inches: number): number {
  return Math.round(inches * 914400);
}

function ptToEmu(pt: number): number {
  return Math.round(pt * 12700);
}

function buildColorFill(color?: string): string {
  if (!color) return '<a:noFill/>';
  return `<a:solidFill><a:srgbClr val="${color.replace('#', '')}"/></a:solidFill>`;
}

function buildLine(style?: PptxStyle): string {
  if (!style || !style.line) return '<a:ln><a:noFill/></a:ln>';
  const w = ptToEmu(style.lineWidth || 1);
  return `<a:ln w="${w}">${buildColorFill(style.line)}</a:ln>`;
}

/**
 * Ensure <a:rPr> is in open/close form (not self-closing) so child elements can be injected.
 * Also ensures lang attribute is present.
 */
function ensureOpenRPr(rPr: string): string {
  // Convert self-closing <a:rPr .../> to <a:rPr ...></a:rPr>
  if (rPr.match(/<a:rPr[^>]*\/>/)) {
    rPr = rPr.replace(/\/>$/, '></a:rPr>');
  }
  // Ensure lang attribute
  if (!rPr.includes(' lang="')) {
    rPr = rPr.replace('<a:rPr', '<a:rPr lang="ja-JP"');
  }
  return rPr;
}

export function buildShape(el: PptxElement, id: number, rIdLink?: string): string {
  const x = inToEmu(el.pos.x);
  const y = inToEmu(el.pos.y);
  const cx = inToEmu(el.pos.w);
  const cy = inToEmu(el.pos.h);
  const shapeType = el.shapeType || 'rect';

  let phXml = '';
  if (el.placeholderType) {
    const typeMap: Record<string, string> = { 'title': 'ctrTitle', 'body': 'body', 'subTitle': 'subTitle', 'sldNum': 'sldNum' };
    const mappedType = typeMap[el.placeholderType] || el.placeholderType;
    phXml = `<p:ph type="${mappedType}"${el.placeholderType === 'body' ? ' idx="1"' : ''}/>`;
  }

  const descrAttr = el.altText ? ` descr="${el.altText.replace(/"/g, '&quot;')}"` : '';
  const linkXml = rIdLink ? `<a:hlinkClick r:id="${rIdLink}"/>` : '';

  let textBody = '';
  // Check if text was modified by user. If el.text or el.textRuns is provided and we decide to use them.
  // Actually, if el.pXmlLst exists AND the user didn't modify the text, we just use pXmlLst.
  // We can assume the text is "modified" if we want to force reconstruction, but it's safer to reconstruct ONLY if el.text or textRuns is explicitly given and differs from original. 
  // For simplicity, we can always just reconstruct if el.textRuns exists, or if el.text is explicitly set.
  // Wait, `distillPptxDesign` sets `el.text` and `el.textRuns` initially. So they are always set!
  // To know if it was modified, we'd have to compare. But we can just use pXmlLst if it exists, UNLESS we specifically want to rebuild it.
  
  // To handle text modifications with perfect font fidelity:
  // If pXmlLst exists, we extract the base paragraph style (<a:pPr>) and run style (<a:rPr>) from it.
  let basePPr = '<a:pPr/>';
  let baseRPr = '<a:rPr lang="ja-JP"></a:rPr>';
  if (el.pXmlLst && el.pXmlLst.length > 0) {
    const pPrMatch = el.pXmlLst[0].match(/<a:pPr[^>]*>[\s\S]*?<\/a:pPr>/);
    if (pPrMatch) basePPr = pPrMatch[0];
    const rPrMatch = el.pXmlLst[0].match(/<a:rPr[^>]*\/>|<a:rPr[^>]*>[\s\S]*?<\/a:rPr>/);
    if (rPrMatch) baseRPr = ensureOpenRPr(rPrMatch[0]);
  }

  // We should use pXmlLst ONLY if the user hasn't supplied a modified textRuns array.
  // Since our extraction populates both, we will just use pXmlLst directly.
  // BUT if we want to allow users to change text while keeping font:
  const isTextModified = el.text !== undefined && el.pXmlLst && 
    el.text.replace(/\s/g, '') !== el.pXmlLst.join('').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s/g, '');

  if (el.pXmlLst && el.pXmlLst.length > 0 && !isTextModified) {
    const bodyPr = el.bodyPrXml || '<a:bodyPr/>';
    const lstStyle = el.lstStyleXml || '<a:lstStyle/>';
    
    let pContent = el.pXmlLst.join('');
    if (el.placeholderType === 'sldNum' && !pContent.includes('type="slidenum"')) {
      pContent = `<a:p><a:r><a:fld id="{849679D9-8B75-4876-8543-01C446C42E61}" type="slidenum"><a:rPr smtClean="0"/><a:pPr/><a:t>‹#›</a:t></a:fld></a:r></a:p>`;
    }

    textBody = `<p:txBody>
      ${bodyPr}
      ${lstStyle}
      ${pContent}
    </p:txBody>`;
  } else if (el.text || el.textRuns) {
    let bodyPr = el.bodyPrXml || '';
    if (!bodyPr) {
      // Build bodyPr with valign and margin support
      const valignMap: Record<string, string> = { 'top': 't', 'middle': 'ctr', 'bottom': 'b' };
      const anchor = valignMap[el.style?.valign || ''] || '';
      let bodyAttrs = 'wrap="square" rtlCol="0"';
      if (anchor) bodyAttrs += ` anchor="${anchor}"`;
      if (el.style?.margin) {
        const [mt, mr, mb, ml] = el.style.margin;
        bodyAttrs += ` lIns="${inToEmu(ml)}" tIns="${inToEmu(mt)}" rIns="${inToEmu(mr)}" bIns="${inToEmu(mb)}"`;
      }
      bodyPr = `<a:bodyPr ${bodyAttrs}/>`;
    }
    const lstStyle = el.lstStyleXml || '<a:lstStyle/>';
    const alignMap: Record<string, string> = { 'left': 'l', 'center': 'ctr', 'right': 'r', 'justify': 'just' };
    const align = alignMap[el.style?.align || 'left'];
    
    const runs = el.textRuns || [{ text: el.text || '' }];
    let pContent = '';

    runs.forEach(run => {
      let rPr = ensureOpenRPr(baseRPr); // Start with the original exact font/style (always open form)
      
      // Override specific attributes if requested
      if (run.options?.fontSize || el.style?.fontSize) {
        const sz = Math.round((run.options?.fontSize || el.style?.fontSize || 18) * 100);
        rPr = rPr.includes(' sz="') ? rPr.replace(/ sz="\d+"/, ` sz="${sz}"`) : rPr.replace('<a:rPr', `<a:rPr sz="${sz}"`);
      }
      if (run.options?.bold !== undefined || el.style?.bold !== undefined) {
        const b = (run.options?.bold || el.style?.bold) ? '1' : '0';
        rPr = rPr.includes(' b="') ? rPr.replace(/ b="[01]"/, ` b="${b}"`) : rPr.replace('<a:rPr', `<a:rPr b="${b}"`);
      }
      if (run.options?.italic !== undefined || el.style?.italic !== undefined) {
        const i = (run.options?.italic || el.style?.italic) ? '1' : '0';
        rPr = rPr.includes(' i="') ? rPr.replace(/ i="[01]"/, ` i="${i}"`) : rPr.replace('<a:rPr', `<a:rPr i="${i}"`);
      }
      if (run.options?.underline !== undefined || el.style?.underline !== undefined) {
        const u = (run.options?.underline || el.style?.underline) ? 'sng' : 'none';
        rPr = rPr.includes(' u="') ? rPr.replace(/ u="[^"]*"/, ` u="${u}"`) : rPr.replace('<a:rPr', `<a:rPr u="${u}"`);
      }
      if (run.options?.strike !== undefined) {
        const strike = run.options?.strike ? 'sngStrike' : 'noStrike';
        rPr = rPr.includes(' strike="') ? rPr.replace(/ strike="[^"]*"/, ` strike="${strike}"`) : rPr.replace('<a:rPr', `<a:rPr strike="${strike}"`);
      }
      if (run.options?.color || el.style?.color) {
        const c = run.options?.color || el.style?.color;
        const fillXml = buildColorFill(c);
        if (rPr.includes('<a:solidFill')) {
          rPr = rPr.replace(/<a:solidFill[\s\S]*?<\/a:solidFill>/, fillXml);
        } else {
          rPr = rPr.replace('</a:rPr>', `${fillXml}</a:rPr>`);
        }
      }
      if (run.options?.highlight) {
        const hlXml = `<a:highlight><a:srgbClr val="${run.options.highlight.replace('#','')}"/></a:highlight>`;
        if (rPr.includes('<a:highlight')) {
          rPr = rPr.replace(/<a:highlight[\s\S]*?<\/a:highlight>/, hlXml);
        } else {
          rPr = rPr.replace('</a:rPr>', `${hlXml}</a:rPr>`);
        }
      }
      if (run.options?.fontFamily || el.style?.fontFamily) {
        const font = run.options?.fontFamily || el.style?.fontFamily;
        const fontXml = `<a:latin typeface="${font}"/><a:ea typeface="${font}"/>`;
        if (rPr.includes('<a:latin') || rPr.includes('<a:ea')) {
          rPr = rPr.replace(/<a:latin[^>]*\/>/g, '').replace(/<a:ea[^>]*\/>/g, '').replace('</a:rPr>', `${fontXml}</a:rPr>`);
        } else {
          rPr = rPr.replace('</a:rPr>', `${fontXml}</a:rPr>`);
        }
      }

      // If the text contains newlines, split it into multiple <a:p> tags
      const lines = (run.text || '').split('\n');
      lines.forEach((line, idx) => {
        if (idx > 0) {
          pContent += `</a:p><a:p>${basePPr}`;
        }
        const safeText = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        let textNode = `<a:t>${safeText}</a:t>`;
        if (el.placeholderType === 'sldNum') {
          textNode = `<a:fld id="{849679D9-8B75-4876-8543-01C446C42E61}" type="slidenum">${rPr}<a:pPr/><a:t>‹#›</a:t></a:fld>`;
        }
        pContent += `<a:r>${rPr}${textNode}</a:r>`;
      });
    });

    let finalPPr = basePPr;
    if (align) {
      finalPPr = finalPPr.includes(' algn="') ? finalPPr.replace(/ algn="[^"]*"/, ` algn="${align}"`) : finalPPr.replace('<a:pPr', `<a:pPr algn="${align}"`);
    }

    textBody = `<p:txBody>
      ${bodyPr}
      ${lstStyle}
      <a:p>${finalPPr}${pContent}<a:endParaRPr lang="ja-JP"/></a:p>
    </p:txBody>`;
  }

  let spPrContent = '';
  if (el.spPrXml) {
    // If we have the exact original XML, we just need to ensure the x, y, cx, cy are updated just in case the shape was moved via protocol
    spPrContent = el.spPrXml.replace(/(<a:off[^>]*?\s)x="[^"]*"/, `$1x="${x}"`)
                            .replace(/(<a:off[^>]*?\s)y="[^"]*"/, `$1y="${y}"`)
                            .replace(/(<a:ext[^>]*?\s)cx="[^"]*"/, `$1cx="${cx}"`)
                            .replace(/(<a:ext[^>]*?\s)cy="[^"]*"/, `$1cy="${cy}"`);
  } else {
    const rotAttr = el.style?.rotate ? ` rot="${Math.round(el.style.rotate * 60000)}"` : '';
    spPrContent = `<p:spPr>
      <a:xfrm${rotAttr}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>
      <a:prstGeom prst="${shapeType}"><a:avLst/></a:prstGeom>
      ${el.placeholderType ? '' : buildColorFill(el.style?.fill)}
      ${el.placeholderType ? '' : buildLine(el.style)}
    </p:spPr>`;
  }

  const styleContent = el.styleXml || '';

  // OOXML requires <p:txBody> even for shapes without text
  if (!textBody) {
    textBody = `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="ja-JP"/></a:p></p:txBody>`;
  }

  return `<p:sp>
    <p:nvSpPr>
      <p:cNvPr id="${id}" name="Shape ${id}"${descrAttr}>${linkXml}</p:cNvPr>
      <p:cNvSpPr/>
      <p:nvPr>${phXml}${el.extensions || ''}</p:nvPr>
    </p:nvSpPr>
    ${spPrContent}
    ${styleContent}
    ${textBody}
  </p:sp>`;
}

export function buildConnector(el: PptxElement, id: number, rIdLink?: string): string {
  const x = inToEmu(el.pos.x);
  const y = inToEmu(el.pos.y);
  const cx = inToEmu(el.pos.w);
  const cy = inToEmu(el.pos.h);
  const shapeType = el.shapeType || 'line';

  const descrAttr = el.altText ? ` descr="${el.altText.replace(/"/g, '&quot;')}"` : '';
  const linkXml = rIdLink ? `<a:hlinkClick r:id="${rIdLink}"/>` : '';

  let spPrContent = '';
  if (el.spPrXml) {
    spPrContent = el.spPrXml.replace(/(<a:off[^>]*?\s)x="[^"]*"/, `$1x="${x}"`)
                            .replace(/(<a:off[^>]*?\s)y="[^"]*"/, `$1y="${y}"`)
                            .replace(/(<a:ext[^>]*?\s)cx="[^"]*"/, `$1cx="${cx}"`)
                            .replace(/(<a:ext[^>]*?\s)cy="[^"]*"/, `$1cy="${cy}"`);
  } else {
    spPrContent = `<p:spPr>
      <a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>
      <a:prstGeom prst="${shapeType}"><a:avLst/></a:prstGeom>
      ${buildLine(el.style)}
    </p:spPr>`;
  }

  const styleContent = el.styleXml || '';

  return `<p:cxnSp>
    <p:nvCxnSpPr>
      <p:cNvPr id="${id}" name="Connector ${id}"${descrAttr}>${linkXml}</p:cNvPr>
      <p:cNvCxnSpPr/>
      <p:nvPr>${el.extensions || ''}</p:nvPr>
    </p:nvCxnSpPr>
    ${spPrContent}
    ${styleContent}
  </p:cxnSp>`;
}

export function buildImage(el: PptxElement, id: number, rId: string, rIdLink?: string): string {
  const x = inToEmu(el.pos.x);
  const y = inToEmu(el.pos.y);
  const cx = inToEmu(el.pos.w);
  const cy = inToEmu(el.pos.h);

  const descrAttr = el.altText ? ` descr="${el.altText.replace(/"/g, '&quot;')}"` : '';
  const linkXml = rIdLink ? `<a:hlinkClick r:id="${rIdLink}"/>` : '';

  return `<p:pic>
    <p:nvPicPr>
      <p:cNvPr id="${id}" name="Picture ${id}"${descrAttr}>${linkXml}</p:cNvPr>
      <p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>
      <p:nvPr>${el.extensions || ''}</p:nvPr>
    </p:nvPicPr>
    <p:blipFill>
      <a:blip r:embed="${rId}"/>
      <a:stretch><a:fillRect/></a:stretch>
    </p:blipFill>
    <p:spPr>
      <a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>
      <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
    </p:spPr>
  </p:pic>`;
}

export function buildSmartArt(el: PptxElement, id: number, dmId: string, loId: string, qsId: string, csId: string): string {
  const x = inToEmu(el.pos.x);
  const y = inToEmu(el.pos.y);
  const cx = inToEmu(el.pos.w);
  const cy = inToEmu(el.pos.h);

  return `<p:graphicFrame>
    <p:nvGraphicFramePr>
      <p:cNvPr id="${id}" name="Diagram ${id}"/>
      <p:cNvGraphicFramePr/>
      <p:nvPr>${el.extensions || ''}</p:nvPr>
    </p:nvGraphicFramePr>
    <p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></p:xfrm>
    <a:graphic>
      <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram">
        <d:relIds xmlns:d="http://schemas.openxmlformats.org/drawingml/2006/diagram" r:dm="${dmId}" r:lo="${loId}" r:qs="${qsId}" r:cs="${csId}"/>
      </a:graphicData>
    </a:graphic>
  </p:graphicFrame>`;
}

export function buildTable(el: PptxElement, id: number): string {
  const x = inToEmu(el.pos.x);
  const y = inToEmu(el.pos.y);
  const cx = inToEmu(el.pos.w);
  const cy = inToEmu(el.pos.h);
  
  if (!el.rows || el.rows.length === 0) return '';

  // Check if rows are modified. If not, return the exact original raw XML to preserve complex cell contents (lists, multiple paragraphs, images)
  let isRowsModified = true;
  if (el.rawXml) {
    const originalText = (el.rawXml.match(/<a:t>([^<]*)<\/a:t>/g) || []).map(t => t.replace(/<\/?a:t>/g, '')).join('').replace(/\s/g, '');
    const currentText = el.rows.map(r => r.join('')).join('').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\s/g, '');
    if (originalText === currentText) {
      isRowsModified = false;
    }
  }

  if (!isRowsModified && el.rawXml) {
    // Return original XML but ensure x, y, cx, cy are updated
    return el.rawXml.replace(/(<a:off[^>]*?\s)x="[^"]*"/, `$1x="${x}"`)
                    .replace(/(<a:off[^>]*?\s)y="[^"]*"/, `$1y="${y}"`)
                    .replace(/(<a:ext[^>]*?\s)cx="[^"]*"/, `$1cx="${cx}"`)
                    .replace(/(<a:ext[^>]*?\s)cy="[^"]*"/, `$1cy="${cy}"`);
  }

  const colCount = Math.max(...el.rows.map(r => r.length));
  const fallbackColW = Math.round(cx / colCount);

  let gridXml = '<a:tblGrid>';
  for (let i = 0; i < colCount; i++) {
    const w = el.colWidths && el.colWidths[i] ? inToEmu(el.colWidths[i]) : fallbackColW;
    gridXml += `<a:gridCol w="${w}"/>`;
  }
  gridXml += '</a:tblGrid>';

  let trXml = '';
  el.rows.forEach((row, rIdx) => {
    trXml += `<a:tr h="370840">`;
    for (let cIdx = 0; cIdx < colCount; cIdx++) {
      const cellText = row[cIdx] || '';

      const isHeader = rIdx === 0;
      const fill = isHeader ? '<a:solidFill><a:srgbClr val="232F3E"/></a:solidFill>' : (rIdx % 2 === 0 ? '<a:solidFill><a:srgbClr val="F4F7F9"/></a:solidFill>' : '');
      const textColor = isHeader ? 'FFFFFF' : '1A1A1A';
      const rPrXml = `<a:rPr lang="ja-JP" sz="1100" b="${isHeader ? '1' : '0'}" dirty="0"><a:solidFill><a:srgbClr val="${textColor}"/></a:solidFill></a:rPr>`;

      // Split cell text by newlines into multiple <a:p> elements
      const lines = cellText.split('\n');
      let cellParagraphs = '';
      for (const ln of lines) {
        const safeLine = ln.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        cellParagraphs += `<a:p><a:r>${rPrXml}<a:t>${safeLine}</a:t></a:r><a:endParaRPr lang="ja-JP"/></a:p>`;
      }

      trXml += `<a:tc>
        <a:txBody>
          <a:bodyPr/>
          <a:lstStyle/>
          ${cellParagraphs}
        </a:txBody>
        <a:tcPr>
          <a:lnL w="12700"><a:solidFill><a:srgbClr val="D5DBDB"/></a:solidFill></a:lnL>
          <a:lnR w="12700"><a:solidFill><a:srgbClr val="D5DBDB"/></a:solidFill></a:lnR>
          <a:lnT w="12700"><a:solidFill><a:srgbClr val="D5DBDB"/></a:solidFill></a:lnT>
          <a:lnB w="12700"><a:solidFill><a:srgbClr val="D5DBDB"/></a:solidFill></a:lnB>
          ${fill}
        </a:tcPr>
      </a:tc>`;
    }
    trXml += `</a:tr>`;
  });

  return `<p:graphicFrame>
    <p:nvGraphicFramePr>
      <p:cNvPr id="${id}" name="Table ${id}"/>
      <p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr>
      <p:nvPr>${el.extensions || ''}</p:nvPr>
    </p:nvGraphicFramePr>
    <p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></p:xfrm>
    <a:graphic>
      <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
        <a:tbl>
          <a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId></a:tblPr>
          ${gridXml}
          ${trXml}
        </a:tbl>
      </a:graphicData>
    </a:graphic>
  </p:graphicFrame>`;
}
