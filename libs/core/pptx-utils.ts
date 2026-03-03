import AdmZip from 'adm-zip';
import * as fs from 'fs';
import * as path from 'path';
import PptxGenJS from 'pptxgenjs';
import { PptxDesignProtocol, PptxElement, PptxPos, PptxStyle } from './types/pptx-protocol';

function emuToIn(emu: string | undefined | null): number {
  return emu ? parseFloat((parseInt(emu) / 914400).toFixed(3)) : 0;
}

function emuToPt(emu: string | undefined | null): number {
  return emu ? parseFloat((parseInt(emu) / 12700).toFixed(1)) : 1;
}

function extractTheme(zip: AdmZip, palette: { [key: string]: string }) {
  const themeEntry = zip.getEntry('ppt/theme/theme1.xml');
  if (!themeEntry) return;
  const themeXml = themeEntry.getData().toString('utf8');
  const tags = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'];
  tags.forEach(tag => {
    const match = themeXml.match(new RegExp(`<a:${tag}>.*?val="([0-9A-F]{6})".*?<\/a:${tag}>`, 's'));
    if (match) palette[tag] = match[1];
  });
  palette['bg1'] = palette['lt1'] || 'FFFFFF';
  palette['bg2'] = palette['lt2'] || 'D5D5D5';
}

function resolveColor(xml: string | undefined, palette: { [key: string]: string }): string | undefined {
  if (!xml || xml.includes('<a:noFill')) return undefined;
  const srgb = xml.match(/val="([0-9A-F]{6})"/);
  if (srgb) return srgb[1];
  const scheme = xml.match(/<a:schemeClr val="([^"]*)"/);
  if (scheme && palette[scheme[1]]) return palette[scheme[1]];
  return undefined;
}

function resolveRelPath(zip: AdmZip, relsFile: string, rId: string): string | undefined {
  const entry = zip.getEntry(relsFile);
  if (!entry) return undefined;
  const xml = entry.getData().toString('utf8');
  const match = xml.match(new RegExp(`Id="${rId}"[^>]*Target="\.\.\/media\/([^"]*)"`));
  return match ? match[1] : undefined;
}

function findInheritedBackground(zip: AdmZip, slideName: string): string | undefined {
  const slideEntry = zip.getEntry(`ppt/slides/${slideName}`);
  if (!slideEntry) return undefined;
  const slideXml = slideEntry.getData().toString('utf8');
  const slideRId = slideXml.match(/<a:blip r:embed="([^"]*)"/)?.[1];
  if (slideRId) return resolveRelPath(zip, `ppt/slides/_rels/${slideName}.rels`, slideRId);

  const slideRelsEntry = zip.getEntry(`ppt/slides/_rels/${slideName}.rels`);
  if (!slideRelsEntry) return undefined;
  const slideRels = slideRelsEntry.getData().toString('utf8');
  const layoutMatch = slideRels.match(/slideLayouts\/(slideLayout\d+\.xml)/);
  if (layoutMatch) {
    const layoutName = layoutMatch[1];
    const layoutXml = zip.getEntry(`ppt/slideLayouts/${layoutName}`)?.getData().toString('utf8');
    if (!layoutXml) return undefined;
    const layoutRId = layoutXml.match(/<a:blip r:embed="([^"]*)"/)?.[1];
    if (layoutRId) return resolveRelPath(zip, `ppt/slideLayouts/_rels/${layoutName}.rels`, layoutRId);

    const layoutRels = zip.getEntry(`ppt/slideLayouts/_rels/${layoutName}.rels`)?.getData().toString('utf8');
    if (!layoutRels) return undefined;
    const masterMatch = layoutRels.match(/slideMasters\/(slideMaster\d+\.xml)/);
    if (masterMatch) {
      const masterName = masterMatch[1];
      const masterXml = zip.getEntry(`ppt/slideMasters/${masterName}`)?.getData().toString('utf8');
      if (!masterXml) return undefined;
      const masterRId = masterXml.match(/<a:blip r:embed="([^"]*)"/)?.[1];
      if (masterRId) return resolveRelPath(zip, `ppt/slideMasters/_rels/${masterName}.rels`, masterRId);
    }
  }
  return undefined;
}

