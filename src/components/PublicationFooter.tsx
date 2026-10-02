import { Link } from './Link';
import { publication } from '../content/publication';

export function PublicationFooter({ showTitleNote = true }: { showTitleNote?: boolean }) {
  return (
    <footer className="footer">
      <div className="footer-inner page">
        <Link className="wordmark wordmark-small" href="/" aria-label={`${publication.title} library`}>
          <span>Dusk</span><i className="wordmark-horizon" aria-hidden="true" /><span>Shingle</span>
        </Link>
        {/* The library page already carries the full note directly above; repeating
            it there made the reader read the same paragraph twice. */}
        {showTitleNote && (
          <p className="footer-title-note">
            <cite>{publication.title}</cite> is the name of the project under which this novel
            belongs — the novel’s true name will be revealed in due time.
          </p>
        )}
        <nav className="footer-links" aria-label="Site">
          <Link href="/">Library</Link>
          <Link href="/community">Community</Link>
          <Link href="/community/new">Start a discussion</Link>
          <Link href="/account">Account</Link>
        </nav>
        <p className="footer-fine">No analytics, no trackers, no advertising. Anonymous by design.</p>
      </div>
    </footer>
  );
}
