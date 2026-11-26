/** Lowest value allowed for a sldMasterId / sldLayoutId (ST_SlideMasterId). */
const MIN_MASTER_OR_LAYOUT_ID = 2147483648;

/** Collect every `<p:sldLayoutId id="…">` value declared in the given master XMLs. */
export function collectSldLayoutIds(masterXmls: Array<string | undefined>): number[] {
  const ids: number[] = [];
  for (const xml of masterXmls) {
    if (!xml) continue;
    for (const m of xml.matchAll(/<p:sldLayoutId\b[^>]*?\bid="(\d+)"/g)) ids.push(Number(m[1]));
  }
  return ids;
}

/**
 * sldMasterId and sldLayoutId values share one ID space and must be unique
 * across the package; PowerPoint offers to "repair" a file where they collide.
 * Allocate `count` master IDs (above 2147483648, the ST_SlideMasterId floor)
 * that avoid every reserved ID.
 */
export function allocateMasterIds(count: number, reservedIds: Iterable<number> = []): number[] {
  const taken = new Set(reservedIds);
  const ids: number[] = [];
  let candidate = MIN_MASTER_OR_LAYOUT_ID + 1;
  while (ids.length < count) {
    if (!taken.has(candidate)) {
      ids.push(candidate);
      taken.add(candidate);
    }
    candidate++;
  }
  return ids;
}

export function generatePresentation(
  slideCount: number,
  masterCount: number,
  widthEmu: number = 12192000,
  heightEmu: number = 6858000,
  extensions?: string,
  hasNotesMaster = false,
  reservedIds: Iterable<number> = []
): string {
  const masterIds = allocateMasterIds(masterCount, reservedIds);
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst>`;

  let rId = 1; // Slide masters come first (rId1+)
  for (const masterId of masterIds) {
    xml += `\n    <p:sldMasterId id="${masterId}" r:id="rId${rId++}"/>`;
  }

  xml += `\n  </p:sldMasterIdLst>`;
  if (hasNotesMaster) {
    // Matches generatePresentationRels: masters, slides, presProps, viewProps,
    // theme, tableStyles, then the notes master.
    xml += `\n  <p:notesMasterIdLst><p:notesMasterId r:id="rId${masterCount + slideCount + 5}"/></p:notesMasterIdLst>`;
  }
  xml += `
  <p:sldIdLst>`;

  // Slides follow after masters
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
