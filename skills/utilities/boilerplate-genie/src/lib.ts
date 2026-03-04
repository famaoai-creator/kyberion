/**
 * Boilerplate Genie Core Library.
 */

export enum ProjectType {
  NODE = 'node',
  PYTHON = 'python',
  GENERIC = 'generic'
}

export interface ProjectDef {
  name: string;
  type: ProjectType;
}

export function generateNodeProject(name: string): Record<string, string> {
  return {
    'package.json': JSON.stringify({ name, version: '1.0.0', main: 'index.js' }, null, 2),
    'index.js': 'console.log("Hello Node.js");'
  };
}

export function generatePythonProject(name: string): Record<string, string> {
  return {
    'requirements.txt': 'requests==2.31.0',
    'main.py': 'print("Hello Python")'
  };
}

export function generateGenericProject(name: string): Record<string, string> {
  return {
    'README.md': `# ${name}\nGenerated generic project.`
  };
}

export function generateBoilerplate(def: ProjectDef): Record<string, string> {
  switch (def.type) {
    case ProjectType.NODE: return generateNodeProject(def.name);
    case ProjectType.PYTHON: return generatePythonProject(def.name);
    default: return generateGenericProject(def.name);
  }
}
