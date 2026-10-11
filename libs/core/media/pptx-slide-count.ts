import AdmZip from 'adm-zip';

const PPTX_SLIDE_PART = /^ppt\/slides\/slide\d+\.xml$/;

/**
 * Slide count from a pptx container — used to stamp `slides_count` on
 * deck-kind artifact records so the deliverable-quality gate is satisfied
 * without callers hand-deriving it. Returns undefined when the buffer is not
 * a pptx zip or contains no slide parts.
 */
export function countPptxSlides(buffer: Buffer): number | undefined {
  try {
    const zip = new AdmZip(buffer);
    const count = zip
      .getEntries()
      .filter((entry) => !entry.isDirectory && PPTX_SLIDE_PART.test(entry.entryName)).length;
    return count > 0 ? count : undefined;
  } catch {
    return undefined;
  }
}
