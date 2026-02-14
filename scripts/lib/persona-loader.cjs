const fs = require('fs');
const _path = require('path');

/**
 * Persona Loader Utility
 * Extracts role definitions from knowledge/personalities/matrix.md
 */
const personaLoader = {
  loadPersonas: (matrixPath) => {
    if (!fs.existsSync(matrixPath)) return {};
    const content = fs.readFileSync(matrixPath, 'utf8');
    const personas = {};
    
    // Simple parser for Markdown H2 headers and bullets
    const sections = content.split(/^## /m);
    sections.forEach(section => {
      const lines = section.split('\n');
      const titleLine = lines[0];
      const nameMatch = titleLine.match(/^\d+\.\s+(.+?)\s+\(/) || titleLine.match(/^\d+\.\s+(.+)/);
      
      if (nameMatch) {
        const name = nameMatch[1].trim();
        const roleLine = lines.find(l => l.includes('- **役割**'));
        const viewpointLine = lines.find(l => l.includes('- **視点**'));
        const toneLine = lines.find(l => l.includes('- **口調**'));
        
        personas[name] = {
          role: roleLine ? roleLine.replace('- **役割**:', '').trim() : '',
          viewpoint: viewpointLine ? viewpointLine.replace('- **視点**:', '').trim() : '',
          tone: toneLine ? toneLine.replace('- **口調**:', '').trim() : ''
        };
      }
    });
    
    return personas;
  }
};

module.exports = personaLoader;
