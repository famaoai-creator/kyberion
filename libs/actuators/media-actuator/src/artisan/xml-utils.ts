export function collectXmlMatches(xml: string, pattern: RegExp): string[] {
  return xml.match(pattern) ?? [];
}

export function collectXmlCaptures(xml: string, pattern: RegExp, captureIndex = 1): string[] {
  const matches = [...xml.matchAll(pattern)];
  return matches
    .map(match => match[captureIndex] ?? '')
    .filter(value => value.length > 0);
}
