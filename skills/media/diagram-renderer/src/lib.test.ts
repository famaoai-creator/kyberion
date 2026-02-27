import { describe, it, expect } from 'vitest';
import { adfToMermaid, renderDiagramArtifact, ADF, IconMap } from './lib.js';

describe('diagram-renderer lib', () => {
  const mockADF: ADF = {
    nodes: [
      { id: 'app-service', type: 'service', name: 'App Service' },
      { id: 'db.main', type: 'database', name: 'Main DB' },
    ],
    edges: [{ from: 'app-service', to: 'db.main', label: 'queries' }],
  };

  const mockIconMap: IconMap = {
    default: '?',
    service: '⚙️',
    database: '🗄️',
  };

  it('should transform ADF to Mermaid syntax correctly', () => {
    const mmd = adfToMermaid(mockADF, mockIconMap);

    expect(mmd).toContain('graph LR');
    expect(mmd).toContain('app_service("⚙️ App Service")');
    expect(mmd).toContain('db_main("🗄️ Main DB")');
    expect(mmd).toContain('app_service -->|"queries"| db_main');
  });

  it('should handle missing types with default icon', () => {
    const adfWithUnknown: ADF = {
      nodes: [{ id: 'unknown-node', type: 'weird', name: 'Unknown' }],
      edges: [],
    };
    const mmd = adfToMermaid(adfWithUnknown, mockIconMap);
    expect(mmd).toContain('unknown_node("? Unknown")');
  });

  it('should throw error for invalid ADF structure', () => {
    const invalidADF: any = { nodes: 'not-an-array' };
    expect(() => adfToMermaid(invalidADF, mockIconMap)).toThrow('nodes" array is required');
  });

  it('should render DocumentArtifact containing Mermaid source', () => {
    const artifact = renderDiagramArtifact('Test Diagram', mockADF, mockIconMap);
    expect(artifact.title).toBe('Test Diagram');
    expect(artifact.body).toContain('graph LR');
    expect(artifact.format).toBe('text');
    expect(artifact.metadata?.adf).toBeDefined();
  });
});
