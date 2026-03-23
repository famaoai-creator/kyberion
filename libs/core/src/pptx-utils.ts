import AdmZip from 'adm-zip';
import * as path from 'path';
import { safeExistsSync, safeMkdir, safeWriteFile } from '../secure-io.js';
import type { PptxDesignProtocol, PptxElement, PptxLayoutRaw, PptxMasterMedia, PptxMasterRaw, PptxPos, PptxStyle, PptxTextRun } from './types/pptx-protocol.js';
import { generateNativePptx } from './native-pptx-engine/engine.js';

/**
 * PPTX Utilities v3.0.0 [Native Engine]
 */

function emuToIn(emu: string | undefined | null): number {
  if (!emu) return 0;
  const val = parseInt(emu);
  if (isNaN(val)) return 0;
  return parseFloat((val / 914400).toFixed(6));
}

function emuToPt(emu: string | undefined | null): number {
  if (!emu) return 1;
  const val = parseInt(emu);
  if (isNaN(val)) return 1;
  return parseFloat((val / 12700).toFixed(1));
}

function applyLuminance(hex: string, lumMod?: number, lumOff?: number): string {
  let r = parseInt(hex.substring(0, 2), 16);
  let g = parseInt(hex.substring(2, 4), 16);
  let b = parseInt(hex.substring(4, 6), 16);

  if (lumMod !== undefined) {
    const factor = lumMod / 100000;
    r = Math.round(r * factor);
    g = Math.round(g * factor);
    b = Math.round(b * factor);
  }
  if (lumOff !== undefined) {
    const offset = Math.round((lumOff / 100000) * 255);
    r = Math.min(255, Math.max(0, r + offset));
    g = Math.min(255, Math.max(0, g + offset));
    b = Math.min(255, Math.max(0, b + offset));
  }

  return [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function extractTheme(zip: AdmZip, palette: { [key: string]: string }) {
  const themeEntry = zip.getEntry('ppt/theme/theme1.xml');
  if (!themeEntry) return;
  const themeXml = themeEntry.getData().toString('utf8');
  const tags = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'];
  tags.forEach(tag => {
    const match = themeXml.match(new RegExp(`<a:${tag}>.*?<a:srgbClr val="([0-9A-F]{6})".*?</a:${tag}>`, 's')) || 
                  themeXml.match(new RegExp(`<a:${tag}>.*?<a:sysClr.*?lastClr="([0-9A-F]{6})".*?</a:${tag}>`, 's'));
    if (match) palette[tag] = match[1];
  });
  
  // Extract hlink/folHlink
  ['hlink', 'folHlink'].forEach(tag => {
    const match = themeXml.match(new RegExp(`<a:${tag}>.*?<a:srgbClr val="([0-9A-F]{6})".*?</a:${tag}>`, 's'));
    if (match) palette[tag] = match[1];
  });

  if (!palette['dk1']) palette['dk1'] = '000000';
  if (!palette['lt1']) palette['lt1'] = 'FFFFFF';
  palette['bg1'] = palette['lt1'];
  palette['bg2'] = palette['lt2'] || 'D5D5D5';

  // Extract fontScheme and fmtScheme as raw XML (stored as special palette keys)
  const fontSchemeMatch = themeXml.match(/<a:fontScheme[^>]*>[\s\S]*?<\/a:fontScheme>/);
  if (fontSchemeMatch) palette['__fontSchemeXml'] = fontSchemeMatch[0];
  const fmtSchemeMatch = themeXml.match(/<a:fmtScheme[^>]*>[\s\S]*?<\/a:fmtScheme>/);
  if (fmtSchemeMatch) palette['__fmtSchemeXml'] = fmtSchemeMatch[0];
  const extraClrMatch = themeXml.match(/<a:extraClrSchemeLst>[\s\S]*?<\/a:extraClrSchemeLst>/);
  if (extraClrMatch) palette['__extraClrSchemeXml'] = extraClrMatch[0];
}

function resolveColor(xml: string | undefined, palette: { [key: string]: string }): string | undefined {
  if (!xml || xml.includes('<a:noFill')) return undefined;
  
  let baseColor: string | undefined;
  const srgbMatch = xml.match(/<a:srgbClr val="([0-9A-F]{6})"/);
  if (srgbMatch) baseColor = srgbMatch[1];
  
  if (!baseColor) {
    const schemeMatch = xml.match(/<a:schemeClr val="([^"]*)"/);
    if (schemeMatch) {
      baseColor = palette[schemeMatch[1]];
      if (!baseColor) {
        if (schemeMatch[1] === 'tx1') baseColor = palette['dk1'];
        else if (schemeMatch[1] === 'tx2') baseColor = palette['dk2'];
        else if (schemeMatch[1] === 'bg1') baseColor = palette['lt1'];
        else if (schemeMatch[1] === 'bg2') baseColor = palette['lt2'];
      }
    }
  }

  if (baseColor) {
    const lumModMatch = xml.match(/<a:lumMod val="(\d+)"/);
    const lumOffMatch = xml.match(/<a:lumOff val="(\d+)"/);
    if (lumModMatch || lumOffMatch) {
      return applyLuminance(baseColor, lumModMatch ? parseInt(lumModMatch[1]) : undefined, lumOffMatch ? parseInt(lumOffMatch[1]) : undefined);
    }
    return baseColor;
  }
  return undefined;
}

function resolveRelPath(zip: AdmZip, relsFile: string, rId: string): string | undefined {
  const entry = zip.getEntry(relsFile);
  if (!entry) return undefined;
  const xml = entry.getData().toString('utf8');
  const match = xml.match(new RegExp(`Id="${rId}"[^>]*Target=".*?media/([^"]*)"`));
  return match ? match[1] : undefined;
}

function findInheritedBackground(zip: AdmZip, slideName: string, palette: { [key: string]: string }): { image?: string, color?: string } {
  const findInXml = (xml: string, relsFile: string): { image?: string, color?: string } => {
    const bgMatch = xml.match(/<p:bg>([\s\S]*?)<\/p:bg>/);
    if (bgMatch) {
      const bgXml = bgMatch[1];
      const blip = bgXml.match(/<a:blip r:embed="([^"]*)"/);
      if (blip) return { image: resolveRelPath(zip, relsFile, blip[1]) };
      const color = resolveColor(bgXml, palette);
      if (color) return { color };
    }
    return {};
  };

  const slideEntry = zip.getEntry(`ppt/slides/${slideName}`);
  if (!slideEntry) return {};
  const slideXml = slideEntry.getData().toString('utf8');
  const slideRes = findInXml(slideXml, `ppt/slides/_rels/${slideName}.rels`);
  if (slideRes.image || slideRes.color) return slideRes;

  const slideRelsEntry = zip.getEntry(`ppt/slides/_rels/${slideName}.rels`);
  if (!slideRelsEntry) return {};
  const slideRels = slideRelsEntry.getData().toString('utf8');
  const layoutMatch = slideRels.match(/slideLayouts\/(slideLayout\d+\.xml)/);
  if (layoutMatch) {
    const layoutName = layoutMatch[1];
    const layoutXml = zip.getEntry(`ppt/slideLayouts/${layoutName}`)?.getData().toString('utf8');
    if (layoutXml) {
      const layoutRes = findInXml(layoutXml, `ppt/slideLayouts/_rels/${layoutName}.rels`);
      if (layoutRes.image || layoutRes.color) return layoutRes;
    }

    const layoutRels = zip.getEntry(`ppt/slideLayouts/_rels/${layoutName}.rels`)?.getData().toString('utf8');
    if (layoutRels) {
      const masterMatch = layoutRels.match(/slideMasters\/(slideMaster\d+\.xml)/);
      if (masterMatch) {
        const masterName = masterMatch[1];
        const masterXml = zip.getEntry(`ppt/slideMasters/${masterName}`)?.getData().toString('utf8');
        if (masterXml) {
          const masterRes = findInXml(masterXml, `ppt/slideMasters/_rels/${masterName}.rels`);
          if (masterRes.image || masterRes.color) return masterRes;
        }
      }
    }
  }
  return {};
}

