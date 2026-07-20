export interface MediaSlideText {
  slide_index: number;
  concatenated?: string;
  text_runs?: string[];
}

export function findSlidesByOwner(input: {
  slides: MediaSlideText[];
  owner_labels: string[];
  match_mode?: 'substring' | 'run_exact';
}): { indices: number[]; matches: Array<{ slide_index: number; matched_label: string }> } {
  const mode = input.match_mode || 'substring';
  const matches: Array<{ slide_index: number; matched_label: string }> = [];
  for (const slide of input.slides) {
    const matchedLabel = input.owner_labels.find((label) =>
      mode === 'run_exact'
        ? (slide.text_runs || []).includes(label)
        : (slide.concatenated || '').includes(label)
    );
    if (matchedLabel) matches.push({ slide_index: slide.slide_index, matched_label: matchedLabel });
  }
  return { indices: matches.map((match) => match.slide_index), matches };
}

export function pptxDiff(input: { before: MediaSlideText[]; after: MediaSlideText[] }): {
  added: number[];
  removed: number[];
  changed: Array<{ slide_index: number; added_runs: string[]; removed_runs: string[] }>;
  unchanged: number[];
} {
  const beforeByIndex = new Map(input.before.map((slide) => [slide.slide_index, slide]));
  const afterByIndex = new Map(input.after.map((slide) => [slide.slide_index, slide]));
  const added: number[] = [];
  const removed: number[] = [];
  const changed: Array<{ slide_index: number; added_runs: string[]; removed_runs: string[] }> = [];
  const unchanged: number[] = [];
  for (const index of Array.from(new Set([...beforeByIndex.keys(), ...afterByIndex.keys()])).sort(
    (left, right) => left - right
  )) {
    const before = beforeByIndex.get(index);
    const after = afterByIndex.get(index);
    if (!before && after) {
      added.push(index);
      continue;
    }
    if (before && !after) {
      removed.push(index);
      continue;
    }
    const beforeRuns = new Set(before?.text_runs || []);
    const afterRuns = new Set(after?.text_runs || []);
    const addedRuns = [...afterRuns].filter((run) => !beforeRuns.has(run));
    const removedRuns = [...beforeRuns].filter((run) => !afterRuns.has(run));
    if (addedRuns.length === 0 && removedRuns.length === 0) {
      unchanged.push(index);
    } else {
      changed.push({ slide_index: index, added_runs: addedRuns, removed_runs: removedRuns });
    }
  }
  return { added, removed, changed, unchanged };
}
