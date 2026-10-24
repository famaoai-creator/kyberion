'use client';

import type { KbSettingsNavProps } from '@agent/core/surface/a2ui-catalog';
import { isPlainActivation } from '../../vanilla/kyberion-ui.js';
import { useA2UIActions } from '../actions.js';
import { normalizeAction } from '../components/controls.js';
import { StatusPill } from '../components/feedback.js';
import { isKbStatus } from '../catalog.js';
import { safeHref } from '../safety.js';
import { IconWrap } from './shared.js';

export type SettingsNavProps = KbSettingsNavProps & {
  /** Plain clicks only; modified clicks retain the link's browser behavior. */
  onNavigate?: (href: string, itemId: string) => void;
};

/** Section navigation, not a tablist: links remain usable without JavaScript. */
export function SettingsNav({ label, groups, active, onNavigate }: SettingsNavProps) {
  const { onAction } = useA2UIActions();
  const list = Array.isArray(groups)
    ? groups.filter((group) => group && Array.isArray(group.items))
    : [];
  return (
    <nav className="kb-settings-nav" aria-label={typeof label === 'string' ? label : ''}>
      {list.map((group) => (
        <div className="kb-settings-nav__group" key={group.id}>
          {typeof group.label === 'string' && group.label ? (
            <p className="kb-settings-nav__group-label">{group.label}</p>
          ) : null}
          <ul
            className="kb-settings-nav__list"
            aria-label={typeof group.label === 'string' && group.label ? group.label : undefined}
          >
            {group.items
              .filter((item) => item && typeof item.label === 'string')
              .map((item) => {
                const href = safeHref(item.href);
                const action = normalizeAction(item.action);
                const content = (
                  <>
                    {typeof item.icon === 'string' && item.icon ? (
                      <IconWrap className="kb-settings-nav__icon" name={item.icon} />
                    ) : null}
                    <span className="kb-settings-nav__text">
                      <span className="kb-settings-nav__label">{item.label}</span>
                      {typeof item.description === 'string' && item.description ? (
                        <span className="kb-settings-nav__description">{item.description}</span>
                      ) : null}
                    </span>
                    {typeof item.badge === 'string' && item.badge ? (
                      <span className="kb-settings-nav__badge">{item.badge}</span>
                    ) : null}
                    {isKbStatus(item.status) ? <StatusPill status={item.status} /> : null}
                  </>
                );
                return (
                  <li key={item.id}>
                    {href ? (
                      <a
                        href={href}
                        className="kb-settings-nav__link"
                        data-nav-id={item.id}
                        data-action-id={action?.id}
                        aria-current={item.id === active ? 'location' : undefined}
                        onClick={(event) => {
                          if (event.defaultPrevented || !isPlainActivation(event)) return;
                          if (onNavigate) {
                            event.preventDefault();
                            onNavigate(href, item.id);
                          } else if (action && onAction) {
                            event.preventDefault();
                            onAction(action.id, action.payload);
                          }
                        }}
                      >
                        {content}
                      </a>
                    ) : (
                      <span
                        className="kb-settings-nav__link"
                        data-nav-id={item.id}
                        aria-disabled="true"
                      >
                        {content}
                      </span>
                    )}
                  </li>
                );
              })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
