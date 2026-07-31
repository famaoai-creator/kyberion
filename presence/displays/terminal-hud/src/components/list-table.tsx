import { Box, Text } from 'ink';
import type { ListRow } from '../store/types.js';
import { theme } from '../theme.js';

export interface ListTableProps {
  columns: string[];
  rows: ListRow[];
  selectedIndex: number;
  maxVisible?: number;
}

function cellWidths(columns: string[], rows: ListRow[]): number[] {
  return columns.map((column, idx) => {
    let width = column.length;
    for (const row of rows) {
      width = Math.max(width, (row.cells[idx] ?? '').length);
    }
    return Math.min(width, 40);
  });
}

function pad(value: string, width: number): string {
  const truncated = value.length > width ? `${value.slice(0, width - 1)}…` : value;
  return truncated.padEnd(width);
}

export function ListTable({ columns, rows, selectedIndex, maxVisible = 12 }: ListTableProps) {
  const widths = cellWidths(columns, rows);
  const start = Math.max(0, Math.min(selectedIndex - maxVisible + 2, rows.length - maxVisible));
  const visible = rows.slice(start, start + maxVisible);
  return (
    <Box flexDirection="column">
      <Text bold color={theme.accent}>
        {columns.map((column, idx) => pad(column, widths[idx])).join('  ')}
      </Text>
      {visible.map((row, idx) => {
        const absoluteIndex = start + idx;
        const isSelected = absoluteIndex === selectedIndex;
        return (
          <Text
            key={row.id}
            color={isSelected ? 'black' : row.color}
            backgroundColor={isSelected ? theme.accent : undefined}
          >
            {row.cells.map((cell, cellIdx) => pad(cell ?? '', widths[cellIdx])).join('  ')}
          </Text>
        );
      })}
      {rows.length > start + maxVisible ? (
        <Text dimColor>{`… +${rows.length - start - maxVisible}`}</Text>
      ) : null}
    </Box>
  );
}
