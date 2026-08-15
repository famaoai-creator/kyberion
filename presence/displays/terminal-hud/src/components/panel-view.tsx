import { useEffect, useState } from 'react';
import { Box, Text, useInput, useStdin, useStdout } from 'ink';
import type { DetailLine, PanelViewModel } from '../store/types.js';
import { ListTable } from './list-table.js';
import { useI18n } from '../i18n.js';
import { theme } from '../theme.js';

export interface PanelViewProps {
  vm?: PanelViewModel;
  loading: boolean;
  error?: string;
  isActive: boolean;
  detailFor?: (rowId: string) => DetailLine[] | undefined;
  /**
   * Panel-specific action hook: return true when the key was consumed.
   * Receives the currently selected row id (if any).
   */
  onAction?: (input: string, rowId: string | undefined) => boolean;
}

export function PanelView({ vm, loading, error, isActive, detailFor, onAction }: PanelViewProps) {
  const { tr } = useI18n();
  const { isRawModeSupported } = useStdin();
  const { stdout } = useStdout();
  const maxVisible = Math.max(5, (stdout?.rows ?? 24) - 16);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showDetail, setShowDetail] = useState(false);

  const rows = vm?.rows ?? [];
  const rowCount = rows.length;
  useEffect(() => {
    setSelectedIndex((current) => Math.min(current, Math.max(0, rowCount - 1)));
  }, [rowCount]);

  const selectedRow = rows[selectedIndex];

  useInput(
    (input, key) => {
      if (input === 'j' || key.downArrow) {
        setSelectedIndex((current) => Math.min(current + 1, Math.max(0, rowCount - 1)));
        return;
      }
      if (input === 'k' || key.upArrow) {
        setSelectedIndex((current) => Math.max(current - 1, 0));
        return;
      }
      if (input === 'g') {
        setSelectedIndex(0);
        return;
      }
      if (input === 'G') {
        setSelectedIndex(Math.max(0, rowCount - 1));
        return;
      }
      if (key.return) {
        setShowDetail((current) => !current);
        return;
      }
      if (key.escape && showDetail) {
        setShowDetail(false);
        return;
      }
      if (onAction && selectedRow !== undefined) {
        onAction(input, selectedRow.id);
      } else if (onAction) {
        onAction(input, undefined);
      }
    },
    { isActive: isActive && isRawModeSupported }
  );

  if (error) {
    return (
      <Text color={theme.err}>
        {tr('tui:tui_error')}: {error}
      </Text>
    );
  }
  if (loading && !vm) {
    return <Text dimColor>{tr('tui:tui_loading')}</Text>;
  }
  if (!vm) {
    return <Text dimColor>{tr('tui:tui_empty')}</Text>;
  }

  const detail =
    showDetail && selectedRow
      ? (selectedRow.detail ?? detailFor?.(selectedRow.id) ?? [])
      : undefined;

  return (
    <Box flexDirection="column">
      {vm.columns && rows.length > 0 ? (
        <ListTable
          columns={vm.columns}
          rows={rows}
          selectedIndex={selectedIndex}
          maxVisible={maxVisible}
        />
      ) : vm.columns ? (
        <Text dimColor>{tr('tui:tui_empty')}</Text>
      ) : null}
      {detail ? (
        <Box flexDirection="column" borderStyle="single" paddingX={1} marginTop={1}>
          <Text bold color={theme.accent}>
            {tr('tui:tui_detail_title')}: {selectedRow?.id}
          </Text>
          {detail.map((line, idx) => (
            <Text key={`${line.label}:${idx}`}>
              <Text color={theme.dim}>{line.label} </Text>
              {line.value}
            </Text>
          ))}
        </Box>
      ) : null}
      {(vm.sections ?? []).map((section, idx) => (
        <Box key={`${section.title ?? 'section'}:${idx}`} flexDirection="column" marginTop={1}>
          {section.title ? (
            <Text bold color={theme.dim}>
              {section.title}
            </Text>
          ) : null}
          {section.lines.map((line, lineIdx) => (
            <Text key={lineIdx}>{line}</Text>
          ))}
        </Box>
      ))}
      {vm.footerHint ? (
        <Box marginTop={1}>
          <Text dimColor>{vm.footerHint}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
