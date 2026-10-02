import { useEffect, useState, type FormEvent } from 'react';
import { Link } from '../components/Link';
import { Notice } from '../components/Notice';
import { PublicationFooter } from '../components/PublicationFooter';
import { SpoilerHint } from '../components/forum/SpoilerHint';
import { SpoilerScope } from '../components/forum/SpoilerScope';
import { useReader } from '../lib/reader';
import { api, ApiFailure } from '../lib/api';
import { navigateTo } from '../lib/navigation';
import { latestPublishedNumber } from '../content/catalog';
import { chapterTag, tagLabel, type Category, type ForumIndex } from '../lib/forum';

/**
 * Starting a discussion. Reachable without opening a chapter, and never
 * attached to one: a discussion that is about a chapter carries its tag, the
 * same as any other tag.
 */
export function NewDiscussionPage() {
  const { account, accountStatus, accountMessage } = useReader();
  const [categories, setCategories] = useState<Category[]>();
  const [knownTags, setKnownTags] = useState<string[]>([]);
  const [form, setForm] = useState({ title: '', body: '', category: '', tags: '', scope: 1 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiFailure>();

  useEffect(() => {
    api<ForumIndex>('GET', '/api/forum')
      .then((data) => {
        setCategories(data.categories.filter((c) => c.slug !== 'chapter'));
        setKnownTags(data.tags.map((t) => t.tag));
        setForm((f) => ({ ...f, category: f.category || data.categories[0]?.slug || '' }));
      })
      // The form still works without suggestions: categories and tags are typed.
      .catch(() => setCategories([]));
  }, []);

  if (accountStatus === 'unavailable') {
    return (
      <>
        <main id="main" className="standalone page">
          <p className="meta-label">Community</p>
          <h1 className="standalone-title">The community is not connected yet.</h1>
          <Notice tone="quiet">{accountMessage} Reading is unaffected.</Notice>
          <Link className="btn btn-secondary" href="/community">Back to the community</Link>
        </main>
        <PublicationFooter />
      </>
    );
  }

  if (!account) {
    return (
      <>
        <main id="main" className="standalone page">
          <p className="meta-label">Community</p>
          <h1 className="standalone-title">Start a discussion.</h1>
          <p className="standalone-text">
            To take part, create an anonymous account. No email, no name, no password — you receive a single reader key
            that signs you in on any device, and a public pseudonym that is not derived from it.
          </p>
          <div className="library-cta">
            <Link className="btn btn-primary" href="/account">Create an anonymous account</Link>
            <Link className="btn btn-secondary" href="/community">Read first</Link>
          </div>
        </main>
        <PublicationFooter />
      </>
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const { id: created } = await api<{ id: string }>('POST', '/api/forum/threads', {
        title: form.title,
        body: form.body,
        category: form.category,
        tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
        revealsThrough: form.scope,
      });
      navigateTo(`/community/${created}`);
    } catch (err) {
      setError(err as ApiFailure);
      setBusy(false);
    }
  }

  const suggestions = [...new Set([...chapterTags(), ...knownTags])]
    .filter((tag) => !form.tags.split(',').map((t) => t.trim().toLowerCase()).includes(tag))
    .slice(0, 14);

  return (
    <>
      <main id="main" className="thread page">
        <Link className="back" href="/community">Back to the community</Link>
        <header className="discussion-head">
          <p className="meta-label">Community</p>
          <h1 className="discussion-title">Start a discussion</h1>
          <p className="discussion-scope">
            A theory, a question, a character, the world, a symbol you cannot shake, or simply something you wanted to say
            about the book. You are writing as {account.handle}.
          </p>
        </header>

        <form className="composer composer-new" onSubmit={submit}>
          <div className="field">
            <label className="meta-label" htmlFor="d-title">Title</label>
            <input
              id="d-title"
              type="text"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              minLength={4}
              maxLength={140}
              required
              placeholder="What is this about?"
              aria-describedby="d-title-hint"
            />
            <p id="d-title-hint" className="field-hint">A sentence, not a headline. Between 4 and 140 characters.</p>
          </div>

          <div className="field">
            <label className="meta-label" htmlFor="d-body">What you want to say</label>
            <textarea
              id="d-body"
              value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
              rows={9}
              maxLength={4000}
              required
              placeholder="Take your time."
              aria-describedby="d-body-hint"
            />
            <SpoilerHint id="d-body-hint" />
          </div>

          <div className="field-row">
            <div className="field">
              <label className="meta-label" htmlFor="d-category">Category</label>
              <select id="d-category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} required>
                {(categories ?? []).map((c) => (
                  <option key={c.slug} value={c.slug}>{c.name}</option>
                ))}
              </select>
              {categories?.find((c) => c.slug === form.category)?.description && (
                <p className="field-hint">{categories.find((c) => c.slug === form.category)?.description}</p>
              )}
            </div>
            <div className="field">
              <label className="meta-label" htmlFor="d-tags">Tags</label>
              <input
                id="d-tags"
                type="text"
                value={form.tags}
                onChange={(e) => setForm({ ...form, tags: e.target.value })}
                maxLength={200}
                placeholder="lore, kael"
                aria-describedby="d-tags-hint"
                list="d-tag-options"
              />
              <datalist id="d-tag-options">
                {suggestions.map((tag) => <option key={tag} value={tag} />)}
              </datalist>
              <p id="d-tags-hint" className="field-hint">Up to six, separated by commas. Use “Chapter 01” to tie it to a chapter.</p>
              {suggestions.length > 0 && (
                <p className="thread-tags">
                  {suggestions.slice(0, 8).map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      className="tag is-button"
                      onClick={() => setForm({ ...form, tags: form.tags ? `${form.tags}, ${tagLabel(tag)}` : tagLabel(tag) })}
                    >
                      {tagLabel(tag)}
                    </button>
                  ))}
                </p>
              )}
            </div>
          </div>

          <div className="field">
            <SpoilerScope floor={1} value={form.scope} onChange={(scope) => setForm({ ...form, scope })} />
            <p className="field-hint">
              Readers who have not finished that chapter will see this folded, and can open it if they choose.
            </p>
          </div>

          <div className="composer-actions">
            <Link className="btn btn-quiet" href="/community">Cancel</Link>
            <button type="submit" className="btn btn-primary" disabled={busy || !form.title.trim() || !form.body.trim()}>
              {busy ? 'Posting…' : 'Post the discussion'}
            </button>
          </div>
          {error && <Notice tone="error">{error.message}</Notice>}
        </form>
        <p className="field-hint">Up to chapter {String(latestPublishedNumber()).padStart(2, '0')} is published; nothing can be scoped past it.</p>
      </main>
      <PublicationFooter />
    </>
  );
}

/** Every published chapter, as a tag a reader can attach. */
function chapterTags(): string[] {
  return Array.from({ length: latestPublishedNumber() }, (_, i) => chapterTag(i + 1));
}
