/* eslint-disable @typescript-eslint/no-explicit-any -- test assertions over untyped JSON responses */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applySchema, type Db } from './db.js';
import { createPgliteDb } from './pglite.js';
import { handle } from './router.js';
import type { ApiRequest } from './http.js';
import { deriveKeys, encryptJson, generateDataKey, generateReaderKey, unwrapDataKey, wrapDataKey, decryptJson } from '../src/lib/crypto.js';

let db: Db;
let ipCounter = 0;

beforeAll(() => {
  // Set the real key material the deployment uses. Without this the suite would
  // pass on a per-process fallback and never notice that the IP rate limits are
  // silently reset on every cold start.
  process.env.RATE_LIMIT_SECRET = 'test-only-rate-limit-secret-0123456789abcdef';
});

beforeEach(async () => {
  db = await createPgliteDb();
});

type Client = { cookie?: string; ip: string };
const newClient = (): Client => ({ ip: `10.0.0.${++ipCounter}` });

async function call(client: Client, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const [route, search = ''] = path.split('?');
  const req: ApiRequest = {
    method, path: route, body, ip: client.ip,
    query: Object.fromEntries(new URLSearchParams(search)),
    headers: { host: 'reader.test', 'x-dusk-client': '1', cookie: client.cookie, ...extra },
  };
  const res = await handle(req, () => Promise.resolve(db));
  const set = res.cookies?.[0];
  if (set) client.cookie = set.split(';')[0].endsWith('=') ? undefined : set.split(';')[0];
  return res as { status: number; body: any; cookies?: string[] };
}

async function signUp(client = newClient()) {
  const readerKey = generateReaderKey();
  const { authKey } = await deriveKeys(readerKey);
  const res = await call(client, 'POST', '/api/account', { authKey });
  expect(res.status).toBe(201);
  return { client, readerKey, handle: res.body.handle as string };
}

/** Backdate an account past the new-reader window so it gets the full budget. */
async function established(handle: string) {
  await db.query(`UPDATE accounts SET created_at = now() - interval '1 day' WHERE handle = $1`, [handle]);
}

