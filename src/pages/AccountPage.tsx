import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { Link } from '../components/Link';
import { Icon } from '../components/Icon';
import { Notice } from '../components/Notice';
import { PublicationFooter } from '../components/PublicationFooter';
import { useReader, type SyncStatus } from '../lib/reader';
import { api, ApiFailure } from '../lib/api';
import { relativeTime } from '../lib/format';

const SYNC_TEXT: Record<SyncStatus, { title: string; text: string; tone: 'quiet' | 'caution' | 'error' }> = {
  local: { title: 'On this device', text: 'Reading state is stored in this browser only.', tone: 'quiet' },
  saving: { title: 'Syncing…', text: 'Encrypting and saving your reading state.', tone: 'quiet' },
  synced: { title: 'Synced', text: 'Your reading state is encrypted on this device and synchronised as ciphertext.', tone: 'quiet' },
  offline: { title: 'Offline', text: 'Changes are kept on this device and will sync when you reconnect.', tone: 'caution' },
  locked: { title: 'Key needed on this device', text: 'You are signed in, but this device does not hold your decryption key. Enter your reader key below to unlock encrypted sync.', tone: 'caution' },
  'crypto-error': { title: 'Your encrypted state could not be decrypted', text: 'The stored data did not authenticate with this key, so nothing was applied. Your local reading state is untouched. Try entering your reader key again.', tone: 'error' },
  error: { title: 'Sync paused', text: 'The server could not be reached reliably. Your reading continues locally and will sync later.', tone: 'caution' },
};

export function AccountPage() {
  const { account, accountStatus, accountMessage } = useReader();
  const [newKey, setNewKey] = useState<string>();

  return (
    <>
      <main id="main" className="account page">
        <p className="meta-label">Account</p>
        {newKey ? (
          <KeyReveal readerKey={newKey} onDone={() => setNewKey(undefined)} />
        ) : accountStatus === 'loading' ? (
          <p className="meta loading">Checking this device…</p>
        ) : accountStatus === 'unavailable' ? (
          <>
            <h1 className="standalone-title">Accounts are not connected yet.</h1>
            <Notice tone="quiet">{accountMessage} Your reading position and preferences are still kept in this browser.</Notice>
          </>
        ) : account ? (
          <SignedIn />
        ) : (
          <SignedOut onCreated={setNewKey} />
        )}
        <Principles />
      </main>
      <PublicationFooter />
    </>
  );
}

