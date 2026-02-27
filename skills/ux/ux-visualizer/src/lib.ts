export function generateMermaidUX(title: string, fidelity: string = 'high'): string {
  const nl = String.fromCharCode(10);
  if (fidelity === 'low') return 'graph TD' + nl + '  Start --> End';

  let mermaid = 'graph TD' + nl;
  mermaid += '  S1["<div style=\\"padding:10px;\\">' + title + '</div>"]' + nl;
  return mermaid;
}
