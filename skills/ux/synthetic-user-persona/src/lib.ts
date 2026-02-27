export interface Persona {
  id: string;
  name: string;
  archetype: string;
  testScenarios: any[];
}

export function generatePersonas(count: number, product: string): Persona[] {
  const personas: Persona[] = [];
  for (let i = 0; i < count; i++) {
    personas.push({
      id: 'persona-' + (i + 1),
      name: 'User ' + (i + 1),
      archetype: 'Beginner',
      testScenarios: [{ scenario: 'First-time ' + product + ' setup' }],
    });
  }
  return personas;
}