/** Open a discussion, spending the rate-limit budget so tests can post freely. */
async function thread(client: Client, over: Record<string, unknown> = {}) {
  const res = await call(client, 'POST', '/api/forum/threads', {
    title: 'A theory worth having', body: 'I think the pump was never the point.', category: 'theories', ...over,
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe('anonymous accounts', () => {
  it('creates an account from a client-derived auth key with no identity fields', async () => {
    const { client, handle } = await signUp();
    expect(handle).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ \d{3}$/);
    const me = await call(client, 'GET', '/api/me');
    expect(me.body.account).toEqual({ handle, role: 'reader' });
    const cols = await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'accounts'`);
    expect(cols.rows.map((c) => c.column_name).sort()).toEqual(['auth_hash', 'created_at', 'handle', 'id', 'replies_seen_at', 'role']);
  });

  it('never stores the reader key, the auth key, or the session secret in plaintext', async () => {
    const { client, readerKey } = await signUp();
    const { authKey } = await deriveKeys(readerKey);
    const dump = JSON.stringify((await db.query(`SELECT * FROM accounts`)).rows) + JSON.stringify((await db.query(`SELECT * FROM sessions`)).rows);
    const hex = (s: string) => Buffer.from(s).toString('hex');
    for (const secret of [readerKey, authKey, client.cookie!.split('=')[1]]) {
      expect(dump).not.toContain(secret);
      expect(dump).not.toContain(hex(secret));
    }
  });

  it('issues an HttpOnly, SameSite=Strict, Secure __Host- cookie over HTTPS', async () => {
    const { authKey } = await deriveKeys(generateReaderKey());
    const res = await call(newClient(), 'POST', '/api/account', { authKey }, { 'x-forwarded-proto': 'https' });
    const cookie = res.cookies![0];
    expect(cookie).toMatch(/^__Host-dusk_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/);
    expect(JSON.stringify(res.body)).not.toContain(cookie.split(';')[0].split('=')[1]);
  });

  it('enforces credential uniqueness at the database level', async () => {
    const { authKey } = await deriveKeys(generateReaderKey());
    expect((await call(newClient(), 'POST', '/api/account', { authKey })).status).toBe(201);
    const again = await call(newClient(), 'POST', '/api/account', { authKey });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('key_collision');
    await expect(db.query(`INSERT INTO accounts (id, auth_hash, handle) SELECT gen_random_uuid(), auth_hash, 'x' FROM accounts LIMIT 1`)).rejects.toThrow();
  });

  it('signs in on a second device with the reader key, and rejects unknown keys generically', async () => {
    const { readerKey, handle } = await signUp();
    const device2 = newClient();
    const res = await call(device2, 'POST', '/api/session', { authKey: (await deriveKeys(readerKey)).authKey });
    expect(res.status).toBe(200);
    expect(res.body.handle).toBe(handle);
    const bad = await call(newClient(), 'POST', '/api/session', { authKey: (await deriveKeys(generateReaderKey())).authKey });
    expect(bad.status).toBe(401);
    expect((await call(newClient(), 'POST', '/api/session', { authKey: 'nope' })).status).toBe(401);
  });

  it('signs out, and signing out everywhere revokes other devices', async () => {
    const { client, readerKey } = await signUp();
    const other = newClient();
    await call(other, 'POST', '/api/session', { authKey: (await deriveKeys(readerKey)).authKey });
    await call(client, 'DELETE', '/api/sessions');
    expect((await call(other, 'GET', '/api/me')).body.account).toBeNull();
  });

  it('rate-limits account creation per network bucket', async () => {
    const c = newClient();
    const statuses = [];
    for (let i = 0; i < 7; i++) statuses.push((await call({ ip: c.ip }, 'POST', '/api/account', { authKey: (await deriveKeys(generateReaderKey())).authKey })).status);
    expect(statuses.slice(0, 5).every((s) => s === 201)).toBe(true);
    expect(statuses.slice(5)).toEqual([429, 429]);
    const buckets = JSON.stringify((await db.query(`SELECT bucket FROM rate_events`)).rows);
    expect(buckets).not.toContain(c.ip);
  });

  it('refuses IP rate limits when RATE_LIMIT_SECRET is missing instead of using unstable key material', async () => {
    const { authKey } = await deriveKeys(generateReaderKey());
    const saved = process.env.RATE_LIMIT_SECRET;
    delete process.env.RATE_LIMIT_SECRET;
    try {
      const res = await call(newClient(), 'POST', '/api/account', { authKey });
      // Fails closed: a silently-resetting limit is worse than a visible outage.
      expect(res.status).toBe(500);
      // Authenticated per-account limits do not use this secret, so the rest of
      // the product keeps working.
      const { client } = { client: newClient() };
      process.env.RATE_LIMIT_SECRET = saved;
      const signIn = await call(client, 'POST', '/api/session', { authKey });
      expect([401, 429]).toContain(signIn.status);
    } finally {
      process.env.RATE_LIMIT_SECRET = saved;
    }
  });

  it('logs why the database is unavailable without leaking credentials', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    // Entirely synthetic, and on the reserved .invalid TLD (RFC 2606) so it can
    // never name a real host. The point is to prove a realistic driver message is
    // reduced to something safe before it reaches a log.
    const connectionFailure = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'XX000',
      message:
        'connect ECONNREFUSED: postgres://dusk:not-a-real-password@db.invalid:5432/app?sslmode=require ' +
        'password=not-a-real-password user=dusk',
    });
    try {
      const res = await handle(
        { method: 'GET', path: '/api/health', body: undefined, ip: '1', headers: { host: 'reader.test' } },
        () => Promise.reject(connectionFailure),
      );
      expect(res.status).toBe(503);
    } finally {
      spy.mockRestore();
    }
    const output = logged.join('\n');
    // Diagnosable: the driver code and the server's own wording must survive.
    expect(output).toContain('XX000');
    expect(output).toContain('ECONNREFUSED');
    // Not recoverable from the logs by anyone. The scheme is left as a marker;
    // everything after it must be gone.
    expect(output).not.toContain('not-a-real-password');
    expect(output).not.toContain('db.invalid');
    expect(output).not.toContain('user=dusk');
    expect(output).toContain('postgres://[redacted]');
  });

  it('blocks state-changing requests without the client header or from another origin (CSRF)', async () => {
    const { authKey } = await deriveKeys(generateReaderKey());
    const res1 = await handle({ method: 'POST', path: '/api/account', body: { authKey }, ip: '1', headers: { host: 'reader.test' } }, () => Promise.resolve(db));
    expect(res1.status).toBe(403);
    const res2 = await call(newClient(), 'POST', '/api/account', { authKey }, { origin: 'https://evil.example' });
    expect(res2.status).toBe(403);
  });

  it('degrades honestly when no database is configured', async () => {
    const res = await handle({ method: 'GET', path: '/api/me', body: undefined, ip: '1', headers: {} }, () => undefined);
    expect(res.status).toBe(503);
    expect((res.body as any).error.code).toBe('not_configured');
  });
});

describe('end-to-end encrypted vault', () => {
  it('stores only ciphertext and syncs across devices; the server cannot decrypt', async () => {
    const { client, readerKey } = await signUp();
    const { kek } = await deriveKeys(readerKey);
    const dek = await generateDataKey();
    const secretNote = 'the pump was never the problem';
    const put = await call(client, 'PUT', '/api/vault', {
      baseVersion: 0, wrappedKey: await wrapDataKey(dek, kek), ciphertext: await encryptJson(dek, { note: secretNote }),
    });
    expect(put.body.version).toBe(1);

    const stored = JSON.stringify((await db.query(`SELECT * FROM vaults`)).rows);
    expect(stored).not.toContain(secretNote);
    expect(stored).not.toContain('pump');

    // Device 2: only the reader key is transferred.
    const device2 = newClient();
    await call(device2, 'POST', '/api/session', { authKey: (await deriveKeys(readerKey)).authKey });
    const got = (await call(device2, 'GET', '/api/vault')).body.vault;
    const dek2 = await unwrapDataKey(got.wrappedKey, (await deriveKeys(readerKey)).kek);
    expect(await decryptJson(dek2, got.ciphertext)).toEqual({ note: secretNote });

    // Anything the server holds (auth hash, wrapped key) is insufficient: a different key fails.
    await expect(unwrapDataKey(got.wrappedKey, (await deriveKeys(generateReaderKey())).kek)).rejects.toThrow();
  });

  it('rejects stale writes with 409 and returns the current vault for merging', async () => {
    const { client, readerKey } = await signUp();
    const { kek } = await deriveKeys(readerKey);
    const dek = await generateDataKey();
    const wrappedKey = await wrapDataKey(dek, kek);
    await call(client, 'PUT', '/api/vault', { baseVersion: 0, wrappedKey, ciphertext: await encryptJson(dek, 1) });
    await call(client, 'PUT', '/api/vault', { baseVersion: 1, wrappedKey, ciphertext: await encryptJson(dek, 2) });
    const stale = await call(client, 'PUT', '/api/vault', { baseVersion: 1, wrappedKey, ciphertext: await encryptJson(dek, 3) });
    expect(stale.status).toBe(409);
    expect(stale.body.error.vault.version).toBe(2);
    expect(await decryptJson(dek, stale.body.error.vault.ciphertext)).toBe(2);
    const second = await call(client, 'PUT', '/api/vault', { baseVersion: 0, wrappedKey, ciphertext: await encryptJson(dek, 4) });
    expect(second.status).toBe(409);
  });

  it('validates vault payloads and isolates vaults between accounts', async () => {
    const a = await signUp();
    const b = await signUp();
    expect((await call(a.client, 'PUT', '/api/vault', { baseVersion: 0, wrappedKey: '<x>', ciphertext: 'y' })).status).toBe(400);
    expect((await call(a.client, 'PUT', '/api/vault', { baseVersion: 0, wrappedKey: 'abc', ciphertext: 'a'.repeat(95000) })).status).toBe(400);
    await call(a.client, 'PUT', '/api/vault', { baseVersion: 0, wrappedKey: 'abc', ciphertext: 'def' });
    expect((await call(b.client, 'GET', '/api/vault')).body.vault).toBeNull();
    expect((await call(newClient(), 'GET', '/api/vault')).status).toBe(401);
  });
});

describe('community discussions', () => {
  it('starts a discussion with no chapter at all, under a category and tags', async () => {
    const { client, handle } = await signUp();
    const id = await thread(client, { title: 'What does the horizon mean?', category: 'general', tags: ['Symbolism', 'lore', 'symbolism'] });

    const view = (await call(client, 'GET', `/api/forum/threads/${id}`)).body;
    expect(view.thread).toMatchObject({
      id, scope: 'community', chapterSlug: null, chapterNumber: null,
      category: 'general', title: 'What does the horizon mean?', author: handle, status: 'visible',
    });
    // Tags are normalised to one canonical, URL-safe value each.
    expect(view.thread.tags).toEqual(['symbolism', 'lore']);
    expect(view.thread.body).toBe('I think the pump was never the point.');
    expect(view.thread.revealsThrough).toBe(1);
  });

  it('exposes a reader-friendly index: categories, chapter rooms, latest and active', async () => {
    const a = await signUp();
    const b = await signUp();
    const quiet = await thread(a.client, { title: 'Nobody will answer this', category: 'questions' });
    const busy = await thread(b.client, { title: 'Kael and the ledger', category: 'characters' });
    await call(a.client, 'POST', `/api/forum/threads/${busy}/comments`, { body: 'Yes.' });
    await call(b.client, 'POST', `/api/forum/threads/${busy}/comments`, { body: 'And again.' });

    const index = (await call(newClient(), 'GET', '/api/forum')).body;
    expect(index.categories.map((c: any) => c.slug)).toEqual(
      expect.arrayContaining(['general', 'theories', 'characters', 'worldbuilding', 'questions', 'feedback', 'chapter']),
    );
    expect(index.categories.find((c: any) => c.slug === 'characters').discussions).toBe(1);
    // Latest is by creation; active requires replies and ranks by how many.
    expect(index.latest.map((t: any) => t.id)).toEqual([busy, quiet]);
    expect(index.active.map((t: any) => t.id)).toEqual([busy]);
    // An index entry is a summary: it must not carry the body, which would push
    // unmarked spoilers past the chapter gate.
    expect(JSON.stringify(index.latest)).not.toContain('never the point');
    expect(index.chapterRooms).toEqual([
      expect.objectContaining({ slug: 'the-dry-pump', number: 1, id: null, discussions: 0, replies: 0 }),
    ]);
    expect(index.total).toBe(2);
  });

  it('filters and searches: category, tag, scope, free text, and pagination', async () => {
    const a = await signUp();
    await established(a.handle);
    const t1 = await thread(a.client, { title: 'On the dry pump', body: 'The pump is a ledger.', category: 'worldbuilding', tags: ['Chapter 01'] });
    const t2 = await thread(a.client, { title: 'Kael’s ledger', body: 'Kael keeps two sets of numbers.', category: 'characters', tags: ['kael'] });

    const byCategory = (await call(a.client, 'GET', '/api/forum/threads?category=worldbuilding')).body;
    expect(byCategory.threads.map((t: any) => t.id)).toEqual([t1]);
    const byTag = (await call(a.client, 'GET', '/api/forum/threads?tag=kael')).body;
    expect(byTag.threads.map((t: any) => t.id)).toEqual([t2]);
    const byChapterTag = (await call(a.client, 'GET', '/api/forum/threads?tag=chapter-01')).body;
    expect(byChapterTag.threads.map((t: any) => t.id)).toEqual([t1]);
    // Free text reaches the title and the body alike.
    const byTitle = (await call(a.client, 'GET', '/api/forum/threads?q=kael')).body;
    expect(byTitle.threads.map((t: any) => t.id)).toEqual([t2]);
    const byBody = (await call(a.client, 'GET', '/api/forum/threads?q=pump+is+a')).body;
    expect(byBody.threads.map((t: any) => t.id)).toEqual([t1]);
    // Search terms are bounded, and a filter that matches nothing is empty, not an error.
    expect((await call(a.client, 'GET', `/api/forum/threads?q=${'x'.repeat(200)}`)).status).toBe(200);
    expect((await call(a.client, 'GET', '/api/forum/threads?q=nothingmatchesthis')).body.threads).toEqual([]);
    const byScope = (await call(a.client, 'GET', '/api/forum/threads?scope=community')).body;
    expect(byScope.threads).toHaveLength(2);
    const paged = (await call(a.client, 'GET', '/api/forum/threads?limit=1')).body;
    expect(paged.threads).toHaveLength(1);
    expect(paged.hasMore).toBe(true);
    const second = (await call(a.client, 'GET', '/api/forum/threads?limit=1&offset=1')).body;
    expect(second.threads[0].id).not.toBe(paged.threads[0].id);
  });

  it('validates the discussion itself: title, body, links, category and duplicates', async () => {
    const { client, handle } = await signUp();
    await established(handle);
    const post = (over: Record<string, unknown>) => call(client, 'POST', '/api/forum/threads', {
      title: 'A perfectly good title', body: 'Something to say.', category: 'general', ...over,
    });
    expect((await post({ title: 'no' })).status).toBe(400);
    expect((await post({ title: '' })).status).toBe(400);
    expect((await post({ title: 'x'.repeat(200) })).status).toBe(400);
    expect((await post({ body: '   ' })).status).toBe(400);
    expect((await post({ body: 'x'.repeat(4001) })).status).toBe(400);
    expect((await post({ body: 'http://a http://b http://c' })).status).toBe(400);
    expect((await post({ category: 'not-a-category' })).status).toBe(400);
    expect((await post({ category: undefined })).status).toBe(400);
    expect((await post({ tags: 'not-an-array' })).status).toBe(400);
    // Duplicate detection is by body, exactly as it was for comments.
    expect((await post({})).status).toBe(201);
    expect((await post({ title: 'A different title' })).status).toBe(409);
    expect((await call(newClient(), 'POST', '/api/forum/threads', { title: 'Anonymous attempt', body: 'hi', category: 'general' })).status).toBe(401);
  });

  it('stores content verbatim as text for escaped rendering and strips control characters', async () => {
    const { client } = await signUp();
    const id = await thread(client, { body: '<img src=x onerror=alert(1)>\u202E\u0000 hi' });
    expect((await call(client, 'GET', `/api/forum/threads/${id}`)).body.thread.body).toBe('<img src=x onerror=alert(1)> hi');
  });

  it('enforces spoiler scope server-side: nothing may claim an unpublished or earlier chapter', async () => {
    const { client } = await signUp();
    const post = (over: Record<string, unknown>) => call(client, 'POST', '/api/forum/threads', {
      title: 'A perfectly good title', body: 'Something to say.', category: 'theories', ...over,
    });
    expect((await post({ revealsThrough: 2 })).status).toBe(400);
    expect((await post({ revealsThrough: 0 })).status).toBe(400);
    expect((await post({ revealsThrough: '1' })).status).toBe(400);
    expect((await post({ body: 'Hidden ||he sent the logs|| part' })).status).toBe(201);
    const listed = (await call(client, 'GET', '/api/forum/threads?category=theories')).body.threads[0];
    expect(listed).toMatchObject({ revealsThrough: 1, hasSpoiler: true });
  });

  it('replies are threaded one level under the discussion, by pseudonym only', async () => {
    const alice = await signUp();
    const bob = await signUp();
    const id = await thread(alice.client, { title: 'Something to argue about' });
    const reply = await call(bob.client, 'POST', `/api/forum/threads/${id}/comments`, { body: 'I disagree.' });
    expect(reply.status).toBe(201);
    const nested = await call(alice.client, 'POST', `/api/forum/threads/${id}/comments`, { body: 'And I.', parentId: reply.body.id });
    expect(nested.status).toBe(201);
    // A reply to a reply lands on the discussion: threads are one level deep.
    const view = (await call(newClient(), 'GET', `/api/forum/threads/${id}`)).body;
    expect(view.replies.map((r: any) => r.parentId)).toEqual([id, id]);
    expect(view.thread.replies).toBe(2);
    const text = JSON.stringify(view);
    expect(text).toContain(bob.handle);
    expect(text).not.toMatch(/account_?id|auth_?(hash|key)/i);
  });

  it('rejects replies to a discussion that cannot take them', async () => {
    const alice = await signUp();
    const bob = await signUp();
    const id = await thread(alice.client);
    await call(alice.client, 'DELETE', `/api/forum/threads/${id}`);
    expect((await call(bob.client, 'POST', `/api/forum/threads/${id}/comments`, { body: 'ghost' })).status).toBe(404);
    expect((await call(bob.client, 'POST', '/api/forum/threads/not-a-uuid/comments', { body: 'x' })).status).toBe(404);
    expect((await call(bob.client, 'POST', '/api/forum/threads/00000000-0000-4000-8000-000000000000/comments', { body: 'x' })).status).toBe(404);
  });

  it('only lets authors edit or delete their own posts, and never edits a discussion through the reply route', async () => {
    const alice = await signUp();
    const bob = await signUp();
    const id = await thread(alice.client, { title: 'The original title' });
    const bobReply = (await call(bob.client, 'POST', `/api/forum/threads/${id}/comments`, { body: 'bob was here first' })).body.id;

    expect((await call(bob.client, 'PATCH', `/api/forum/threads/${id}`, { title: 'Hijacked', body: 'x' })).status).toBe(403);
    expect((await call(bob.client, 'DELETE', `/api/forum/threads/${id}`)).status).toBe(403);
    expect((await call(alice.client, 'PATCH', `/api/comments/${bobReply}`, { body: 'hijack' })).status).toBe(403);
    expect((await call(alice.client, 'DELETE', `/api/comments/${bobReply}`)).status).toBe(403);
    // Someone else's post is refused before anything about it is revealed.
    expect((await call(bob.client, 'PATCH', `/api/comments/${id}`, { body: 'via the wrong route' })).status).toBe(403);
    // A discussion is edited through its own route; a reply is not.
    expect((await call(alice.client, 'PATCH', `/api/comments/${id}`, { body: 'via the wrong route' })).status).toBe(400);
    expect((await call(alice.client, 'DELETE', `/api/comments/${id}`)).status).toBe(400);

    const edit = await call(alice.client, 'PATCH', `/api/forum/threads/${id}`, {
      title: 'The revised title', body: 'Revised body.', category: 'questions', tags: ['Revised'], revealsThrough: 1,
    });
    expect(edit.status).toBe(200);
    const view = (await call(bob.client, 'GET', `/api/forum/threads/${id}`)).body.thread;
    expect(view).toMatchObject({ title: 'The revised title', body: 'Revised body.', category: 'questions', tags: ['revised'] });
    expect(view.editedAt).toBeTruthy();
    expect(view.mine).toBe(false);
  });

  it('tombstones a discussion that has replies and removes it once the thread empties', async () => {
    const alice = await signUp();
    const bob = await signUp();
    const id = await thread(alice.client, { title: 'A doomed discussion' });
    const reply = (await call(bob.client, 'POST', `/api/forum/threads/${id}/comments`, { body: 'child' })).body.id;
    await call(alice.client, 'DELETE', `/api/forum/threads/${id}`);

    const view = (await call(bob.client, 'GET', `/api/forum/threads/${id}`)).body.thread;
    expect(view).toMatchObject({ status: 'deleted', body: '', author: null, title: 'A doomed discussion' });
    // A tombstoned discussion leaves the index; its replies stay put.
    expect((await call(bob.client, 'GET', '/api/forum/threads')).body.threads).toHaveLength(0);

    await call(bob.client, 'DELETE', `/api/comments/${reply}`);
    const gone = await call(bob.client, 'GET', `/api/forum/threads/${id}`);
    expect(gone.status).toBe(404);
  });

  it('allows one quiet reaction per reader, never on your own post', async () => {
    const alice = await signUp();
    const bob = await signUp();
    const id = await thread(alice.client, { title: 'Worth marking' });
    const bobReply = (await call(bob.client, 'POST', `/api/forum/threads/${id}/comments`, { body: 'Worth marking too' })).body.id;
    // The discussion and its replies are marked by the same route and the same rule.
    expect((await call(alice.client, 'PUT', `/api/comments/${id}/reaction`)).status).toBe(400);
    expect((await call(bob.client, 'PUT', `/api/comments/${bobReply}/reaction`)).status).toBe(400);

    await call(alice.client, 'PUT', `/api/comments/${bobReply}/reaction`);
    await call(alice.client, 'PUT', `/api/comments/${bobReply}/reaction`);
    await call(bob.client, 'PUT', `/api/comments/${id}/reaction`);
    let view = (await call(alice.client, 'GET', `/api/forum/threads/${id}`)).body;
    expect(view.thread.reactions).toBe(1);
    expect(view.replies[0]).toMatchObject({ reactions: 1, reacted: true });

    await call(alice.client, 'DELETE', `/api/comments/${bobReply}/reaction`);
    view = (await call(alice.client, 'GET', `/api/forum/threads/${id}`)).body;
    expect(view.replies[0].reactions).toBe(0);
  });

  it('rate-limits starting discussions more tightly than replying', async () => {
    const { client } = await signUp();
    const id = await thread(client, { title: 'The first one' });
    // A brand-new account may start 1 discussion and post 2 replies per 10 minutes.
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await call(client, 'POST', '/api/forum/threads', { title: `Another ${i}`, body: `Body ${i}`, category: 'general' })).status);
    }
    expect(statuses).toEqual([429, 429, 429]);
    // Being told to slow down on discussions does not also cost a reply.
    expect((await call(client, 'POST', `/api/forum/threads/${id}/comments`, { body: 'still allowed' })).status).toBe(201);
  });

  it('notifies authors of replies, by discussion, and marks them seen', async () => {
    const alice = await signUp();
    const bob = await signUp();
    const id = await thread(alice.client, { title: 'A discussion worth watching' });
    await call(bob.client, 'POST', `/api/forum/threads/${id}/comments`, { body: 'reply' });
    let n = (await call(alice.client, 'GET', '/api/notifications')).body;
    expect(n.replies).toHaveLength(1);
    expect(n.replies[0]).toMatchObject({ discussionId: id, title: 'A discussion worth watching', author: bob.handle, unread: true });
    await call(alice.client, 'POST', '/api/notifications/seen');
    n = (await call(alice.client, 'GET', '/api/notifications')).body;
    expect(n.replies[0].unread).toBe(false);
  });
});

describe('chapter discussions', () => {
  const slug = 'the-dry-pump';

  it('reports an unopened chapter as a room that does not exist yet', async () => {
    const { chapter, room, replies } = (await call(newClient(), 'GET', `/api/forum/threads/chapter/${slug}`)).body;
    expect(chapter).toEqual({ slug, number: 1 });
    expect(room).toBeNull();
    expect(replies).toEqual([]);
    expect((await call(newClient(), 'GET', '/api/forum/threads/chapter/not-real')).status).toBe(404);
  });

  it('opens the chapter’s discussion on first post, with the chapter tag', async () => {
    const alice = await signUp();
    const created = await call(alice.client, 'POST', `/api/forum/threads/chapter/${slug}`, { body: 'The ugly numbers.' });
    expect(created.status).toBe(201);

    const room = (await call(alice.client, 'GET', `/api/forum/threads/chapter/${slug}`)).body;
    expect(room.room).toMatchObject({
      id: created.body.id, scope: 'chapter', chapterSlug: slug, chapterNumber: 1,
      category: 'chapter', title: 'Chapter 01', tags: ['chapter-01'], isChapterRoom: true, revealsThrough: 1,
    });
    expect((await call(alice.client, 'GET', '/api/forum')).body.chapterRooms[0]).toMatchObject({
      slug, id: created.body.id, discussions: 1, replies: 0,
    });
  });

  it('permits only one discussion per chapter, enforced by the database', async () => {
    const alice = await signUp();
    const bob = await signUp();
    await call(alice.client, 'POST', `/api/forum/threads/chapter/${slug}`, { body: 'first' });
    const second = await call(bob.client, 'POST', `/api/forum/threads/chapter/${slug}`, { body: 'second' });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('room_exists');
    expect(second.body.error.id).toBeTruthy();
    expect((await call(newClient(), 'GET', `/api/forum/threads/chapter/${slug}`)).body.replies).toHaveLength(0);
  });

  it('keeps a chapter room in the chapter category when its author edits it', async () => {
    const alice = await signUp();
    const id = (await call(alice.client, 'POST', `/api/forum/threads/chapter/${slug}`, { body: 'first' })).body.id;
    const edit = await call(alice.client, 'PATCH', `/api/forum/threads/${id}`, {
      title: 'Chapter 01 · the dry pump', body: 'Revised opening.', category: 'theories', tags: ['ignored'], revealsThrough: 1,
    });
    expect(edit.status).toBe(200);
    const room = (await call(newClient(), 'GET', `/api/forum/threads/chapter/${slug}`)).body.room;
    // A room's chapter binding is structural: category and tags are not editable away.
    expect(room).toMatchObject({ category: 'chapter', tags: ['chapter-01'], title: 'Chapter 01 · the dry pump', body: 'Revised opening.' });
  });

  it('lets a reply reach further than the chapter, but never earlier', async () => {
    const alice = await signUp();
    const id = (await call(alice.client, 'POST', `/api/forum/threads/chapter/${slug}`, { body: 'first' })).body.id;
    expect((await call(alice.client, 'POST', `/api/forum/threads/${id}/comments`, { body: 'fine', revealsThrough: 5 })).status).toBe(400);
    expect((await call(alice.client, 'PATCH', `/api/forum/threads/${id}`, { title: 'Chapter 01', body: 'x', revealsThrough: 0 })).status).toBe(400);
  });
});

describe('forum migration', () => {
  /** Rewind the database to the shape the deployed site had before the forum. */
  async function toLegacySchema() {
    await db.query(`ALTER TABLE comments DROP CONSTRAINT IF EXISTS comments_category_fkey`);
    await db.query(`DROP TABLE categories`);
    for (const column of ['title', 'category', 'tags', 'is_chapter_room']) {
      await db.query(`ALTER TABLE comments DROP COLUMN IF EXISTS ${column}`);
    }
    await db.query(`ALTER TABLE comments ALTER COLUMN chapter_slug SET NOT NULL`);
    const cols = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'comments'`,
    );
    expect(cols.rows.map((c) => c.column_name).sort()).toEqual(
      ['account_id', 'body', 'chapter_slug', 'created_at', 'deleted_at', 'edited_at', 'has_spoiler', 'id', 'parent_id', 'reveals_through', 'state'],
    );
  }

  const legacy = async (id: string, slug: string | null, parent: string | null, body: string, minutesAgo: number, account?: string) => {
    await db.query(
      `INSERT INTO comments (id, chapter_slug, parent_id, account_id, body, reveals_through, has_spoiler, state, created_at)
       VALUES ($1, $2, $3, $4, $5, 1, false, 'visible', now() - ($6 || ' minutes')::interval)`,
      [id, slug, parent, account ?? null, body, String(minutesAgo)],
    );
  };

  it('converts existing chapter discussions without losing a single word, reply, author or timestamp', async () => {
    const { client: alice, handle: aliceHandle } = await signUp();
    const { handle: bobHandle } = await signUp();
    const accountId = async (handle: string) => (await db.query<{ id: string }>(`SELECT id FROM accounts WHERE handle = $1`, [handle])).rows[0].id;
    await toLegacySchema();

    // A chapter as it looked before: several top-level comments, replies under two of them.
    await legacy('00000000-0000-4000-8000-000000000001', 'the-dry-pump', null, 'The ugly numbers.', 90);
    await legacy('00000000-0000-4000-8000-000000000002', 'the-dry-pump', null, 'I read it as a ledger.', 80, await accountId(aliceHandle));
    await legacy('00000000-0000-4000-8000-000000000003', 'the-dry-pump', '00000000-0000-4000-8000-000000000002', 'A ledger of what?', 70, await accountId(bobHandle));
    await legacy('00000000-0000-4000-8000-000000000004', 'the-dry-pump', '00000000-0000-4000-8000-000000000003', 'Debt, probably.', 60, await accountId(aliceHandle));
    await legacy('00000000-0000-4000-8000-000000000005', 'the-dry-pump', null, 'Nobody has said the word pump.', 50);
    const before = (await db.query(`SELECT id, body, created_at, account_id FROM comments ORDER BY created_at`)).rows;

    await applySchema(db);

    // Nothing is dropped, renamed or reworded.
    const after = (await db.query(`SELECT id, body, created_at, account_id FROM comments ORDER BY created_at`)).rows;
    expect(after).toEqual(before);

    // The oldest top-level comment becomes the chapter's discussion, carrying the
    // chapter tag; the rest of the historical conversation is re-homed under it.
    const room = (await db.query<{ id: string; title: string; category: string; tags: string[]; is_chapter_room: boolean }>(
      `SELECT id, title, category, tags, is_chapter_room FROM comments WHERE is_chapter_room`,
    )).rows[0];
    expect(room).toMatchObject({
      id: '00000000-0000-4000-8000-000000000001',
      title: 'Chapter 01',
      category: 'chapter',
      tags: ['chapter-01'],
      is_chapter_room: true,
    });

    // Every other legacy comment, and every reply, now sits under that discussion
    // at one level — the shape the reader already saw.
    const flat = (await db.query<{ id: string; parent_id: string | null; body: string }>(
      `SELECT id, parent_id, body FROM comments WHERE id <> $1 ORDER BY created_at`,
      [room.id],
    )).rows;
    expect(flat.every((r) => r.parent_id === room.id)).toBe(true);
    expect(flat.map((r) => r.body)).toEqual([
      'I read it as a ledger.', 'A ledger of what?', 'Debt, probably.', 'Nobody has said the word pump.',
    ]);

    // And it is reachable through the API at the URL it always had.
    const served = (await call(alice, 'GET', '/api/forum/threads/chapter/the-dry-pump')).body;
    expect(served.room.id).toBe(room.id);
    expect(served.replies.map((r: any) => r.body)).toEqual([
      'I read it as a ledger.', 'A ledger of what?', 'Debt, probably.', 'Nobody has said the word pump.',
    ]);
    expect(served.replies[0].author).toBe(aliceHandle);
    expect(served.replies[1].author).toBe(bobHandle);
  });

  it('is idempotent, and never converts a discussion twice', async () => {
    await toLegacySchema();
    await legacy('00000000-0000-4000-8000-000000000001', 'the-dry-pump', null, 'First.', 30);
    await legacy('00000000-0000-4000-8000-000000000002', 'the-dry-pump', null, 'Second.', 20);
    await applySchema(db);
    const once = (await db.query(`SELECT id, parent_id FROM comments ORDER BY id`)).rows;
    await applySchema(db);
    await applySchema(db);
    expect((await db.query(`SELECT id, parent_id FROM comments ORDER BY id`)).rows).toEqual(once);
    expect((await db.query(`SELECT count(*)::int AS n FROM comments WHERE is_chapter_room`)).rows[0].n).toBe(1);
  });

  it('leaves a chapter with no comments until a reader opens it', async () => {
    await toLegacySchema();
    await applySchema(db);
    expect((await db.query(`SELECT count(*)::int AS n FROM comments WHERE is_chapter_room`)).rows[0].n).toBe(0);
    expect((await call(newClient(), 'GET', '/api/forum/threads/chapter/the-dry-pump')).body.room).toBeNull();
  });

  it('seeds the category registry without overwriting an edited category', async () => {
    await toLegacySchema();
    await applySchema(db);
    await db.query(`UPDATE categories SET name = 'Questions and Answers' WHERE slug = 'questions'`);
    await applySchema(db);
    expect((await db.query<{ name: string }>(`SELECT name FROM categories WHERE slug = 'questions'`)).rows[0].name).toBe('Questions and Answers');
  });
});

describe('moderation', () => {
  it('auto-hides a post after three independent reports, and only moderators can act', async () => {
    const author = await signUp();
    const id = await thread(author.client, { title: 'Something reportable', body: 'spam' });
    expect((await call(author.client, 'POST', `/api/comments/${id}/report`, { reason: 'spam' })).status).toBe(400);
    const reporters = [await signUp(), await signUp(), await signUp()];
    expect((await call(reporters[0].client, 'POST', `/api/comments/${id}/report`, { reason: 'bogus' })).status).toBe(400);
    for (const r of reporters) expect((await call(r.client, 'POST', `/api/comments/${id}/report`, { reason: 'spam' })).status).toBe(200);

    const pub = (await call(newClient(), 'GET', `/api/forum/threads/${id}`)).body.thread;
    expect(pub).toMatchObject({ status: 'hidden', body: '' });
    const own = (await call(author.client, 'GET', `/api/forum/threads/${id}`)).body.thread;
    expect(own.body).toBe('spam');
    // A hidden discussion is also out of the public index.
    expect((await call(newClient(), 'GET', '/api/forum/threads')).body.threads).toHaveLength(0);

    expect((await call(reporters[0].client, 'GET', '/api/moderation/reports')).status).toBe(403);
    expect((await call(reporters[0].client, 'POST', `/api/moderation/comments/${id}`, { state: 'visible' })).status).toBe(403);

    const mod = await signUp();
    await db.query(`UPDATE accounts SET role = 'moderator' WHERE handle = $1`, [mod.handle]);
    const queue = (await call(mod.client, 'GET', '/api/moderation/reports')).body.items;
    expect(queue[0]).toMatchObject({ id, reports: 3, discussionId: id, discussionTitle: 'Something reportable' });
    expect((await call(mod.client, 'POST', `/api/moderation/comments/${id}`, { state: 'removed' })).status).toBe(200);
    expect((await call(newClient(), 'GET', `/api/forum/threads/${id}`)).status).toBe(404);
    expect((await call(author.client, 'PATCH', `/api/forum/threads/${id}`, { title: 'sneaky', body: 'x' })).status).toBe(403);
  });
});

describe('account deletion', () => {
  it('removes the account and all associated records, leaving only tombstones others replied to', async () => {
    const alice = await signUp();
    await established(alice.handle);
    const bob = await signUp();
    const lonely = await thread(alice.client, { title: 'A discussion nobody joins', body: 'Does anyone read these?' });
    const replied = await thread(alice.client, { title: 'A discussion someone joins', body: 'This one got a reply.' });
    const bobTop = await thread(bob.client, { title: 'Something of Bob’s', body: 'Bob was here too.' });
    await call(bob.client, 'POST', `/api/forum/threads/${replied}/comments`, { body: 'bob reply' });
    await call(alice.client, 'PUT', `/api/forum/threads/${bobTop}/reaction`);
    await call(alice.client, 'POST', `/api/comments/${bobTop}/report`, { reason: 'other' });
    await call(alice.client, 'PUT', '/api/vault', { baseVersion: 0, wrappedKey: 'abc', ciphertext: 'def' });

    expect((await call(alice.client, 'DELETE', '/api/account', { confirm: 'nope' })).status).toBe(400);
    const del = await call(alice.client, 'DELETE', '/api/account', { confirm: 'delete my account' });
    expect(del.status).toBe(200);
    expect(del.cookies![0]).toContain('Max-Age=0');

    for (const table of ['accounts', 'sessions', 'vaults', 'reactions', 'reports']) {
      const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} t ${table === 'accounts' ? `WHERE handle = $1` : table === 'sessions' || table === 'vaults' ? `WHERE account_id NOT IN (SELECT id FROM accounts)` : table === 'reactions' ? `WHERE account_id NOT IN (SELECT id FROM accounts)` : `WHERE reporter_id NOT IN (SELECT id FROM accounts)`}`, table === 'accounts' ? [alice.handle] : []);
      expect(rows[0].n, table).toBe(0);
    }
    const all = (await db.query<{ id: string; body: string; title: string | null; account_id: string | null }>(`SELECT id, body, title, account_id FROM comments`)).rows;
    expect(all.find((c) => c.id === lonely)).toBeUndefined();
    // A discussion others replied to survives as an empty tombstone, so their
    // replies keep their place.
    expect(all.find((c) => c.id === replied)).toMatchObject({ body: '', account_id: null, title: 'A discussion someone joins' });
    expect(JSON.stringify(all)).not.toContain('nobody joins');
    expect((await call(alice.client, 'GET', '/api/me')).body.account).toBeNull();
    expect((await call(newClient(), 'POST', '/api/session', { authKey: (await deriveKeys(alice.readerKey)).authKey })).status).toBe(401);
  });
});
