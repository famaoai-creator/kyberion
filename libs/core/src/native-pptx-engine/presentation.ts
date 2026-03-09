export function generatePresentation(slideCount: number, masterCount: number, widthEmu: number = 12192000, heightEmu: number = 6858000, extensions?: string): string {
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst>`;
  
  let rId = slideCount + 1; // Slide masters start after slides in presentation.xml.rels
  for (let i = 1; i <= masterCount; i++) {
    xml += `\n    <p:sldMasterId id="${2147483648 + i}" r:id="rId${rId++}"/>`;
  }
  
  xml += `\n  </p:sldMasterIdLst>
  <p:sldIdLst>`;
  
  rId = 1; // Slides start at rId1
  for (let i = 1; i <= slideCount; i++) {
    xml += `\n    <p:sldId id="${255 + i}" r:id="rId${rId++}"/>`;
  }
  
  xml += `\n  </p:sldIdLst>
  <p:sldSz cx="${widthEmu}" cy="${heightEmu}"/>
  <p:notesSz cx="6858000" cy="9144000"/>
  <p:defaultTextStyle>
    <a:defPPr>
      <a:defRPr lang="en-US"/>
    </a:defPPr>
  </p:defaultTextStyle>
  ${extensions || ''}
</p:presentation>`;
  
  return xml;
}
