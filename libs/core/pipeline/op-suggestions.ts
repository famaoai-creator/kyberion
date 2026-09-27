export function suggestClosestStrings(target: string, candidates: string[], limit = 3): string[] {
  const normalizedTarget = String(target || '')
    .trim()
    .toLowerCase();
  if (!normalizedTarget || candidates.length === 0) return [];
  return [...new Set(candidates)]
    .map((candidate) => ({
      candidate,
      score: levenshtein(normalizedTarget, String(candidate).trim().toLowerCase()),
    }))
    .sort(
      (left, right) => left.score - right.score || left.candidate.localeCompare(right.candidate)
    )
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

function levenshtein(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;

  const matrix: number[][] = Array.from({ length: left.length + 1 }, () =>
    new Array(right.length + 1).fill(0)
  );

  for (let i = 0; i <= left.length; i += 1) matrix[i]![0] = i;
  for (let j = 0; j <= right.length; j += 1) matrix[0]![j] = j;

  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      matrix[i]![j] = Math.min(
        matrix[i - 1]![j]! + 1,
        matrix[i]![j - 1]! + 1,
        matrix[i - 1]![j - 1]! + cost
      );
    }
  }

  return matrix[left.length]![right.length]!;
}