function extractTopLevelShapes(xml: string): string[] {
  const results: string[] = [];
  const tags = ['p:sp', 'p:cxnSp', 'p:pic', 'p:graphicFrame', 'p:grpSp'];
  let currentIndex = 0;

  while (currentIndex < xml.length) {
    let firstTagMatch = null;
    let firstTagIndex = -1;

    for (const tag of tags) {
      let searchIdx = currentIndex;
      while (searchIdx < xml.length) {
        const idx = xml.indexOf(`<${tag}`, searchIdx);
        if (idx === -1) break;
        
        if (xml[idx + tag.length + 1] === '>' || xml[idx + tag.length + 1] === ' ' || xml[idx + tag.length + 1] === '/') {
          if (firstTagIndex === -1 || idx < firstTagIndex) {
            firstTagIndex = idx;
            firstTagMatch = tag;
          }
          break; // Found the earliest valid instance of THIS tag
        } else {
          searchIdx = idx + 1; // False positive (e.g. <p:spTree>), keep looking
        }
      }
    }

    if (!firstTagMatch || firstTagIndex === -1) break;

    const closeTag = `</${firstTagMatch}>`;
    let depth = 0;
    let searchIndex = firstTagIndex;
    let nextClose = -1;
    
    while (searchIndex < xml.length) {
      const nextOpen = xml.indexOf(`<${firstTagMatch}`, searchIndex + 1);
      nextClose = xml.indexOf(closeTag, searchIndex + 1);

      if (nextClose === -1) break;

      // Validate nextOpen
      let isValidOpen = false;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        const charAfter = xml[nextOpen + firstTagMatch.length + 1];
        if (charAfter === '>' || charAfter === ' ' || charAfter === '/') {
          isValidOpen = true;
        } else {
          searchIndex = nextOpen; // False positive open, skip it
          continue;
        }
      }

      if (isValidOpen) {
        depth++;
        searchIndex = nextOpen;
      } else {
        if (depth === 0) {
          results.push(xml.substring(firstTagIndex, nextClose + closeTag.length));
          currentIndex = nextClose + closeTag.length;
          break;
        } else {
          depth--;
          searchIndex = nextClose;
        }
      }
    }
    
    // If we broke out without finding a close tag, advance to avoid infinite loop
    if (searchIndex >= xml.length || nextClose === -1) {
      currentIndex = firstTagIndex + 1;
    }
  }
  return results;
}

