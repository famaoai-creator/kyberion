export function generateGlobalRels(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

export function generatePresentationRels(slideCount: number, masterCount: number): string {
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`;
  let rId = 1;
  for (let i = 1; i <= slideCount; i++) {
    xml += `\n  <Relationship Id="rId${rId++}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i}.xml"/>`;
  }
  for (let i = 1; i <= masterCount; i++) {
    xml += `\n  <Relationship Id="rId${rId++}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster${i}.xml"/>`;
  }
  xml += `\n  <Relationship Id="rId${rId++}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps" Target="presProps.xml"/>`;
  xml += `\n  <Relationship Id="rId${rId++}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps" Target="viewProps.xml"/>`;
  xml += `\n  <Relationship Id="rId${rId++}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>`;
  xml += `\n  <Relationship Id="rId${rId++}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles" Target="tableStyles.xml"/>`;
  xml += `\n</Relationships>`;
  return xml;
}

export function generateSlideRels(layoutId: number, extras: { id: string, type: string, target: string }[] = []): string {
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout${layoutId}.xml"/>`;
  
  extras.forEach(ext => {
    xml += `\n  <Relationship Id="${ext.id}" Type="${ext.type}" Target="${ext.target}"/>`;
  });
  
  xml += `\n</Relationships>`;
  return xml;
}

export function generateLayoutRels(masterId: number): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster${masterId}.xml"/>
</Relationships>`;
}

export function generateMasterRels(layoutCount: number): string {
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`;
  let rId = 1;
  for (let i = 1; i <= layoutCount; i++) {
    xml += `\n  <Relationship Id="rId${rId++}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout${i}.xml"/>`;
  }
  xml += `\n  <Relationship Id="rId${rId++}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>`;
  xml += `\n</Relationships>`;
  return xml;
}