function extractObjects(xml: string, palette: { [key: string]: string }, rels: { [key: string]: string } = {}): PptxElement[] {
  const elements: PptxElement[] = [];
  const objectRegex = /<(p:sp|p:cxnSp|p:pic)>([\s\S]*?)<\/\1>/g;
  let match;
  while ((match = objectRegex.exec(xml)) !== null) {
    const typeTag = match[1];
    const body = match[2];
    const x = emuToIn(body.match(/<a:off x="(\d+)"/)?.[1]);
    const y = emuToIn(body.match(/<a:off.*?y="(\d+)"/)?.[1]);
    const cx = emuToIn(body.match(/<a:ext cx="(\d+)"/)?.[1]);
    const cy = emuToIn(body.match(/<a:ext.*?cy="(\d+)"/)?.[1]);
    const textNodes = body.match(/<a:t>([^<]*)<\/a:t>/g) || [];
    const text = textNodes.map(t => t.replace(/<[^>]*>/g, '')).join(' ').trim();

    const spPr = body.match(/<p:spPr>([\s\S]*?)<\/p:spPr>/)?.[1] || '';
    const fillMatch = spPr.match(/<a:solidFill>([\s\S]*?)<\/a:solidFill>/);
    const lnXml = spPr.match(/<a:ln[^>]*>([\s\S]*?)<\/a:ln>/)?.[0];
    
    const bodyPr = body.match(/<a:bodyPr([\s\S]*?)\/?>/)?.[1] || '';
    const anchorMatch = bodyPr.match(/anchor="([^"]*)"/)?.[1];
    const anchor = anchorMatch === 'ctr' ? 'middle' : (anchorMatch === 'b' ? 'bottom' : 'top');

    const type: 'shape' | 'text' | 'line' | 'image' = typeTag === 'p:cxnSp' ? 'line' : (typeTag === 'p:pic' ? 'image' : (text ? 'text' : 'shape'));

    const style: PptxStyle = {
      fill: resolveColor(fillMatch?.[0], palette),
      line: resolveColor(lnXml, palette),
      lineWidth: emuToPt(lnXml?.match(/w="(\d+)"/)?.[1]),
      color: resolveColor(body.match(/<a:rPr[^>]*>([\s\S]*?)<\/a:rPr>/)?.[0], palette) || '000000',
      fontSize: parseFloat(body.match(/sz="(\d+)"/)?.[1] || '1800') / 100,
      align: body.includes('algn="ctr"') ? 'center' : (body.includes('algn="r"') ? 'right' : 'left'),
      valign: anchor
    };

    const headArrow = lnXml?.includes('headEnd type="') && !lnXml.includes('type="none"');
    const tailArrow = lnXml?.includes('tailEnd type="') && !lnXml.includes('type="none"');
    if (headArrow) style.headArrow = true;
    if (tailArrow) style.tailArrow = true;

    const el: PptxElement = {
      type,
      pos: { x, y, w: cx, h: cy },
      text: text,
      style
    };

    if (type === 'image') {
      const rId = body.match(/r:embed="([^"]*)"/)?.[1];
      if (rId && rels[rId]) el.imagePath = rels[rId];
    }
    elements.push(el);
  }
  return elements;
}

/**
 * Distills a PPTX file into a portable Design Protocol (ADF)
 */
export async function distillPptxDesign(sourcePath: string, extractAssetsDir?: string): Promise<PptxDesignProtocol> {
  const zip = new AdmZip(sourcePath);
  const palette: { [key: string]: string } = {};
  extractTheme(zip, palette);

  const presEntry = zip.getEntry('ppt/presentation.xml');
  if (!presEntry) throw new Error('Invalid PPTX: Missing presentation.xml');
  const presXml = presEntry.getData().toString('utf8');
  const sldSz = presXml.match(/<p:sldSz cx="(\d+)" cy="(\d+)"\/>/);
  const canvas = { w: emuToIn(sldSz?.[1]), h: emuToIn(sldSz?.[2]) };

  const masterXmlEntry = zip.getEntry('ppt/slideMasters/slideMaster1.xml');
  let masterElements: PptxElement[] = [];
  if (masterXmlEntry) {
    const masterXml = masterXmlEntry.getData().toString('utf8');
    const masterRels: { [key: string]: string } = {};
    const masterRelsEntry = zip.getEntry('ppt/slideMasters/_rels/slideMaster1.xml.rels');
    if (masterRelsEntry) {
      masterRelsEntry.getData().toString('utf8').replace(/Id="([^"]*)"[^>]*Target="\.\.\/media\/([^"]*)"/g, (_, id, target) => {
        masterRels[id] = target;
        return '';
      });
    }
    masterElements = extractObjects(masterXml, palette, masterRels);
  }

  const protocol: PptxDesignProtocol = {
    version: '2.0.0',
    generatedAt: new Date().toISOString(),
    canvas,
    theme: palette,
    master: { elements: masterElements },
    slides: []
  };

  const slideEntries = zip.getEntries().filter(e => e.entryName.startsWith('ppt/slides/slide') && e.entryName.endsWith('.xml'));
  slideEntries.sort((a, b) => parseInt(a.entryName.match(/\d+/)?.[0] || '0') - parseInt(b.entryName.match(/\d+/)?.[0] || '0'));

  for (const entry of slideEntries) {
    const slideName = path.basename(entry.entryName);
    const slideRels: { [key: string]: string } = {};
    const relsEntry = zip.getEntry(`ppt/slides/_rels/${slideName}.rels`);
    if (relsEntry) {
      relsEntry.getData().toString('utf8').replace(/Id="([^"]*)"[^>]*Target="\.\.\/media\/([^"]*)"/g, (_, id, target) => {
        slideRels[id] = target;
        return '';
      });
    }
    protocol.slides.push({
      id: slideName,
      background: findInheritedBackground(zip, slideName),
      elements: extractObjects(entry.getData().toString('utf8'), palette, slideRels)
    });
  }

  // Optionally extract media assets
  if (extractAssetsDir) {
    if (!fs.existsSync(extractAssetsDir)) fs.mkdirSync(extractAssetsDir, { recursive: true });
    const mediaEntries = zip.getEntries().filter(e => e.entryName.startsWith('ppt/media/'));
    for (const m of mediaEntries) {
      fs.writeFileSync(path.join(extractAssetsDir, path.basename(m.entryName)), m.getData());
    }
  }

  return protocol;
}

