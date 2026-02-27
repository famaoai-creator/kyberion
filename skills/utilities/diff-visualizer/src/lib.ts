import * as Diff from 'diff';

export function generateDiff(
  oldPath: string,
  newPath: string,
  oldText: string,
  newText: string
): string {
  return Diff.createTwoFilesPatch(oldPath, newPath, oldText, newText, 'Old File', 'New File');
}
