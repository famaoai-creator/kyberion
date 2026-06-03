import { safeExistsSync, safeReadFile } from './secure-io.js';

/**
 * Perspective Loader
 *
 * Extracts the 27 thinking-style Perspectives from knowledge/product/personalities/matrix.md.
 * These are NOT the same as the Persona type (execution identity, 6 values in types.ts).
 * A Perspective describes how an AI should frame a response; a Persona controls what it can access.
 */
export interface PerspectiveDefinition {
  role: string;
  viewpoint: string;
  tone: string;
}

export const personaLoader = {
  /** @deprecated Use loadPerspectives() */
  loadPersonas: (matrixPath: string): Record<string, PerspectiveDefinition> =>
    loadPerspectives(matrixPath),
};

export function loadPerspectives(matrixPath: string): Record<string, PerspectiveDefinition> {
  if (!safeExistsSync(matrixPath)) return {};
  const content = safeReadFile(matrixPath, { encoding: 'utf8' }) as string;
  const perspectives: Record<string, PerspectiveDefinition> = {};

  const sections = content.split(/^## /m);
  sections.forEach((section) => {
    const lines = section.split('\n');
    const titleLine = lines[0];
    const nameMatch = titleLine.match(/^\d+\.\s+(.+?)\s+\(/) || titleLine.match(/^\d+\.\s+(.+)/);

    if (nameMatch) {
      const name = nameMatch[1].trim();
      const roleLine = lines.find((l) => l.includes('- **役割**'));
      const viewpointLine = lines.find((l) => l.includes('- **視点**'));
      const toneLine = lines.find((l) => l.includes('- **口調**'));

      perspectives[name] = {
        role: roleLine ? roleLine.replace('- **役割**:', '').trim() : '',
        viewpoint: viewpointLine ? viewpointLine.replace('- **視点**:', '').trim() : '',
        tone: toneLine ? toneLine.replace('- **口調**:', '').trim() : '',
      };
    }
  });

  return perspectives;
}