function extractObjects(zip: AdmZip, xml: string, palette: { [key: string]: string }, relsFile: string, assetsDir?: string): PptxElement[] {
  const elements: PptxElement[] = [];
  const contentXml = xml.replace(/<p:bg>[\s\S]*?<\/p:bg>/, '');
  
  const rels: { [id: string]: { target: string, type: string } } = {};
  const relsEntry = zip.getEntry(relsFile);
  if (relsEntry) {
    const relsXml = relsEntry.getData().toString('utf8');
    const relRegex = /<Relationship[^>]*Id="([^"]*)"[^>]*Type="([^"]*)"[^>]*Target="([^"]*)"/g;
    let rMatch;
    while ((rMatch = relRegex.exec(relsXml)) !== null) {
      rels[rMatch[1]] = { type: rMatch[2], target: rMatch[3] };
    }
  }

  const shapeBlocks = extractTopLevelShapes(contentXml);

  for (const block of shapeBlocks) {
    const typeTagMatch = block.match(/^<([^>\s]+)/);
    if (!typeTagMatch) continue;
    const typeTag = typeTagMatch[1];
    
    // For p:grpSp, we store it as RAW to preserve complex group relationships perfectly
    if (typeTag === 'p:grpSp') {
      const x = emuToIn(block.match(/<a:off x="(\d+)"/)?.[1]);
      const y = emuToIn(block.match(/<a:off.*?y="(\d+)"/)?.[1]);
      const cx = emuToIn(block.match(/<a:ext cx="(\d+)"/)?.[1]);
      const cy = emuToIn(block.match(/<a:ext.*?cy="(\d+)"/)?.[1]);
      
      const rawRels: { [oldId: string]: string } = {};
      const relRegex = /r:embed="([^"]*)"/g;
      let relMatch;
      while ((relMatch = relRegex.exec(block)) !== null) {
        const rId = relMatch[1];
        if (rels[rId]) {
          rawRels[rId] = assetsDir ? path.join(assetsDir, path.basename(rels[rId].target)) : rels[rId].target;
        }
      }

      elements.push({
        type: 'raw',
        pos: { x, y, w: cx, h: cy },
        rawXml: block,
        rawRels
      });
      continue;
    }

    const body = block;
    
    const x = emuToIn(body.match(/<a:off x="(\d+)"/)?.[1]);
    const y = emuToIn(body.match(/<a:off.*?y="(\d+)"/)?.[1]);
    const cx = emuToIn(body.match(/<a:ext cx="(\d+)"/)?.[1]);
    const cy = emuToIn(body.match(/<a:ext.*?cy="(\d+)"/)?.[1]);
    const rotate = parseInt(body.match(/rot="(\d+)"/)?.[1] || '0') / 60000;

    const phTypeMatch = body.match(/<p:ph[^>]*type="([^"]*)"/);
    const phIdxMatch = body.match(/<p:ph[^>]*idx="([^"]*)"/);
    let placeholderType = phTypeMatch ? phTypeMatch[1] : undefined;
    if (!placeholderType && phIdxMatch && phIdxMatch[1] === '1') placeholderType = 'body';
    const isPageNum = placeholderType === 'sldNum' || body.includes('type="sldNum"');

    // Extract raw cNvPr and nvPr for faithful round-trip
    const cNvPrMatch = body.match(/<p:cNvPr[^>]*\/>|<p:cNvPr[^>]*>[\s\S]*?<\/p:cNvPr>/);
    const nvPrMatch = body.match(/<p:nvPr[^>]*\/>|<p:nvPr[^>]*>[\s\S]*?<\/p:nvPr>/);
    const cNvSpPrMatch = body.match(/<p:cNvSpPr[^>]*\/>|<p:cNvSpPr[^>]*>[\s\S]*?<\/p:cNvSpPr>/);
    const cNvCxnSpPrMatch = body.match(/<p:cNvCxnSpPr[^>]*\/>|<p:cNvCxnSpPr[^>]*>[\s\S]*?<\/p:cNvCxnSpPr>/);
    const blipFillMatch = body.match(/<p:blipFill[^>]*>[\s\S]*?<\/p:blipFill>/);

    // Extract Shape Extensions
    const extLstMatch = body.match(/<p:extLst>[\s\S]*?<\/p:extLst>/);
    const descrMatch = body.match(/<p:cNvPr[^>]*descr="([^"]*)"/);
    const linkMatch = body.match(/<a:hlinkClick[^>]*r:id="([^"]*)"/);

    let linkTarget: string | undefined = undefined;
    if (linkMatch && rels[linkMatch[1]]) {
      linkTarget = rels[linkMatch[1]].target;
    }

    const spPrMatch = body.match(/<p:spPr[^>]*>([\s\S]*?)<\/p:spPr>/) || body.match(/<p:spPr\/>/);
    const styleMatch = body.match(/<p:style>([\s\S]*?)<\/p:style>/);

    // Extract Text Properties
    const bodyPrMatch = body.match(/<a:bodyPr[^>]*>([\s\S]*?)<\/a:bodyPr>/) || body.match(/<a:bodyPr[^>]*\/>/);
    const lstStyleMatch = body.match(/<a:lstStyle[^>]*>([\s\S]*?)<\/a:lstStyle>/) || body.match(/<a:lstStyle[^>]*\/>/);

    
    const paragraphs: string[] = [];
    const textRuns: PptxTextRun[] = [];
    const pXmlLst: string[] = [];
    const pRegex = /<a:p>([\s\S]*?)<\/a:p>/g;
    let pMatch;
    let firstPPr = '';
    while ((pMatch = pRegex.exec(body)) !== null) {
      pXmlLst.push(pMatch[0]); // Save exact paragraph XML
      const pBody = pMatch[1];
      if (!firstPPr) firstPPr = pBody.match(/<a:pPr[^>]*>([\s\S]*?)<\/a:pPr>/)?.[0] || '';
      
      const runsInPara: string[] = [];
      const rRegex = /<a:r>([\s\S]*?)<\/a:r>|<a:br\/>/g;
      let rMatch;
      while ((rMatch = rRegex.exec(pBody)) !== null) {
        if (rMatch[0] === '<a:br/>') {
          runsInPara.push('\n');
          continue;
        }
        const rBody = rMatch[1];
        const rPr = rBody.match(/<a:rPr[^>]*>([\s\S]*?)<\/a:rPr>/)?.[0] || '';
        const tMatch = rBody.match(/<a:t>([^<]*)<\/a:t>/);
        if (tMatch) {
          const textVal = tMatch[1];
          runsInPara.push(textVal);
          const runColor = resolveColor(rPr, palette);
          textRuns.push({
            text: textVal,
            options: {
              color: runColor,
              fontSize: parseFloat(rPr.match(/sz="(\d+)"/)?.[1] || '1800') / 100,
              bold: rPr.includes('b="1"') || rPr.includes('b="true"'),
              italic: rPr.includes('i="1"') || rPr.includes('i="true"')
            }
          });
        }
      }
      paragraphs.push(runsInPara.join(''));
    }
    const fullText = paragraphs.join('\n').trim();

    const spPr = body.match(/<p:spPr>([\s\S]*?)<\/p:spPr>/)?.[1] || '';
    const fillMatch = spPr.match(/<a:solidFill[\s\S]*?<\/a:solidFill>/) || spPr.match(/<a:noFill\/>/);
    const lnXml = spPr.match(/<a:ln[^>]*>([\s\S]*?)<\/a:ln>/)?.[0];
    const prstGeom = spPr.match(/<a:prstGeom prst="([^"]*)"/)?.[1] || 'rect';
    
    const rPrMatch = body.match(/<a:rPr[^>]*>([\s\S]*?)<\/a:rPr>/);
    const rPr = rPrMatch?.[0] || '';
    const fontSize = parseFloat(rPr.match(/sz="(\d+)"/)?.[1] || '1800') / 100;
    const fontFamily = rPr.match(/typeface="([^"]*)"/)?.[1];
    const bold = rPr.includes('b="1"') || rPr.includes('b="true"');
    const italic = rPr.includes('i="1"') || rPr.includes('i="true"');
    const underline = rPr.includes('u="sng"');

    let type: 'shape' | 'text' | 'line' | 'image' | 'table' | 'smartart' | 'chart' | 'raw' = 'shape';
    if (typeTag === 'p:cxnSp') type = 'line';
    else if (typeTag === 'p:pic') type = 'image';
    else if (typeTag === 'p:graphicFrame' && body.includes('<a:tbl>')) type = 'table';
    else if (typeTag === 'p:graphicFrame' && body.includes('uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"')) type = 'smartart';
    else if (typeTag === 'p:graphicFrame' && body.includes('uri="http://schemas.openxmlformats.org/drawingml/2006/chart"')) type = 'chart';
    else if (fullText && prstGeom === 'rect' && !fillMatch) type = 'text';

    // Extract gradient fill
    const gradientMatch = spPr.match(/<a:gradFill[^>]*>([\s\S]*?)<\/a:gradFill>/);
    let gradientFill: PptxStyle['gradientFill'] = undefined;
    if (gradientMatch) {
      const stops: { position: number, color: string }[] = [];
      const gsRegex = /<a:gs pos="(\d+)">([\s\S]*?)<\/a:gs>/g;
      let gsm;
      while ((gsm = gsRegex.exec(gradientMatch[1])) !== null) {
        const c = resolveColor(gsm[2], palette);
        if (c) stops.push({ position: parseInt(gsm[1]), color: c });
      }
      const linMatch = gradientMatch[1].match(/<a:lin ang="(\d+)"/);
      gradientFill = { angle: linMatch ? parseInt(linMatch[1]) : undefined, stops };
    }

    // Extract shadow
    const shadowMatch = spPr.match(/<a:outerShdw([^>]*)>([\s\S]*?)<\/a:outerShdw>/) || spPr.match(/<a:innerShdw([^>]*)>([\s\S]*?)<\/a:innerShdw>/);
    let shadow: PptxStyle['shadow'] = undefined;
    if (shadowMatch) {
      const isInner = shadowMatch[0].startsWith('<a:innerShdw');
      const attrs = shadowMatch[1];
      shadow = {
        type: isInner ? 'inner' : 'outer',
        blur: parseInt(attrs.match(/blurRad="(\d+)"/)?.[1] || '0'),
        dist: parseInt(attrs.match(/dist="(\d+)"/)?.[1] || '0'),
        dir: parseInt(attrs.match(/dir="(\d+)"/)?.[1] || '0'),
        color: resolveColor(shadowMatch[2], palette),
      };
    }

    // Extract corner radius from avLst
    const avLstMatch = spPr.match(/<a:avLst>([\s\S]*?)<\/a:avLst>/);
    let cornerRadius: number | undefined;
    if (avLstMatch && prstGeom === 'roundRect') {
      const gdMatch = avLstMatch[1].match(/<a:gd[^>]*fmla="val (\d+)"/);
      if (gdMatch) cornerRadius = parseInt(gdMatch[1]);
    }

    // Extract line dash
    const lineDashMatch = lnXml?.match(/<a:prstDash val="([^"]*)"/);

    // Extract paragraph spacing from first paragraph
    const lineSpacingMatch = firstPPr.match(/<a:lnSpc><a:spcPct val="(\d+)"\/><\/a:lnSpc>/);
    const spaceBeforeMatch = firstPPr.match(/<a:spcBef><a:spcPts val="(\d+)"\/><\/a:spcBef>/);
    const spaceAfterMatch = firstPPr.match(/<a:spcAft><a:spcPts val="(\d+)"\/><\/a:spcAft>/);

    // Extract bullet info from first paragraph <a:pPr>
    let bullet: PptxStyle['bullet'] = undefined;
    if (firstPPr) {
      const buCharMatch = firstPPr.match(/<a:buChar[^>]*char="([^"]*)"/);
      const buAutoNumMatch = firstPPr.match(/<a:buAutoNum[^>]*type="([^"]*)"/);
      const buNone = firstPPr.includes('<a:buNone/>');
      if (buCharMatch || buAutoNumMatch || buNone) {
        bullet = {
          type: buNone ? 'none' : (buCharMatch ? 'char' : 'autoNum'),
        };
        if (buCharMatch) bullet.char = buCharMatch[1];
        if (buAutoNumMatch) {
          bullet.numFormat = buAutoNumMatch[1];
          const startAtMatch = firstPPr.match(/<a:buAutoNum[^>]*startAt="(\d+)"/);
          if (startAtMatch) bullet.startAt = parseInt(startAtMatch[1]);
        }
        const buFontMatch = firstPPr.match(/<a:buFont[^>]*typeface="([^"]*)"/);
        if (buFontMatch) bullet.font = buFontMatch[1];
        const buSzPctMatch = firstPPr.match(/<a:buSzPct[^>]*val="(\d+)"/);
        if (buSzPctMatch) bullet.size = parseInt(buSzPctMatch[1]) / 1000;
        const buClrMatch = firstPPr.match(/<a:buClr>([\s\S]*?)<\/a:buClr>/);
        if (buClrMatch) bullet.color = resolveColor(buClrMatch[1], palette);
      }
      // Extract marL, indent, lvl from <a:pPr> attributes
      const marLMatch = firstPPr.match(/<a:pPr[^>]*marL="(\d+)"/);
      const indentMatch = firstPPr.match(/<a:pPr[^>]*indent="(-?\d+)"/);
      const lvlMatch = firstPPr.match(/<a:pPr[^>]*lvl="(\d+)"/);
      if (marLMatch || indentMatch || lvlMatch) {
        if (!bullet) bullet = { type: 'char' };
        if (marLMatch) bullet.indent = emuToIn(marLMatch[1]);
        if (lvlMatch) bullet.level = parseInt(lvlMatch[1]);
      }
    }

    const style: PptxStyle = {
      fill: resolveColor(fillMatch?.[0], palette),
      gradientFill,
      line: resolveColor(lnXml, palette),
      lineWidth: emuToPt(lnXml?.match(/w="(\d+)"/)?.[1]),
      lineDash: lineDashMatch?.[1] as PptxStyle['lineDash'],
      color: resolveColor(rPr, palette) || '000000',
      fontSize,
      fontFamily,
      bold,
      italic,
      underline,
      align: firstPPr.includes('algn="ctr"') ? 'center' : (firstPPr.includes('algn="r"') ? 'right' : (firstPPr.includes('algn="just"') ? 'justify' : 'left')),
      valign: body.includes('anchor="ctr"') ? 'middle' : (body.includes('anchor="b"') ? 'bottom' : 'top'),
      rotate: rotate !== 0 ? rotate : undefined,
      shadow,
      cornerRadius,
      lineSpacing: lineSpacingMatch ? parseInt(lineSpacingMatch[1]) / 1000 : undefined,
      spaceBefore: spaceBeforeMatch ? parseInt(spaceBeforeMatch[1]) / 100 : undefined,
      spaceAfter: spaceAfterMatch ? parseInt(spaceAfterMatch[1]) / 100 : undefined,
      bullet,
    };

    if (type === 'line') {
      if (lnXml?.includes('headEnd type="') && !lnXml.includes('type="none"')) style.headArrow = true;
      if (lnXml?.includes('tailEnd type="') && !lnXml.includes('type="none"')) style.tailArrow = true;
    }

    // Extract autofit and textColumns from <a:bodyPr>
    let autofit: PptxElement['autofit'] = undefined;
    let textColumns: PptxElement['textColumns'] = undefined;
    const bodyPrStr = bodyPrMatch ? bodyPrMatch[0] : '';
    if (bodyPrStr.includes('<a:normAutofit')) autofit = 'normal';
    else if (bodyPrStr.includes('<a:spAutoFit')) autofit = 'shrink';
    else if (bodyPrStr.includes('<a:noAutofit')) autofit = 'none';
    const numColMatch = bodyPrStr.match(/numCol="(\d+)"/);
    if (numColMatch) textColumns = parseInt(numColMatch[1]);

    // Extract custom geometry from spPr
    let custGeomXml: string | undefined;
    if (!spPr.includes('<a:prstGeom') || prstGeom === 'rect') {
      const custGeomMatch = spPr.match(/<a:custGeom>[\s\S]*?<\/a:custGeom>/);
      if (custGeomMatch) custGeomXml = custGeomMatch[0];
    }

    // Extract image crop (srcRect) from blipFill
    let crop: PptxElement['crop'] = undefined;
    if (blipFillMatch) {
      const srcRectMatch = blipFillMatch[0].match(/<a:srcRect([^>]*)\/>/);
      if (srcRectMatch) {
        const attrs = srcRectMatch[1];
        const l = attrs.match(/l="(\d+)"/);
        const t = attrs.match(/t="(\d+)"/);
        const r = attrs.match(/r="(\d+)"/);
        const b = attrs.match(/b="(\d+)"/);
        if (l || t || r || b) {
          crop = {
            left: l ? parseInt(l[1]) : undefined,
            top: t ? parseInt(t[1]) : undefined,
            right: r ? parseInt(r[1]) : undefined,
            bottom: b ? parseInt(b[1]) : undefined,
          };
        }
      }
    }

    const el: PptxElement = {
      type,
      pos: { x, y, w: cx, h: cy },
      text: fullText,
      textRuns: textRuns.length > 0 ? textRuns : undefined,
      style,
      shapeType: prstGeom,
      placeholderType: placeholderType as any,
      name: isPageNum ? 'SLIDE_NUMBER' : undefined,
      autofit,
      textColumns,
      crop,
      custGeomXml,
      cNvPrXml: cNvPrMatch ? cNvPrMatch[0] : undefined,
      cNvSpPrXml: cNvSpPrMatch ? cNvSpPrMatch[0] : undefined,
      cNvCxnSpPrXml: cNvCxnSpPrMatch ? cNvCxnSpPrMatch[0] : undefined,
      blipFillXml: blipFillMatch ? blipFillMatch[0] : undefined,
      nvPrXml: nvPrMatch ? nvPrMatch[0] : undefined,
      extensions: extLstMatch ? extLstMatch[0] : undefined,
      altText: descrMatch ? descrMatch[1] : undefined,
      linkTarget: linkTarget,
      spPrXml: spPrMatch ? spPrMatch[0] : undefined,
      styleXml: styleMatch ? styleMatch[0] : undefined,
      bodyPrXml: bodyPrMatch ? bodyPrMatch[0] : undefined,
      lstStyleXml: lstStyleMatch ? lstStyleMatch[0] : undefined,
      pXmlLst: pXmlLst.length > 0 ? pXmlLst : undefined
    };

    if (type === 'image') {
      const rId = body.match(/r:embed="([^"]*)"/)?.[1];
      if (rId && rels[rId]) {
        el.imagePath = assetsDir ? path.join(assetsDir, path.basename(rels[rId].target)) : rels[rId].target;
        // Embed image data as base64 for lossless round-trip
        const relTarget = rels[rId].target;
        const mediaPath = path.posix.join(path.posix.dirname(relsFile.replace('_rels/', '').replace('.rels', '')), relTarget).replace(/^\//, '');
        const mediaEntry = zip.getEntry(mediaPath);
        if (mediaEntry) {
          el.imageData = mediaEntry.getData().toString('base64');
        }
      }
    }

    if (type === 'smartart') {
      const dmId = body.match(/<d:relIds[^>]*r:dm="([^"]*)"/)?.[1];
      const loId = body.match(/<d:relIds[^>]*r:lo="([^"]*)"/)?.[1];
      const qsId = body.match(/<d:relIds[^>]*r:qs="([^"]*)"/)?.[1];
      const csId = body.match(/<d:relIds[^>]*r:cs="([^"]*)"/)?.[1];

      const readTarget = (rId?: string) => {
        if (!rId || !rels[rId]) return undefined;
        // The target is usually like '../diagrams/data1.xml'
        // We resolve it relative to the part directory (e.g. ppt/slides) -> ppt/diagrams/data1.xml
        const targetPath = path.posix.join(path.dirname(relsFile).replace('_rels', ''), rels[rId].target).replace(/^\//, '');
        return zip.getEntry(targetPath)?.getData().toString('utf8');
      };

      el.smartArtData = {
        dataXml: readTarget(dmId),
        layoutXml: readTarget(loId),
        colorsXml: readTarget(csId),
        quickStyleXml: readTarget(qsId),
        rels: {}
      };

      // Also grab relations from data1.xml (e.g. images inside SmartArt)
      if (dmId && rels[dmId]) {
        const dataPath = path.posix.join(path.dirname(relsFile).replace('_rels', ''), rels[dmId].target).replace(/^\//, '');
        const dataRelsEntry = zip.getEntry(`${path.dirname(dataPath)}/_rels/${path.basename(dataPath)}.rels`);
        if (dataRelsEntry) {
          const dataRelsXml = dataRelsEntry.getData().toString('utf8');
          const relRegex = /<Relationship[^>]*Id="([^"]*)"[^>]*Type="([^"]*)"[^>]*Target="([^"]*)"/g;
          let rMatch;
          while ((rMatch = relRegex.exec(dataRelsXml)) !== null) {
            el.smartArtData!.rels![rMatch[1]] = { type: rMatch[2], target: rMatch[3] };
          }
        }
      }
    }

    if (type === 'chart') {
      const chartIdMatch = body.match(/<c:chart[^>]*r:id="([^"]*)"/);
      if (chartIdMatch && rels[chartIdMatch[1]]) {
        const rId = chartIdMatch[1];
        const chartPath = path.posix.join(path.dirname(relsFile).replace('_rels', ''), rels[rId].target).replace(/^\//, '');
        const chartXml = zip.getEntry(chartPath)?.getData().toString('utf8');
        
        el.chartData = {
          chartXml,
          rels: {}
        };

        const chartRelsEntry = zip.getEntry(`${path.dirname(chartPath)}/_rels/${path.basename(chartPath)}.rels`);
        if (chartRelsEntry) {
          const chartRelsXml = chartRelsEntry.getData().toString('utf8');
          const relRegex = /<Relationship[^>]*Id="([^"]*)"[^>]*Type="([^"]*)"[^>]*Target="([^"]*)"/g;
          let rMatch;
          while ((rMatch = relRegex.exec(chartRelsXml)) !== null) {
            el.chartData!.rels![rMatch[1]] = { type: rMatch[2], target: rMatch[3] };
            if (rMatch[2].includes('package') || rMatch[2].includes('oleObject')) {
               // Extract embedded Excel file
               const embedPath = path.posix.join(path.dirname(chartPath), rMatch[3]).replace(/^\//, '');
               const embedEntry = zip.getEntry(embedPath);
               if (embedEntry) {
                 el.chartData!.workbookBlob = embedEntry.getData().toString('base64');
                 el.chartData!.workbookTarget = rMatch[3];
               }
            }
          }
        }
      }
    }

    if (type === 'table') {
      const rows: string[][] = [];
      const colWidths: number[] = [];
      
      const gridMatch = body.match(/<a:tblGrid>([\s\S]*?)<\/a:tblGrid>/);
      if (gridMatch) {
        const colRegex = /<a:gridCol[^>]*w="(\d+)"/g;
        let cMatch;
        while ((cMatch = colRegex.exec(gridMatch[1])) !== null) {
          colWidths.push(emuToIn(cMatch[1]));
        }
      }

      const trRegex = /<a:tr[^>]*>([\s\S]*?)<\/a:tr>/g;
      let trMatch;
      while ((trMatch = trRegex.exec(body)) !== null) {
        const row: string[] = [];
        const tcRegex = /<a:tc[^>]*>([\s\S]*?)<\/a:tc>/g;
        let tcMatch;
        while ((tcMatch = tcRegex.exec(trMatch[1])) !== null) {
          const cellText = (tcMatch[1].match(/<a:t>([^<]*)<\/a:t>/g) || [])
            .map(t => t.replace(/<\/?a:t>/g, '')).join(' ');
          row.push(cellText);
        }
        rows.push(row);
      }
      el.rows = rows;
      if (colWidths.length > 0) el.colWidths = colWidths;
      el.rawXml = block; // Store raw table XML
    }

    elements.push(el);
  }
  return elements;
}

