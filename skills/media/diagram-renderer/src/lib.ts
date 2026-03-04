import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { safeReadFile, safeWriteFile, safeUnlinkSync } from '@agent/core/secure-io';
import * as pathResolver from '@agent/core/path-resolver';

export interface ADF {
  protocol: string;
  intent: string;
  engine?: 'mermaid' | 'd2' | 'salt' | 'html';
  theme?: string;
  elements: {
    diagram?: string;
    html_path?: string;
  };
  overrides?: any;
}

export interface IconMap {
  [key: string]: string;
}

/**
 * Loads designer knowledge for diagram rendering.
 */
export function loadDesignerKnowledge() {
  const rootDir = process.cwd();
  const getPath = (f: string) => path.join(rootDir, 'knowledge/skills/diagram-renderer', f);
  
  return {
    registry: JSON.parse(safeReadFile(getPath('theme-registry.json'), { encoding: 'utf8' }) as string),
    rules: JSON.parse(safeReadFile(getPath('design-rules.json'), { encoding: 'utf8' }) as string).rules,
    styles: JSON.parse(safeReadFile(getPath('design-styles.json'), { encoding: 'utf8' }) as string).styles,
    icons: JSON.parse(safeReadFile(getPath('icon-map.json'), { encoding: 'utf8' }) as string)
  };
}

/**
 * Applies professional designer styles to Mermaid content.
 */
export function applyDesignerStyle(mmd: string, adf: ADF, knowledge: any): string {
  const themeKey = adf.theme || 'base';
  const themeConfig = knowledge.registry.themes[themeKey] || knowledge.registry.themes.base;
  const overrides = adf.overrides || {};
  const styleRule = themeKey === 'dark' ? knowledge.styles.tech_dark : knowledge.styles.professional_base;
  
  const init = {
    theme: themeConfig.theme,
    themeVariables: { ...themeConfig.variables, ...(overrides.theme_variables || {}) },
    flowchart: { ...themeConfig.flowchart },
    gantt: { ...themeConfig.gantt },
    cssStyles: `${styleRule ? Object.values(styleRule).join(' ') : ''} ${overrides.custom_style || ''}`
  };
  
  return `%%{init: \${JSON.stringify(init)} }%%\n\${mmd}`;
}

/**
 * Converts ADF elements into Mermaid syntax (helper for external callers).
 */
export function adfToMermaid(adf: ADF): string {
  const knowledge = loadDesignerKnowledge();
  return applyDesignerStyle(adf.elements.diagram || '', adf, knowledge);
}

/**
 * Renders diagram based on the selected engine.
 */
export async function renderDiagram(adf: ADF, outputPath: string): Promise<any> {
  if (adf.protocol !== 'gemini-diagram-v1') throw new Error('Unsupported diagram protocol.');

  const knowledge = loadDesignerKnowledge();
  const rule = knowledge.rules[adf.intent] || {};
  const mergedAdf = { ...rule, ...adf };
  const engine = adf.engine || rule.type || 'mermaid';
  const diagramContent = (adf.elements.diagram || '').replace(/\\n/g, '\n');

  if (engine === 'mermaid') {
    const mmdPath = outputPath.replace(/\.[^.]+$/, '.mmd');
    const mmdWithStyle = applyDesignerStyle(diagramContent, mergedAdf, knowledge);
    safeWriteFile(mmdPath, mmdWithStyle);
    
    try {
      execSync(`npx -y @mermaid-js/mermaid-cli -i "${mmdPath}" -o "${outputPath}" --allow-local-files`, {
        stdio: 'pipe'
      });
      return { status: 'success', engine, finalArtifact: outputPath };
    } catch (err: any) {
      throw new Error(`Mermaid rendering failed: ${err.message}`);
    } finally {
      if (fs.existsSync(mmdPath)) safeUnlinkSync(mmdPath);
    }
  }

  // Other engines (D2, PlantUML) could be implemented here as needed
  throw new Error(`Engine ${engine} not yet fully implemented in TS version.`);
}
