export function truncateText(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

export function truncateTextWithCount(
  value: string,
  max: number
): {
  text: string;
  omitted_count: number;
} {
  const text = truncateText(value, max);
  return {
    text,
    omitted_count: Math.max(0, value.length - text.length),
  };
}
