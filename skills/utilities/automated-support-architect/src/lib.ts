export interface FAQ {
  q: string;
  a: string;
  source: string;
}

export function extractFAQsFromMarkdown(content: string): FAQ[] {
  const faqs: FAQ[] = [];
  const nl = String.fromCharCode(10);
  const sections = content.split(new RegExp('^##\\\\s+', 'm')).filter((s) => s.trim().length > 0);

  for (const s of sections) {
    const lines = s.split(nl);
    const title = lines[0].trim();
    if (/usage|getting.started|install|setup|quick.start/i.test(title)) {
      faqs.push({
        q: 'How do I ' + title.toLowerCase() + '?',
        a: lines.slice(1, 5).join(nl).trim(),
        source: 'README.md',
      });
    }
  }
  return faqs;
}
