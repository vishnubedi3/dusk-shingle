import { useId, useState } from 'react';
import { Icon } from '../Icon';
import { Notice } from '../Notice';
import { CommentText } from '../CommentText';
import { PostComposer } from './PostComposer';
import { api, ApiFailure } from '../../lib/api';
import { chapterNumber, relativeTime } from '../../lib/format';
import { isFolded } from '../../lib/spoilers';
import type { Post, Thread } from '../../lib/forum';

type Props = {
  post: Post;
  /** Present only when this post *is* the discussion it heads. */
  thread?: Thread;
  /** Highest chapter the reader has finished. Reading progress is end-to-end encrypted, so only they know. */
  readerThrough: number;
  floor: number;
  scope: number;
  onChange: () => Promise<void>;
  canPost: boolean;
  onReply?: () => void;
};

/**
 * One post in a discussion. The discussion itself renders through this same
 * component, so a thread and its replies are marked, edited, reported and
 * moderated by exactly the same rules.
 */
export function PostItem({ post, thread, readerThrough, floor, scope, onChange, canPost, onReply }: Props) {
  const [revealed, setRevealed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string>();

  async function act(fn: () => Promise<unknown>) {
    setError(undefined);
    try {
      await fn();
      await onChange();
    } catch (e) {
      setError((e as ApiFailure).message);
    }
  }

  if (post.status === 'deleted') {
    return <article className="comment is-gone"><p className="meta">{thread ? 'Discussion' : 'Post'} deleted by its author.</p></article>;
  }
  if (!post.mine && (post.status === 'hidden' || post.status === 'removed')) {
    return <article className="comment is-gone"><p className="meta">Hidden while moderators review reports.</p></article>;
  }

  // The thread's own declared scope is the floor: a reader is never shown
  // something past it unfolded, however it was written.
  const folded = !post.mine && !revealed && isFolded(post.revealsThrough, readerThrough, scope);
  const header = (
    <header className="comment-head">
      <span className="comment-author">{post.author}{post.mine && <span className="comment-you"> · you</span>}</span>
      <span className="meta">
        <time dateTime={post.createdAt}>{relativeTime(post.createdAt)}</time>
        {post.editedAt && ' · edited'}
        {post.revealsThrough > scope && ` · up to ch. ${chapterNumber(post.revealsThrough)}`}
      </span>
    </header>
  );

  if (folded) {
    return (
      <article className="comment is-folded">
        {header}
        <p className="folded-text">Folded — this reaches into chapter {chapterNumber(post.revealsThrough)}, which you haven’ finished.</p>
        <button type="button" className="btn btn-quiet" onClick={() => setRevealed(true)}>Reveal anyway</button>
      </article>
    );
  }

  const body_ = editing ? (
    thread
      ? <DiscussionEditor thread={thread} onCancel={() => setEditing(false)} onPosted={async () => { setEditing(false); await onChange(); }} />
      : <PostComposer editId={post.id} initial={post} floor={floor} scope={scope} onCancel={() => setEditing(false)} onPosted={async () => { setEditing(false); await onChange(); }} />
  ) : (
    <CommentText body={post.body} />
  );

  return (
    <article className="comment">
      {header}
      {post.mine && post.status !== 'visible' && (
        <Notice tone="caution">
          {post.status === 'removed' ? 'Moderators removed this. Only you can see it.' : 'This is hidden from others while reports are reviewed.'}
        </Notice>
      )}
      {body_}
      {!editing && post.status === 'visible' && (
        <div className="comment-actions">
          {onReply && canPost && <button type="button" className="text-btn" onClick={onReply}><Icon name="reply" size={14} />Reply</button>}
          {canPost && !post.mine ? (
            <button type="button" className="text-btn" aria-pressed={post.reacted}
              onClick={() => act(() => api(post.reacted ? 'DELETE' : 'PUT', `/api/comments/${post.id}/reaction`))}>
              <Icon name="mark" size={14} />{post.reacted ? 'Marked' : 'Mark'}
              {post.reactions > 0 && <span className="count" aria-label={`${post.reactions} readers marked this`}>{post.reactions}</span>}
            </button>
          ) : post.reactions > 0 ? (
            <span className="meta">Marked by {post.reactions}</span>
          ) : null}
          {post.mine && <button type="button" className="text-btn" onClick={() => setEditing(true)}>Edit</button>}
          {post.mine && (confirmDelete ? (
            <span className="confirm-inline">
              Delete permanently?
              <button type="button" className="text-btn danger" onClick={() => act(() => api('DELETE', `/api/comments/${post.id}`))}>Delete</button>
              <button type="button" className="text-btn" onClick={() => setConfirmDelete(false)}>Keep</button>
            </span>
          ) : <button type="button" className="text-btn" onClick={() => setConfirmDelete(true)}>Delete</button>)}
          {canPost && !post.mine && (
            <button type="button" className="text-btn subtle" onClick={() => setReporting((r) => !r)} aria-expanded={reporting}>
              <Icon name="flag" size={14} />Report
            </button>
          )}
        </div>
      )}
      {reporting && <ReportForm id={post.id} onDone={async () => { setReporting(false); await onChange(); }} />}
      {error && <Notice tone="error">{error}</Notice>}
    </article>
  );
}

/**
 * Editing a discussion. A chapter's room keeps its chapter tag and category:
 * they are structural, so the editor shows the title and the text only.
 */
function DiscussionEditor({ thread, onCancel, onPosted }: {
  thread: Thread;
  onCancel: () => void;
  onPosted: () => Promise<void>;
}) {
  const [title, setTitle] = useState(thread.title);
  const [body, setBody] = useState(thread.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiFailure>();
  const id = useId();
  return (
    <form className="composer" onSubmit={async (event) => {
      event.preventDefault();
      setBusy(true);
      setError(undefined);
      try {
        await api('PATCH', `/api/forum/threads/${thread.id}`, {
          title, body, category: thread.category, tags: thread.tags, revealsThrough: thread.revealsThrough,
        });
        await onPosted();
      } catch (err) {
        setError(err as ApiFailure);
      } finally {
        setBusy(false);
      }
    }}>
      <label htmlFor={id} className="visually-hidden">Discussion title</label>
      <input id={id} type="text" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} required />
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} maxLength={4000} required autoFocus />
      <div className="composer-actions">
        <button type="button" className="btn btn-quiet" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={busy || !title.trim() || !body.trim()}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
      {error && <Notice tone="error">{error.message}</Notice>}
    </form>
  );
}

