export function generateSequenceDiagram(code: string): string {
  const lines = code.split('\n');
  let mermaid = 'sequenceDiagram\n    autonumber\n';
  let currentFunction = 'Main';

  lines.forEach((line) => {
    // Check for logical DSL: A -> B: Message
    const dslMatch = line.match(/^(\w+)\s*->>?\s*(\w+)\s*:\s*(.+)$/);
    if (dslMatch) {
      mermaid += `    ${dslMatch[1]}->>${dslMatch[2]}: ${dslMatch[3]}\n`;
      return;
    }

    const funcDef = line.match(/function\s+(\w+)/);
    if (funcDef) {
      currentFunction = funcDef[1];
    }

    const call = line.match(/(\w+)\(/);
    const ignored = ['if', 'for', 'while', 'switch', 'catch'];
    if (call && !line.includes('function') && !ignored.includes(call[1])) {
      const target = call[1];
      mermaid += `    ${currentFunction}->>${target}: ${target}()\n`;
    }
  });

  return mermaid;
}
