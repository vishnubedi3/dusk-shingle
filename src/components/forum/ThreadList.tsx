import { Link } from '../Link';
import { chapterNumber, relativeTime } from '../../lib/format';
import { isFolded, scopeFloorOf } from '../../lib/spoilers';
import { replyCount, tagHref, tagLabel, threadHref, type ThreadSummary } from '../../lib/forum';

/**
 * A discussion as it appears in an index: title, where it sits, who opened it,
 * and how the conversation has gone. No body text — an index of bodies would
 * push unmarked spoilers past the chapter gate, which is the only thing between
 * a reader and the ending of a chapter they have not read.
 */
export function ThreadRow({ thread, readerThrough }: {
  thread: ThreadSummary;
  readerThrough: number;
}) {
  // A title can spoil as surely as a sentence can, so a discussion reaching past
  // what this reader has finished is named only by how far it reaches. A title
  // inside the discussion's own declared scope is shown to everyone.
  const concealed = isFolded(thread.revealsThrough, readerThrough, scopeFloorOf(thread.chapterNumber));
  return (
    <li className="thread-row">
      <p className="thread-where">
        <span className="thread-category">{thread.chapterNumber !== null ? `Chapter ${chapterNumber(thread.chapterNumber)}` : thread.categoryName}</span>
        <span className="thread-meta">
          {thread.author ?? 'A reader'} · <time dateTime={thread.lastActivityAt}>{relativeTime(thread.lastActivityAt)}</time>
          {' · '}{replyCount(thread.replies)}
          {thread.reactions > 0 && ` · ${thread.reactions} marked`}
        </span>
      </p>
      {concealed ? (
        <p className="thread-title is-concealed">
          A discussion that reaches into chapter {chapterNumber(thread.revealsThrough)}.
          {!thread.mine && <Link className="thread-reveal" href={threadHref(thread)}>Read it anyway</Link>}
        </p>
      ) : (
        <h3 className="thread-title"><Link href={threadHref(thread)}>{thread.title}</Link></h3>
      )}
      {thread.tags.length > 0 && (
        <p className="thread-tags">
          {thread.tags.map((tag) => (
            <Link key={tag} className="tag" href={tagHref(tag)}>{tagLabel(tag)}</Link>
          ))}
        </p>
      )}
    </li>
  );
}

export function ThreadList({ threads, readerThrough, empty }: {
  threads: ThreadSummary[];
  readerThrough: number;
  empty?: string;
}) {
  if (threads.length === 0) {
    return <p className="meta empty-line">{empty ?? 'No discussions here yet.'}</p>;
  }
  return (
    <ol className="thread-list">
      {threads.map((thread) => (
        <ThreadRow key={thread.id} thread={thread} readerThrough={readerThrough} />
      ))}
    </ol>
  );
}