export async function distillPptxDesign(sourcePath: string, extractAssetsDir?: string): Promise<PptxDesignProtocol> {
  const zip = new AdmZip(sourcePath);
  const palette: { [key: string]: string } = {};
  extractTheme(zip, palette);

  // Capture raw theme XML for faithful round-trip
  const themeEntry = zip.getEntry('ppt/theme/theme1.xml');
  const rawThemeXml = themeEntry?.getData().toString('utf8');

  const presEntry = zip.getEntry('ppt/presentation.xml');
  const presXml = presEntry?.getData().toString('utf8') || '';
  const sldSz = presXml.match(/<p:sldSz cx="(\d+)" cy="(\d+)"\/>/);
  const canvas = { w: emuToIn(sldSz?.[1]), h: emuToIn(sldSz?.[2]) || 7.5 };
  const presExtMatch = presXml.match(/<p:extLst>[\s\S]*?<\/p:extLst>/);

  const masterEntry = zip.getEntry('ppt/slideMasters/slideMaster1.xml');
  const masterXml = masterEntry?.getData().toString('utf8') || '';
  const masterExtMatch = masterXml.match(/<p:extLst>[\s\S]*?<\/p:extLst>/);
  const masterBgMatch = masterXml.match(/<p:bg>[\s\S]*?<\/p:bg>/);
  const masterClrMapMatch = masterXml.match(/<p:clrMap[^>]*\/>/);
  const masterTxStylesMatch = masterXml.match(/<p:txStyles>[\s\S]*?<\/p:txStyles>/);

  // Capture raw master XML and rels for passthrough
  const rawMasterXml = masterXml || undefined;
  const masterRelsEntry = zip.getEntry('ppt/slideMasters/_rels/slideMaster1.xml.rels');
  const rawMasterRelsXml = masterRelsEntry?.getData().toString('utf8');

  // Capture ALL slide masters (multi-master support)
  const rawMasters: PptxMasterRaw[] = [];
  const masterEntries = zip.getEntries().filter(e => e.entryName.match(/^ppt\/slideMasters\/slideMaster\d+\.xml$/));
  masterEntries.sort((a, b) => parseInt(a.entryName.match(/\d+/)?.[0] || '0') - parseInt(b.entryName.match(/\d+/)?.[0] || '0'));
  for (const me of masterEntries) {
    const num = parseInt(me.entryName.match(/\d+/)?.[0] || '0');
    const mXml = me.getData().toString('utf8');
    const mRelsEntry = zip.getEntry(`ppt/slideMasters/_rels/slideMaster${num}.xml.rels`);
    const mRelsXml = mRelsEntry?.getData().toString('utf8');
    // Find associated theme from rels
    let themeXml: string | undefined;
    if (mRelsXml) {
      const themeRelMatch = mRelsXml.match(/Target="([^"]*theme\d*\.xml)"/);
      if (themeRelMatch) {
        const themePath = path.posix.join('ppt/slideMasters', themeRelMatch[1]).replace(/^\//, '');
        const tEntry = zip.getEntry(themePath);
        if (tEntry) themeXml = tEntry.getData().toString('utf8');
      }
    }
    rawMasters.push({ xml: mXml, relsXml: mRelsXml, themeXml });
  }

  const extractedMaster = extractObjects(zip, masterXml, palette, 'ppt/slideMasters/_rels/slideMaster1.xml.rels', extractAssetsDir);
  const masterOnlyCount = extractedMaster.length;

  // Capture raw layouts and merge placeholder elements
  const rawLayouts: PptxLayoutRaw[] = [];
  const layoutEntries = zip.getEntries().filter(e => e.entryName.startsWith('ppt/slideLayouts/slideLayout') && e.entryName.endsWith('.xml'));
  layoutEntries.sort((a, b) => parseInt(a.entryName.match(/\d+/)?.[0] || '0') - parseInt(b.entryName.match(/\d+/)?.[0] || '0'));
  layoutEntries.forEach(layout => {
    const layoutXml = layout.getData().toString('utf8');
    const layoutBaseName = path.basename(layout.entryName);
    const layoutRelsEntry = zip.getEntry(`ppt/slideLayouts/_rels/${layoutBaseName}.rels`);
    const nameMatch = layoutXml.match(/name="([^"]*)"/);
    const typeMatch = layoutXml.match(/type="([^"]*)"/);

    rawLayouts.push({
      name: nameMatch?.[1] || layoutBaseName,
      type: typeMatch?.[1],
      xml: layoutXml,
      relsXml: layoutRelsEntry?.getData().toString('utf8'),
    });

    const layoutElements = extractObjects(zip, layoutXml, palette, `ppt/slideLayouts/_rels/${layoutBaseName}.rels`, extractAssetsDir);
    layoutElements.forEach(el => {
      if (el.placeholderType && !extractedMaster.some(m => m.placeholderType === el.placeholderType)) {
        extractedMaster.push(el);
      }
    });
  });

  // Collect media files referenced by master and layout rels
  const masterMedia: PptxMasterMedia[] = [];
  const mediaCollected = new Set<string>();
  function collectMediaFromRels(relsXml: string | undefined, basePath: string) {
    if (!relsXml) return;
    const imageRelRegex = /Target="([^"]*\.(png|jpg|jpeg|gif|svg|emf|wmf|tif|tiff))"/gi;
    let m;
    while ((m = imageRelRegex.exec(relsXml)) !== null) {
      const resolved = path.posix.join(basePath, m[1]).replace(/^\//, '');
      if (mediaCollected.has(resolved)) continue;
      mediaCollected.add(resolved);
      const mediaEntry = zip.getEntry(resolved);
      if (mediaEntry) {
        masterMedia.push({
          fileName: path.basename(resolved),
          data: mediaEntry.getData().toString('base64'),
        });
      }
    }
  }
  rawMasters.forEach(m => collectMediaFromRels(m.relsXml, 'ppt/slideMasters'));
  rawLayouts.forEach(l => collectMediaFromRels(l.relsXml, 'ppt/slideLayouts'));

  // Capture all non-slide ZIP entries as rawParts for faithful round-trip
  const rawParts: { [entryName: string]: string } = {};
  const slideXmlPattern = /^ppt\/slides\/slide\d+\.xml$/;
  const slideRelsPattern = /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/;
  for (const entry of zip.getEntries()) {
    const name = entry.entryName;
    // Skip slide XMLs and their rels (those go into PptxSlide), and directories
    if (slideXmlPattern.test(name) || slideRelsPattern.test(name)) continue;
    if (entry.isDirectory) continue;
    rawParts[name] = entry.getData().toString('base64');
  }

  const protocol: PptxDesignProtocol = {
    version: '3.0.0',
    generatedAt: new Date().toISOString(),
    canvas,
    theme: palette,
    extensions: presExtMatch ? presExtMatch[0] : undefined,
    master: {
      elements: extractedMaster,
      masterOnlyCount,
      extensions: masterExtMatch ? masterExtMatch[0] : undefined,
      bgXml: masterBgMatch ? masterBgMatch[0] : undefined,
      clrMapXml: masterClrMapMatch ? masterClrMapMatch[0] : undefined,
      txStylesXml: masterTxStylesMatch ? masterTxStylesMatch[0] : undefined,
    },
    slides: [],
    rawThemeXml,
    rawMasterXml,
    rawMasterRelsXml,
    rawLayouts: rawLayouts.length > 0 ? rawLayouts : undefined,
    rawMasters: rawMasters.length > 0 ? rawMasters : undefined,
    masterMedia: masterMedia.length > 0 ? masterMedia : undefined,
    rawParts,
  };

  const slideEntries = zip.getEntries().filter(e => e.entryName.startsWith('ppt/slides/slide') && e.entryName.endsWith('.xml'));
  slideEntries.sort((a, b) => parseInt(a.entryName.match(/\d+/)?.[0] || '0') - parseInt(b.entryName.match(/\d+/)?.[0] || '0'));

  for (const entry of slideEntries) {
    const slideName = path.basename(entry.entryName);
    const slideXml = entry.getData().toString('utf8');
    const slideExtMatch = slideXml.match(/<p:extLst>[\s\S]*?<\/p:extLst>/);
    const bgMatch = slideXml.match(/<p:bg>[\s\S]*?<\/p:bg>/);
    const transitionMatch = slideXml.match(/<p:transition[^>]*>([\s\S]*?<\/p:transition>)?/);

    const relsEntry = zip.getEntry(`ppt/slides/_rels/${slideName}.rels`);
    let notesXml: string | undefined = undefined;
    let layoutIndex: number | undefined = undefined;

    if (relsEntry) {
      const relsXml = relsEntry.getData().toString('utf8');
      relsXml.replace(/Id="([^"]*)"[^>]*Target="([^"]*)"/g, (_, _id, target) => {
        if (target.includes('notesSlide')) {
          const notesPath = path.posix.join('ppt/slides', target).replace(/^\//, '');
          const nEntry = zip.getEntry(notesPath);
          if (nEntry) notesXml = nEntry.getData().toString('utf8');
        }
        return '';
      });
      const layoutRelMatch = relsXml.match(/Target="[^"]*slideLayout(\d+)\.xml"/);
      if (layoutRelMatch) layoutIndex = parseInt(layoutRelMatch[1]);
    }

    protocol.slides.push({
      id: slideName,
      elements: extractObjects(zip, slideXml, palette, `ppt/slides/_rels/${slideName}.rels`, extractAssetsDir),
      extensions: slideExtMatch ? slideExtMatch[0] : undefined,
      bgXml: bgMatch ? bgMatch[0] : undefined,
      transitionXml: transitionMatch ? transitionMatch[0] : undefined,
      notesXml,
      layoutIndex,
      rawSlideXml: slideXml,
      rawSlideRelsXml: relsEntry?.getData().toString('utf8'),
    });
  }

  if (extractAssetsDir) {
    if (!safeExistsSync(extractAssetsDir)) safeMkdir(extractAssetsDir, { recursive: true });
    zip.getEntries().filter(e => e.entryName.startsWith('ppt/media/')).forEach(m => {
      safeWriteFile(path.join(extractAssetsDir, path.basename(m.entryName)), m.getData());
    });
  }

  return protocol;
}

export { generateNativePptx as generatePptxWithDesign };
