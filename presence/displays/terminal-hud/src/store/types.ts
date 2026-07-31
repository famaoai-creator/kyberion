export interface DetailLine {
  label: string;
  value: string;
}

export interface ListRow {
  id: string;
  cells: string[];
  color?: string;
  detail?: DetailLine[];
}

export interface PanelSection {
  title?: string;
  lines: string[];
}

export interface PanelViewModel {
  columns?: string[];
  rows?: ListRow[];
  sections?: PanelSection[];
  footerHint?: string;
}