/**
 * Re-generates a PPTX from a Design Protocol (ADF)
 */
export async function generatePptxWithDesign(protocol: PptxDesignProtocol, assetsDir: string = './assets'): Promise<PptxGenJS> {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'EXTRACTED_SCALE', width: protocol.canvas.w, height: protocol.canvas.h });
  pptx.layout = 'EXTRACTED_SCALE';

  const masterObjects: any[] = [];
  for (const el of protocol.master.elements) {
    const pos = { x: el.pos.x, y: el.pos.y, w: el.pos.w, h: el.pos.h };
    if (el.type === 'image' && el.imagePath) {
      masterObjects.push({ image: { ...pos, path: path.join(assetsDir, path.basename(el.imagePath)) } });
    } else if (el.type === 'shape' && el.style?.fill) {
      masterObjects.push({ rect: { ...pos, fill: { color: el.style.fill } } });
    }
  }

  pptx.defineSlideMaster({
    title: "MASTER_SLIDE",
    objects: masterObjects
  });

  for (const slideDef of protocol.slides) {
    const slide = pptx.addSlide({ masterName: "MASTER_SLIDE" });

    if (slideDef.background) {
      const imgPath = path.join(assetsDir, path.basename(slideDef.background));
      if (fs.existsSync(imgPath)) {
        slide.addImage({ path: imgPath, x: 0, y: 0, w: protocol.canvas.w, h: protocol.canvas.h });
      }
    }

    for (const el of slideDef.elements) {
      const w = Math.max(el.pos.w, 0.01);
      const h = Math.max(el.pos.h, 0.01);
      const pos = { x: el.pos.x, y: el.pos.y, w, h };
      
      if (el.type === 'image' && el.imagePath) {
        const imgPath = path.join(assetsDir, path.basename(el.imagePath));
        if (fs.existsSync(imgPath)) slide.addImage({ ...pos, path: imgPath });
      } else if (el.type === 'line') {
        const lineProps: any = { color: el.style?.line || '000000', width: el.style?.lineWidth || 2 };
        if (el.style?.headArrow) lineProps.endArrowType = 'arrow';
        if (el.style?.tailArrow) lineProps.beginArrowType = 'arrow';
        slide.addShape(pptx.ShapeType.line, { ...pos, line: lineProps });
      } else {
        const options: any = {
          ...pos,
          fontSize: el.style?.fontSize || 18,
          color: el.style?.color || '000000',
          align: el.style?.align || 'left',
          valign: el.style?.valign || 'top',
        };
        if (el.style?.fill) options.fill = { color: el.style.fill };
        if (el.style?.line) options.line = { color: el.style.line, width: el.style?.lineWidth || 1 };

        if (el.type === 'text' && el.text) {
          slide.addText(el.text, options);
        } else if (el.type === 'shape') {
          if (el.text) slide.addText(el.text, options);
          else slide.addShape(pptx.ShapeType.rect, options);
        }
      }
    }
  }

  return pptx;
}
