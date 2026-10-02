import { useCallback, useEffect, useState } from 'react';
import { Notice } from '../components/Notice';
import { Link } from '../components/Link';
import { CommentText } from '../components/CommentText';
import { api, ApiFailure } from '../lib/api';

type Item = {
  id: string;
  discussionId: string | null;
  discussionTitle: string | null;
  chapterSlug: string | null;
  body: string;
  state: string;
  author: string | null;
  reports: number;
  reasons: string[];
};

/** Visible to everyone as a route, but the API enforces the moderator role on every call. */
export function ModerationPage() {
  const [items, setItems] = useState<Item[]>();
  const [error, setError] = useState<ApiFailure>();
  const load = useCallback(() => {
    api<{ items: Item[] }>('GET', '/api/moderation/reports').then((d) => setItems(d.items)).catch((e) => setError(e as ApiFailure));
  }, []);
  useEffect(load, [load]);

  return (
    <main id="main" className="moderation page">
      <p className="meta-label">Moderation</p>
      <h1 className="standalone-title">Reported posts</h1>
      {error && <Notice tone={error.status === 403 || error.status === 401 ? 'quiet' : 'error'}>{error.message}</Notice>}
      {items && items.length === 0 && <p className="meta">The queue is empty.</p>}
      <ol className="threads">
        {items?.map((item) => (
          <li key={item.id} className="comment">
            <header className="comment-head">
              <span className="comment-author">{item.author ?? 'Former reader'}</span>
              <span className="meta">
                {item.reports} report{item.reports === 1 ? '' : 's'} · {item.reasons.join(', ')} · {item.state} ·{' '}
                {item.discussionId ? (
                  <Link href={`/community/${item.discussionId}`}>{item.discussionTitle ?? 'a discussion'}</Link>
                ) : item.chapterSlug ? (
                  <Link href={`/chapter/${item.chapterSlug}/discussion`}>{item.chapterSlug}</Link>
                ) : (
                  'a discussion'
                )}
              </span>
            </header>
            <CommentText body={item.body} />
            <div className="comment-actions">
              {(['visible', 'hidden', 'removed'] as const).map((state) => (
                <button key={state} type="button" className="text-btn" onClick={() => api('POST', `/api/moderation/comments/${item.id}`, { state }).then(load).catch((e) => setError(e as ApiFailure))}>
                  {state === 'visible' ? 'Restore' : state === 'hidden' ? 'Keep hidden' : 'Remove'}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ol>
    </main>
  );
}
