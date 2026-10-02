import { useId, useState, type FormEvent } from 'react';
import { Notice } from '../Notice';
import { SpoilerHint } from './SpoilerHint';
import { SpoilerScope } from './SpoilerScope';
import { api, ApiFailure } from '../../lib/api';
import type { Post } from '../../lib/forum';

/**
 * Writes a reply, or edits any post the reader owns. `threadId` selects the
 * reply endpoint; `editId` selects the edit endpoint for an existing post.
 */
export function PostComposer({ threadId, editId, initial, floor, scope, onPosted, onCancel, autoFocus }: {
  threadId?: string;
  editId?: string;
  initial?: Post;
  floor: number;
  scope: number;
  onPosted: () => Promise<void> | void;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const [body, setBody] = useState(initial?.body ?? '');
  const [reveals, setReveals] = useState(initial?.revealsThrough ?? scope);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiFailure>();
  const id = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      if (editId) await api('PATCH', `/api/comments/${editId}`, { body, revealsThrough: reveals });
      else await api('POST', `/api/forum/threads/${threadId}/comments`, { body, revealsThrough: reveals });
      setBody('');
      await onPosted();
    } catch (err) {
      setError(err as ApiFailure);
    } finally {
      setBusy(false);
    }
  }

  const label = editId ? 'Edit your post' : 'Write a reply';
  return (
    <form className="composer" onSubmit={submit}>
      <label htmlFor={id} className={autoFocus ? 'visually-hidden' : 'meta-label'}>{label}</label>
      <textarea
        id={id}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={autoFocus ? 3 : 5}
        maxLength={4000}
        required
        placeholder="What stayed with you?"
        aria-describedby={`${id}-hint`}
        autoFocus={autoFocus}
      />
      <div className="composer-foot">
        <div id={`${id}-hint`}>
          <SpoilerScope floor={floor} value={reveals} onChange={setReveals} />
          <SpoilerHint />
        </div>
        <div className="composer-actions">
          {onCancel && <button type="button" className="btn btn-quiet" onClick={onCancel}>Cancel</button>}
          <button type="submit" className="btn btn-primary" disabled={busy || !body.trim()}>
            {busy ? 'Posting…' : editId ? 'Save' : 'Reply'}
          </button>
        </div>
      </div>
      {error && <Notice tone="error">{error.message}</Notice>}
    </form>
  );
}
