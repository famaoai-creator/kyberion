import type { PptxElement, PptxPos, PptxStyle } from '../types/pptx-protocol.js';

function inToEmu(inches: number): number {
  return Math.round(inches * 914400);
}

function sanitizeXmlText(input: string): string {
  return String(input || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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
  const dash = style.lineDash && style.lineDash !== 'solid' ? `<a:prstDash val="${style.lineDash}"/>` : '';
  return `<a:ln w="${w}">${buildColorFill(style.line)}${dash}</a:ln>`;
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

    textBody = `<p:txBody>${bodyPr}${lstStyle}${pContent}</p:txBody>`;
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
      if (el.textColumns && el.textColumns > 1) {
        bodyAttrs += ` numCol="${el.textColumns}"`;
      }
      // Add autofit child element
      let autofitXml = '';
      if (el.autofit === 'normal') autofitXml = '<a:normAutofit/>';
      else if (el.autofit === 'shrink') autofitXml = '<a:spAutoFit/>';
      else if (el.autofit === 'none') autofitXml = '<a:noAutofit/>';
      bodyPr = autofitXml ? `<a:bodyPr ${bodyAttrs}>${autofitXml}</a:bodyPr>` : `<a:bodyPr ${bodyAttrs}/>`;
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
        const safeText = sanitizeXmlText(line);
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
    // Add bullet properties if specified and not already in pPr
    if (el.style?.bullet && !finalPPr.includes('<a:buChar') && !finalPPr.includes('<a:buAutoNum') && !finalPPr.includes('<a:buNone')) {
      const bu = el.style.bullet;
      // Add indent level attribute
      if (bu.level !== undefined && !finalPPr.includes(' lvl="')) {
        finalPPr = finalPPr.replace('<a:pPr', `<a:pPr lvl="${bu.level}"`);
      }
      // Add marL (indent in inches -> EMU)
      if (bu.indent !== undefined && !finalPPr.includes(' marL="')) {
        finalPPr = finalPPr.replace('<a:pPr', `<a:pPr marL="${inToEmu(bu.indent)}"`);
      }
      // Ensure pPr is in open form
      if (finalPPr.includes('/>')) {
        finalPPr = finalPPr.replace('/>', '>');
        finalPPr += '</a:pPr>';
      }
      // Build bullet child elements
      let buXml = '';
      if (bu.color) {
        buXml += `<a:buClr><a:srgbClr val="${bu.color.replace('#', '')}"/></a:buClr>`;
      }
      if (bu.size !== undefined) {
        buXml += `<a:buSzPct val="${Math.round(bu.size * 1000)}"/>`;
      }
      if (bu.font) {
        buXml += `<a:buFont typeface="${bu.font}"/>`;
      }
      if (bu.type === 'char') {
        buXml += `<a:buChar char="${bu.char || '\u2022'}"/>`;
      } else if (bu.type === 'autoNum') {
        const startAttr = bu.startAt !== undefined ? ` startAt="${bu.startAt}"` : '';
        buXml += `<a:buAutoNum type="${bu.numFormat || 'arabicPeriod'}"${startAttr}/>`;
      } else if (bu.type === 'none') {
        buXml += '<a:buNone/>';
      }
      finalPPr = finalPPr.replace('</a:pPr>', `${buXml}</a:pPr>`);
    }
    // Add paragraph spacing if specified and not already in pPr
    if (el.style?.lineSpacing && !finalPPr.includes('<a:lnSpc>')) {
      const spcXml = `<a:lnSpc><a:spcPct val="${Math.round(el.style.lineSpacing * 1000)}"/></a:lnSpc>`;
      finalPPr = finalPPr.replace('</a:pPr>', `${spcXml}</a:pPr>`);
      if (finalPPr.includes('/>')) finalPPr = finalPPr.replace('/>', `>${spcXml}</a:pPr>`);
    }
    if (el.style?.spaceBefore && !finalPPr.includes('<a:spcBef>')) {
      const spcXml = `<a:spcBef><a:spcPts val="${Math.round(el.style.spaceBefore * 100)}"/></a:spcBef>`;
      finalPPr = finalPPr.replace('</a:pPr>', `${spcXml}</a:pPr>`);
    }
    if (el.style?.spaceAfter && !finalPPr.includes('<a:spcAft>')) {
      const spcXml = `<a:spcAft><a:spcPts val="${Math.round(el.style.spaceAfter * 100)}"/></a:spcAft>`;
      finalPPr = finalPPr.replace('</a:pPr>', `${spcXml}</a:pPr>`);
    }

    textBody = `<p:txBody>${bodyPr}${lstStyle}<a:p>${finalPPr}${pContent}<a:endParaRPr lang="ja-JP"/></a:p></p:txBody>`;
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
    const avLst = el.style?.cornerRadius ? `<a:avLst><a:gd name="adj" fmla="val ${el.style.cornerRadius}"/></a:avLst>` : '<a:avLst/>';

    let fillXml = '';
    if (!el.placeholderType) {
      if (el.style?.gradientFill) {
        const stops = el.style.gradientFill.stops.map(s => `<a:gs pos="${s.position}"><a:srgbClr val="${s.color.replace('#','')}"/></a:gs>`).join('');
        const linAngle = el.style.gradientFill.angle !== undefined ? `<a:lin ang="${el.style.gradientFill.angle}" scaled="0"/>` : '';
        fillXml = `<a:gradFill><a:gsLst>${stops}</a:gsLst>${linAngle}</a:gradFill>`;
      } else {
        fillXml = buildColorFill(el.style?.fill);
      }
    }

    let shadowXml = '';
    if (el.style?.shadow) {
      const s = el.style.shadow;
      const tag = s.type === 'inner' ? 'a:innerShdw' : 'a:outerShdw';
      const attrs = [
        s.blur ? `blurRad="${s.blur}"` : '',
        s.dist ? `dist="${s.dist}"` : '',
        s.dir ? `dir="${s.dir}"` : '',
      ].filter(Boolean).join(' ');
      shadowXml = `<a:effectLst><${tag} ${attrs}><a:srgbClr val="${(s.color || '000000').replace('#','')}"${s.opacity !== undefined ? `><a:alpha val="${s.opacity * 1000}"/></a:srgbClr>` : '/>'}</${tag}></a:effectLst>`;
    }

    const lineXml = el.placeholderType ? '' : buildLine(el.style);
    const geomXml = el.custGeomXml ? el.custGeomXml : `<a:prstGeom prst="${shapeType}">${avLst}</a:prstGeom>`;
    spPrContent = `<p:spPr><a:xfrm${rotAttr}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>${geomXml}${fillXml}${lineXml}${shadowXml}</p:spPr>`;
  }

  const styleContent = el.styleXml || '';

  // OOXML requires <p:txBody> even for shapes without text
  if (!textBody) {
    textBody = '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="ja-JP"/></a:p></p:txBody>';
  }

  // Use raw cNvPr/cNvSpPr/nvPr if available for faithful round-trip
  const cNvPr = el.cNvPrXml || `<p:cNvPr id="${id}" name="Shape ${id}"${descrAttr}>${linkXml}</p:cNvPr>`;
  const cNvSpPr = el.cNvSpPrXml || '<p:cNvSpPr/>';
  const nvPr = el.nvPrXml || `<p:nvPr>${phXml}${el.extensions || ''}</p:nvPr>`;

  return `<p:sp><p:nvSpPr>${cNvPr}${cNvSpPr}${nvPr}</p:nvSpPr>${spPrContent}${styleContent}${textBody}</p:sp>`;
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
    spPrContent = `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="${shapeType}"><a:avLst/></a:prstGeom>${buildLine(el.style)}</p:spPr>`;
  }

  const styleContent = el.styleXml || '';
  const cNvPr = el.cNvPrXml || `<p:cNvPr id="${id}" name="Connector ${id}"${descrAttr}>${linkXml}</p:cNvPr>`;
  const nvPr = el.nvPrXml || `<p:nvPr>${el.extensions || ''}</p:nvPr>`;

  const cNvCxnSpPr = el.cNvCxnSpPrXml || '<p:cNvCxnSpPr/>';
  return `<p:cxnSp><p:nvCxnSpPr>${cNvPr}${cNvCxnSpPr}${nvPr}</p:nvCxnSpPr>${spPrContent}${styleContent}</p:cxnSp>`;
}

