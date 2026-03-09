export function generateContentTypes(slideCount: number, layoutCount: number, masterCount: number, imageCount: number): string {
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>
  <Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>`;

  for (let i = 1; i <= masterCount; i++) {
    xml += `\n  <Override PartName="/ppt/slideMasters/slideMaster${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>`;
  }
  for (let i = 1; i <= layoutCount; i++) {
    xml += `\n  <Override PartName="/ppt/slideLayouts/slideLayout${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>`;
  }
  for (let i = 1; i <= slideCount; i++) {
    xml += `\n  <Override PartName="/ppt/slides/slide${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`;
  }

  // Support for up to 100 SmartArt diagrams
  for (let i = 1; i <= 100; i++) {
    xml += `\n  <Override PartName="/ppt/diagrams/data${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml"/>`;
    xml += `\n  <Override PartName="/ppt/diagrams/layout${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.diagramLayout+xml"/>`;
    xml += `\n  <Override PartName="/ppt/diagrams/colors${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.diagramColors+xml"/>`;
    xml += `\n  <Override PartName="/ppt/diagrams/quickStyle${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.diagramStyle+xml"/>`;
  }
  
  xml += `\n</Types>`;
  return xml;
}