function SignedOut({ onCreated }: { onCreated: (key: string) => void }) {
  const { createAccount, signIn } = useReader();
  const [busy, setBusy] = useState<'create' | 'signin'>();
  const [error, setError] = useState<string>();
  const [key, setKey] = useState('');
  const id = useId();

  async function create() {
    setBusy('create');
    setError(undefined);
    try {
      onCreated(await createAccount());
    } catch (e) {
      setError((e as ApiFailure).message);
    } finally {
      setBusy(undefined);
    }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy('signin');
    setError(undefined);
    try {
      await signIn(key);
      setKey('');
    } catch (err) {
      setError((err as ApiFailure).message);
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <>
      <h1 className="standalone-title">Read anonymously, anywhere.</h1>
      <p className="standalone-text">
        An account here is a single random reader key. There is no name, email, phone number or password. The key signs you in on
        other devices and unlocks your encrypted reading state; your public name in discussions is a separate generated pseudonym.
      </p>
      <div className="account-paths">
        <section aria-labelledby={`${id}-new`}>
          <h2 id={`${id}-new`} className="path-title">New here</h2>
          <p>We generate a key in your browser. You save it; we never see it.</p>
          <button type="button" className="btn btn-primary" onClick={create} disabled={Boolean(busy)}>
            {busy === 'create' ? 'Creating…' : 'Create an anonymous account'}
          </button>
        </section>
        <section aria-labelledby={`${id}-have`}>
          <h2 id={`${id}-have`} className="path-title">I have a reader key</h2>
          <form onSubmit={submit} className="key-form">
            <label htmlFor={`${id}-key`} className="visually-hidden">Reader key</label>
            <input id={`${id}-key`} type="password" autoComplete="off" spellCheck={false} autoCapitalize="off" value={key}
              onChange={(e) => setKey(e.target.value)} placeholder="dusk1-…" required />
            <button type="submit" className="btn btn-secondary" disabled={Boolean(busy) || !key.trim()}>{busy === 'signin' ? 'Opening…' : 'Continue on this device'}</button>
          </form>
        </section>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
    </>
  );
}

function KeyReveal({ readerKey, onDone }: { readerKey: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const { account } = useReader();
  const id = useId();

  async function copy() {
    try {
      await navigator.clipboard.writeText(readerKey);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  function download() {
    const blob = new Blob([`Dusk Shingle reader key\n\n${readerKey}\n\nAnyone with this key can use your account. It cannot be recovered if lost.\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'dusk-shingle-reader-key.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="key-reveal" aria-labelledby={`${id}-t`}>
      <h1 id={`${id}-t`} className="standalone-title">Save your reader key.</h1>
      <p className="standalone-text">You are <strong>{account?.handle}</strong> in discussions. This key is the only way back into this account.</p>
      <div className="key-box">
        <code aria-label="Your reader key">{readerKey}</code>
        <div className="key-actions">
          <button type="button" className="btn btn-secondary" onClick={copy}><Icon name="copy" />{copied ? 'Copied' : 'Copy'}</button>
          <button type="button" className="btn btn-secondary" onClick={download}>Download as text file</button>
        </div>
      </div>
      <Notice tone="caution" title="It cannot be recovered.">
        We keep no email or identity to reset it with, and the server only holds a one-way hash. If you lose the key and sign out
        (or clear this browser), the account and its encrypted reading state are gone for good. Anyone who has the key can use the account — keep it
        somewhere private, like a password manager.
      </Notice>
      <label className="check">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        I have saved my reader key somewhere safe.
      </label>
      <button type="button" className="btn btn-primary" disabled={!confirmed} onClick={onDone}>Continue</button>
    </section>
  );
}

type Notifications = {
  replies: { id: string; discussionId: string; title: string | null; author: string | null; createdAt: string; unread: boolean }[];
  moderated: { id: string; discussionId: string | null; title: string | null; state: string }[];
};

function SignedIn() {
  const { account, sync, syncNow, signOut, deleteAccount, signIn, setUnreadReplies } = useReader();
  const [notes, setNotes] = useState<Notifications>();
  const [notesError, setNotesError] = useState<string | null>(null);
  const [phrase, setPhrase] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string>();
  const [unlockKey, setUnlockKey] = useState('');
  const id = useId();
  const status = SYNC_TEXT[sync];

  const loadNotes = useCallback(() => {
    setNotes(undefined);
    setNotesError(null);
    api<Notifications>('GET', '/api/notifications')
      .then((n) => {
        setNotes(n);
        if (n.replies.some((r) => r.unread)) {
          void api('POST', '/api/notifications/seen').then(() => setUnreadReplies(0));
        }
      })
      // Without this the section stays on "Loading…" for good after a failed
      // fetch, with no way to tell it failed or to try again.
      .catch((e: ApiFailure) => setNotesError(e.message));
  }, [setUnreadReplies]);

  useEffect(loadNotes, [loadNotes]);

  return (
    <>
      <h1 className="standalone-title handle">{account!.handle}</h1>
      <p className="standalone-text">Your public pseudonym. It was generated at random and is not derived from your key.</p>

      <section className="account-section" aria-labelledby={`${id}-sync`}>
        <h2 id={`${id}-sync`} className="meta-label">Reading state</h2>
        <Notice tone={status.tone} title={status.title} action={sync !== 'saving' && sync !== 'locked' ? <button type="button" className="btn btn-quiet" onClick={() => void syncNow()}>Sync now</button> : undefined}>
          {status.text}
        </Notice>
        {(sync === 'locked' || sync === 'crypto-error') && (
          <form className="key-form" onSubmit={async (e) => {
            e.preventDefault();
            setError(undefined);
            try {
              await signIn(unlockKey);
              setUnlockKey('');
            } catch (err) {
              setError((err as ApiFailure).message);
            }
          }}>
            <label htmlFor={`${id}-unlock`} className="visually-hidden">Reader key</label>
            <input id={`${id}-unlock`} type="password" autoComplete="off" spellCheck={false} value={unlockKey} onChange={(e) => setUnlockKey(e.target.value)} placeholder="dusk1-…" />
            <button className="btn btn-secondary" type="submit">Unlock</button>
          </form>
        )}
        <p className="field-hint"><Icon name="lock" size={13} /> Synchronised: chapter positions, completion, private notes and appearance settings — encrypted with a key only your devices hold.</p>
      </section>

      <section className="account-section" aria-labelledby={`${id}-n`}>
        <h2 id={`${id}-n`} className="meta-label">Replies to you</h2>
        {notesError ? (
          <Notice tone="quiet" title="Replies could not be loaded" action={<button type="button" className="btn btn-quiet" onClick={loadNotes}>Try again</button>}>
            {notesError}
          </Notice>
        ) : !notes ? <p className="meta loading">Loading…</p> : notes.replies.length === 0 && notes.moderated.length === 0 ? (
          <p>Nothing new. You are only notified of direct replies and moderation of your own posts.</p>
        ) : (
          <ul className="plain-list">
            {notes.moderated.map((m) => (
              <li key={m.id}>
                <Link href={m.discussionId ? `/community/${m.discussionId}` : '/community'}>
                  {m.title ? `“${m.title}”` : 'A discussion you wrote'} is {m.state === 'removed' ? 'removed by moderators' : 'hidden pending review'}
                </Link>
              </li>
            ))}
            {notes.replies.map((r) => (
              <li key={r.id} data-unread={r.unread || undefined}>
                <Link href={`/community/${r.discussionId}`}>{r.author ?? 'A reader'} replied in “{r.title ?? 'a discussion'}”</Link>
                <span className="meta"> · {relativeTime(r.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="account-section" aria-labelledby={`${id}-dev`}>
        <h2 id={`${id}-dev`} className="meta-label">Devices</h2>
        <p>To continue on another device, open this page there and enter your reader key. Your key is not shown again here — it is never stored by this site.</p>
        <div className="row-actions">
          <button type="button" className="btn btn-secondary" onClick={() => void signOut()}>Sign out of this device</button>
          <button type="button" className="btn btn-quiet" onClick={() => void signOut(true)}>Sign out everywhere</button>
        </div>
        <p className="field-hint">Signing out removes your reading state and decryption key from this browser. You will need your reader key to return.</p>
      </section>

      <section className="account-section danger-zone" aria-labelledby={`${id}-del`}>
        <h2 id={`${id}-del`} className="meta-label">Delete account</h2>
        <p>
          Permanently deletes your account, pseudonym, sessions, encrypted reading state, marks and reports. Your discussions
          and replies are deleted; where others have replied, your post is replaced by “deleted by its author” with no name
          attached, so their replies keep their place.
        </p>
        <form onSubmit={async (e) => {
          e.preventDefault();
          setDeleting(true);
          setError(undefined);
          try {
            await deleteAccount(phrase);
          } catch (err) {
            setError((err as ApiFailure).message);
            setDeleting(false);
          }
        }}>
          <label htmlFor={`${id}-phrase`}>Type <strong>delete my account</strong> to confirm.</label>
          <div className="key-form">
            <input id={`${id}-phrase`} type="text" autoComplete="off" value={phrase} onChange={(e) => setPhrase(e.target.value)} />
            <button type="submit" className="btn btn-danger" disabled={phrase !== 'delete my account' || deleting}>{deleting ? 'Deleting…' : 'Delete permanently'}</button>
          </div>
        </form>
      </section>
      {account!.role === 'moderator' && <p><Link href="/moderation">Moderation queue</Link></p>}
      {error && <Notice tone="error">{error}</Notice>}
    </>
  );
}

function Principles() {
  return (
    <section className="principles" aria-labelledby="principles-title">
      <h2 id="principles-title" className="meta-label">How this works</h2>
      <dl>
        <dt>What the server knows</dt>
        <dd>A one-way hash of a value derived from your key, your generated pseudonym, your public posts, and an encrypted blob it cannot read.</dd>
        <dt>What only your devices know</dt>
        <dd>Your reader key, and the key that decrypts your reading positions, private notes and settings.</dd>
        <dt>What is public</dt>
        <dd>Your discussions and replies are public and are not end-to-end encrypted — the server must read them to show and moderate them.</dd>
        <dt>What is not collected</dt>
        <dd>No email, phone, name, contacts, analytics, trackers or advertising identifiers.</dd>
      </dl>
    </section>
  );
}
