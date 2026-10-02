import { useEffect, useState } from 'react';
import { Link } from './Link';
import { ReadingControls } from './ReadingControls';
import { getPublishedChapters } from '../content/chapters';
import { useReader } from '../lib/reader';

type Props = { pathname: string; readingTitle?: string };

export function SiteHeader({ pathname, readingTitle }: Props) {
  const { account, unreadReplies, vault } = useReader();
  const reading = Boolean(readingTitle);
  const hidden = useHideOnScroll(reading);
  const is = (p: string | RegExp) => (typeof p === 'string' ? pathname === p : p.test(pathname));

  // "Continue reading" appears only once there is somewhere to continue to, so
  // the navigation stays short for a reader who has not begun.
  const chapters = getPublishedChapters();
  const started = chapters.some((c) => (vault.chapters[c.slug]?.progress ?? 0) > 0);
  const nextUnread = chapters.find((c) => !vault.chapters[c.slug]?.completed);
  const continueHref = started && nextUnread ? `/chapter/${nextUnread.slug}` : undefined;

  return (
    <header className="masthead" data-reading={reading || undefined} data-hidden={hidden || undefined}>
      <div className="masthead-inner">
        <Link className="wordmark" href="/" aria-label="Dusk Shingle — library">
          <span>Dusk</span>
          <i className="wordmark-horizon" aria-hidden="true" />
          <span>Shingle</span>
        </Link>
        {reading && <p className="masthead-context" aria-hidden="true">{readingTitle}</p>}
        <nav className="nav" aria-label="Primary">
          <Link href="/" aria-current={is('/') || is('/library') ? 'page' : undefined}>Library</Link>
          {continueHref && (
            <Link className="nav-continue" href={continueHref} aria-current={pathname === continueHref ? 'page' : undefined}>
              <span className="nav-long">Continue reading</span><span className="nav-short">Read</span>
            </Link>
          )}
          <Link
            href="/community"
            aria-current={is('/community') || is(/^\/community(\/|$)/) || is(/\/discussion$/) ? 'page' : undefined}
          >
            <span className="nav-long">Community</span><span className="nav-short">Forum</span>
          </Link>
          <Link href="/account" aria-current={is('/account') ? 'page' : undefined}>
            {account ? 'You' : 'Account'}
            {unreadReplies > 0 && <span className="nav-dot"><span className="visually-hidden">, {unreadReplies} unread replies</span></span>}
          </Link>
        </nav>
        {reading && <ReadingControls />}
      </div>
    </header>
  );
}

/** While reading, the header steps aside on downward scroll and returns on upward scroll. */
function useHideOnScroll(enabled: boolean) {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (!enabled) {
      setHidden(false);
      return;
    }
    let last = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      if (Math.abs(y - last) < 8) return;
      setHidden(y > last && y > 240);
      last = y;
    };
    const onFocus = () => setHidden(false);
    window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('focusin', onFocus);
    return () => {
      window.removeEventListener('scroll', onScroll);
      document.removeEventListener('focusin', onFocus);
    };
  }, [enabled]);
  return hidden;
}
