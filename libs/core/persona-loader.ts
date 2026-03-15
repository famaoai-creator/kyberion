import { safeExistsSync, safeReadFile } from './secure-io.js';

/**
 * Persona Loader Utility
 * Extracts role definitions from knowledge/personalities/matrix.md
 */
export const personaLoader = {
  loadPersonas: (matrixPath: string) => {
    if (!safeExistsSync(matrixPath)) return {};
    const content = safeReadFile(matrixPath, { encoding: 'utf8' }) as string;
    const personas: Record<string, any> = {};

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

        personas[name] = {
          role: roleLine ? roleLine.replace('- **役割**:', '').trim() : '',
          viewpoint: viewpointLine ? viewpointLine.replace('- **視点**:', '').trim() : '',
          tone: toneLine ? toneLine.replace('- **口調**:', '').trim() : '',
        };
      }
    });

    return personas;
  },
};
