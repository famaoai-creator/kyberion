export interface CoreValue {
  name: string;
  keywords: string[];
}

export function analyzeAlignment(content: string, values: CoreValue[]): any[] {
  const lower = content.toLowerCase();
  return values.map((v) => {
    const matches = v.keywords.filter((k) => lower.includes(k.toLowerCase()));
    return {
      value: v.name,
      score: matches.length > 0 ? 100 : 0,
      matches,
    };
  });
}
