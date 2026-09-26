/** Render an XLSX numeric value using the cell's display format. */
export function formatXlsxNumber(value: number, formatCode?: string): string {
  const code = (formatCode || 'General').replace(/\\([\\\\])/g, '$1');
  if (!formatCode || /^general$/i.test(code)) {
    return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(10)));
  }

  const sections = code.split(';');
  const section =
    value > 0
      ? sections[0]
      : value < 0
        ? (sections[1] ?? sections[0])
        : (sections[2] ?? sections[0]);
  if (!section) return '';
  if (/^\s*"[^"]*"\s*$/.test(section)) return section.replace(/"/g, '');

  const percent = section.includes('%');
  const absolute = Math.abs(percent ? value * 100 : value);
  const decimalMatch = section.match(/\.([0#]+)/);
  const decimals = decimalMatch?.[1].length ?? 0;
  const rounded = absolute.toFixed(decimals);
  let [integer, fraction] = rounded.split('.');
  if (section.includes(',')) integer = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const number = fraction ? `${integer}.${fraction}` : integer;
  const literal = section
    .replace(/\[[^\]]+\]/g, '')
    .replace(/[#0?.,%]+/g, '')
    .replace(/"([^"]*)"/g, '$1')
    .trim();
  const negative =
    value < 0 && sections.length < 2 && !section.includes('-') && !section.includes('(');
  const rendered = `${negative ? '-' : ''}${number}${percent ? '%' : ''}`;
  return section.includes('(')
    ? `(${rendered.replace(/^-/, '')})`
    : `${literal.includes('▲') ? '▲' : ''}${rendered}`;
}