function ReportForm({ id, onDone }: { id: string; onDone: () => Promise<void> }) {
  const [reason, setReason] = useState('spoiler');
  const [note, setNote] = useState('');
  const [state, setState] = useState<'idle' | 'sent' | string>('idle');
  const name = useId();
  if (state === 'sent') {
    return <Notice tone="quiet">Thank you. Moderators will review it; the author is not told who reported.</Notice>;
  }
  return (
    <form className="report" onSubmit={async (event) => {
      event.preventDefault();
      try {
        await api('POST', `/api/comments/${id}/report`, { reason, note: note || undefined });
        setState('sent');
        window.setTimeout(() => void onDone(), 2500);
      } catch (err) {
        setState((err as ApiFailure).message);
      }
    }}>
      <fieldset>
        <legend className="meta-label">Why are you reporting this?</legend>
        {([['spoiler', 'Unmarked spoiler'], ['harassment', 'Harassment or hate'], ['spam', 'Spam'], ['other', 'Something else']] as const).map(([v, l]) => (
          <label key={v} className="radio">
            <input type="radio" name={name} value={v} checked={reason === v} onChange={() => setReason(v)} />{l}
          </label>
        ))}
      </fieldset>
      <label className="visually-hidden" htmlFor={`${name}-note`}>Optional note for moderators</label>
      <input id={`${name}-note`} type="text" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional note for moderators" />
      <button type="submit" className="btn btn-secondary">Send report</button>
      {state !== 'idle' && <Notice tone="error">{state}</Notice>}
    </form>
  );
}