export function buildImage(el: PptxElement, id: number, rId: string, rIdLink?: string): string {
  const x = inToEmu(el.pos.x);
  const y = inToEmu(el.pos.y);
  const cx = inToEmu(el.pos.w);
  const cy = inToEmu(el.pos.h);

  const descrAttr = el.altText ? ` descr="${el.altText.replace(/"/g, '&quot;')}"` : '';
  const linkXml = rIdLink ? `<a:hlinkClick r:id="${rIdLink}"/>` : '';

  const cNvPr = el.cNvPrXml || `<p:cNvPr id="${id}" name="Picture ${id}"${descrAttr}>${linkXml}</p:cNvPr>`;
  const nvPr = el.nvPrXml || `<p:nvPr>${el.extensions || ''}</p:nvPr>`;
  const spPr = el.spPrXml
    ? el.spPrXml.replace(/(<a:off[^>]*?\s)x="[^"]*"/, `$1x="${x}"`).replace(/(<a:off[^>]*?\s)y="[^"]*"/, `$1y="${y}"`).replace(/(<a:ext[^>]*?\s)cx="[^"]*"/, `$1cx="${cx}"`).replace(/(<a:ext[^>]*?\s)cy="[^"]*"/, `$1cy="${cy}"`)
    : `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>`;

  // Use raw blipFill if available (preserves crop, effects, etc.), but update the embed rId
  let blipFill: string;
  if (el.blipFillXml) {
    blipFill = el.blipFillXml.replace(/r:embed="[^"]*"/, `r:embed="${rId}"`);
  } else {
    let srcRectXml = '';
    if (el.crop) {
      const attrs = [
        el.crop.left !== undefined ? `l="${el.crop.left}"` : '',
        el.crop.top !== undefined ? `t="${el.crop.top}"` : '',
        el.crop.right !== undefined ? `r="${el.crop.right}"` : '',
        el.crop.bottom !== undefined ? `b="${el.crop.bottom}"` : '',
      ].filter(Boolean).join(' ');
      srcRectXml = `<a:srcRect ${attrs}/>`;
    }
    blipFill = `<p:blipFill><a:blip r:embed="${rId}"/>${srcRectXml}<a:stretch><a:fillRect/></a:stretch></p:blipFill>`;
  }

  return `<p:pic><p:nvPicPr>${cNvPr}<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>${nvPr}</p:nvPicPr>${blipFill}${spPr}</p:pic>`;
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
  
  // If rawXml is available, always prefer it — it preserves merged cells, cell styles, etc. perfectly
  // Only fall back to semantic reconstruction if rawXml is absent
  if (el.rawXml) {
    return el.rawXml;
  }

  if (!el.rows || el.rows.length === 0) return '';

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
        const safeLine = sanitizeXmlText(ln);
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
