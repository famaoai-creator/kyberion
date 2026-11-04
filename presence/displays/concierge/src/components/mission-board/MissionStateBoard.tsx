'use client';

import * as React from 'react';
import { groupMissionBoard, type MissionBoardColumnId } from './mission-state-board';
import './mission-board.css';

export interface MissionStateBoardMission {
  id: string;
  label: string;
  status?: string;
  updatedAt?: string;
  href: string;
}

export interface MissionStateBoardProps {
  missions: readonly MissionStateBoardMission[];
  /** Column titles and texts, already localized. */
  columnLabel: (id: MissionBoardColumnId) => string;
  emptyColumn: string;
  moreLabel: (count: number) => string;
  label: string;
  /** Link to the full column (the list filtered by status), when one exists. */
  columnHref?: (id: MissionBoardColumnId) => string | undefined;
}

/**
 * `/work` 仕事 › ミッション: four state columns (進行中 / 入力待ち・停滞 /
 * レビュー待ち / 完了) with a count each and the most recent missions as
 * links to their detail page. Read-only — mission state changes go through
 * the mission controller, never through this board. The columns scroll
 * inside their own container on narrow screens.
 */
export function MissionStateBoard({
  missions,
  columnLabel,
  emptyColumn,
  moreLabel,
  label,
  columnHref,
}: MissionStateBoardProps) {
  const columns = React.useMemo(() => groupMissionBoard(missions), [missions]);
  return (
    <div className="mb-board" role="list" aria-label={label}>
      {columns.map((column) => {
        const href = columnHref?.(column.id);
        return (
          <section
            key={column.id}
            className="mb-column"
            role="listitem"
            data-column={column.id}
            aria-labelledby={`mb-col-${column.id}`}
          >
            <header className="mb-column__header">
              <h3 className="mb-column__title" id={`mb-col-${column.id}`}>
                {columnLabel(column.id)}
              </h3>
              <span className="mb-column__count">{column.count}</span>
            </header>
            {column.missions.length ? (
              <ul className="mb-column__list">
                {column.missions.map((mission) => (
                  <li key={mission.id}>
                    <a className="mb-card" href={mission.href} title={mission.label}>
                      {mission.label}
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mb-column__empty">{emptyColumn}</p>
            )}
            {column.count > column.missions.length ? (
              href ? (
                <a className="mb-column__more" href={href}>
                  {moreLabel(column.count - column.missions.length)}
                </a>
              ) : (
                <p className="mb-column__more">
                  {moreLabel(column.count - column.missions.length)}
                </p>
              )
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
