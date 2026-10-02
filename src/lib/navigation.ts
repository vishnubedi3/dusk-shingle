import type { MouseEvent } from 'react';

/**
 * Move within the single-page app. The address bar is the state: a back button,
 * a refresh and a shared link all resolve from it, so a discussion opened from
 * a chapter is still the same discussion a week later.
 */
export function navigateTo(href: string, options: { replace?: boolean } = {}): void {
  if (window.location.pathname + window.location.search === href) {
    window.scrollTo({ top: 0, behavior: 'auto' });
    return;
  }

  if (options.replace) window.history.replaceState({}, '', href);
  else window.history.pushState({}, '', href);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo({ top: 0, behavior: 'auto' });
}

export function isModifiedClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}
