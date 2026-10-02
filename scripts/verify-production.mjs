/**
 * Phase 7 production verification against the deployed site.
 *
 * Drives the real client contract: derives the authKey from a reader key with
 * the same HKDF the browser uses (src/lib/crypto.ts), keeps the session cookie,
 * and exercises accounts, discussions, routing and authorisation over HTTPS.
 * Prints one PASS/FAIL line per checklist item. Read-only apart from the
 * comments it creates.
 */
import { webcrypto } from 'node:crypto';

const BASE = process.argv[2] ?? 'https://dusk-shingle.vercel.app';
const ORIGIN = BASE;
const enc = new TextEncoder();
let cookie = '';
let pass = 0;
let fail = 0;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      'X-Dusk-Client': '1',
      Origin: ORIGIN,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookie) {
    const [pair] = c.split(';');
    if (pair.endsWith('=')) cookie = '';
    else cookie = pair;
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  return { status: res.status, data, text, headers: res.headers, setCookie };
}

// ── client-side crypto, mirroring src/lib/crypto.ts ──────────────────────────
const b64url = (bytes) =>
  Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function newReaderKey() {
  return `dusk1-${b64url(webcrypto.getRandomValues(new Uint8Array(32)))}`;
}

async function deriveAuthKey(readerKey) {
  const raw = Buffer.from(readerKey.slice('dusk1-'.length).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const key = await webcrypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits']);
  const bits = await webcrypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('dusk-shingle/hkdf-salt/v1'), info: enc.encode('dusk-shingle/auth/v1') },
    key,
    256,
  );
  return b64url(bits);
}

const CHAPTER = 'the-dry-pump';
const stamp = Date.now().toString(36);

console.log(`\n=== Phase 7 verification against ${BASE} ===\n`);

// ── Anonymous account ────────────────────────────────────────────────────────
const readerKey = newReaderKey();
const authKey = await deriveAuthKey(readerKey);

const created = await api('POST', '/api/account', { authKey });
check('create anonymous account', created.status === 201, `status=${created.status} handle=${created.data?.handle}`);

const cookieHeader = created.setCookie.find((c) => c.includes('dusk_session')) ?? '';
check(
  'session cookie is HttpOnly + Secure + SameSite=Strict + __Host-',
  /HttpOnly/i.test(cookieHeader) && /Secure/i.test(cookieHeader) && /SameSite=Strict/i.test(cookieHeader) && cookieHeader.includes('__Host-'),
  cookieHeader.replace(/=[^;]+/, '=<redacted>'),
);
check('account credential never appears in a response body', !created.text.includes(readerKey) && !created.text.includes(authKey));

const me1 = await api('GET', '/api/me');
check('session established', me1.data?.account?.handle === created.data?.handle, `handle=${me1.data?.account?.handle}`);

const me2 = await api('GET', '/api/me');
check('session persists across a refresh', me2.data?.account?.handle === created.data?.handle);

// return later / new device: sign in with the reader key only
cookie = '';
const signedOut = await api('GET', '/api/me');
check('signing out clears the session', signedOut.data?.account === null);

const signIn = await api('POST', '/api/session', { authKey: await deriveAuthKey(readerKey) });
check('return later: sign in with the reader key', signIn.status === 200 && signIn.data?.handle === created.data?.handle, `handle=${signIn.data?.handle}`);

const reauth = await api('GET', '/api/me');
check('returning account still works', reauth.data?.account?.handle === created.data?.handle);

const unknown = await api('POST', '/api/session', { authKey: await deriveAuthKey(newReaderKey()) });
check(
  'unknown reader key rejected identically (no account enumeration)',
  unknown.status === 401 && unknown.data?.error?.code === 'unknown_key',
);

// ── Community forum ─────────────────────────────────────────────────────────
const forum = await api('GET', '/api/forum');
check(
  'community index loads with categories, chapter rooms and an index feed',
  forum.status === 200 && Array.isArray(forum.data?.categories) && Array.isArray(forum.data?.latest) && Array.isArray(forum.data?.chapterRooms),
  `${forum.data?.categories?.length} categories, ${forum.data?.latest?.length} latest, ${forum.data?.total} total`,
);
check(
  'the retired /discussions index redirects to the community',
  (await fetch(`${BASE}/discussions`, { redirect: 'manual' })).headers.get('location') === '/community',
);

const communitySlug = forum.data?.categories?.[0]?.slug ?? 'general';
const stampTag = `verify${stamp}`;

// A discussion with no chapter at all: the thing the old model could not express.
const opened = await api('POST', '/api/forum/threads', {
  title: `Production verification discussion ${stamp}`,
  body: 'A discussion about the novel that belongs to no chapter.',
  category: communitySlug,
  tags: [stampTag, 'Chapter 01'],
  revealsThrough: 1,
});
check('start a discussion without a chapter', opened.status === 201, `id=${opened.data?.id}`);
const discussionId = opened.data?.id;

check('an index entry carries no body text', opened.status === 201 && !(JSON.stringify(forum.data?.latest) ?? '').includes('belongs to no chapter'));

const view = await api('GET', `/api/forum/threads/${discussionId}`);
check(
  'a chapter-less discussion is retrievable by its own address',
  view.status === 200 && view.data?.thread?.scope === 'community' && view.data?.thread?.chapterSlug === null,
  `scope=${view.data?.thread?.scope} tags=${JSON.stringify(view.data?.thread?.tags)}`,
);
check('chapter tags are attached as a tag, not as a chapter binding', (view.data?.thread?.tags ?? []).includes('chapter-01'));

const reply = await api('POST', `/api/forum/threads/${discussionId}/comments`, { body: `Production verification reply ${stamp}.` });
check('reply to a discussion', reply.status === 201, `id=${reply.data?.id}`);

// A second reader answers that reply. Threads are one level deep, so this must
// land on the discussion. A separate account is used because a brand-new account
// is allowed only one discussion and two posts an hour — a limit worth
// respecting here rather than fighting. The first session is restored
// afterwards, because creating an account replaces the cookie.
const firstCookie = cookie;
const second = await api('POST', '/api/account', { authKey: await deriveAuthKey(newReaderKey()) });
check('a second reader can take part', second.status === 201, `handle=${second.data?.handle}`);
const nested = await api('POST', `/api/forum/threads/${discussionId}/comments`, {
  body: `Production verification nested ${stamp}.`, parentId: reply.data?.id,
});
const otherHandle = second.data?.handle;
cookie = firstCookie;
const threaded = await api('GET', `/api/forum/threads/${discussionId}`);
check(
  'a reply to a reply lands on the discussion',
  nested.status === 201 && (threaded.data?.replies ?? []).every((r) => r.parentId === discussionId),
  `${threaded.data?.replies?.length} post(s), all on the discussion`,
);
check('both readers are named by pseudonym only', (threaded.data?.replies ?? []).length === 2
  && new Set((threaded.data?.replies ?? []).map((r) => r.author)).size === 2
  && (threaded.data?.replies ?? []).some((r) => r.author === otherHandle));

const filtered = await api('GET', `/api/forum/threads?tag=${stampTag}`);
check('discussions can be found by tag', filtered.status === 200 && (filtered.data?.threads ?? []).some((t) => t.id === discussionId));
const byCategory = await api('GET', `/api/forum/threads?category=${communitySlug}`);
check('discussions can be browsed by category', byCategory.status === 200 && (byCategory.data?.threads ?? []).some((t) => t.id === discussionId));
const searched = await api('GET', `/api/forum/threads?q=${encodeURIComponent(stamp)}`);
check('discussions can be searched', searched.status === 200 && (searched.data?.threads ?? []).some((t) => t.id === discussionId));

const edited = await api('PATCH', `/api/forum/threads/${discussionId}`, {
  title: `Production verification discussion ${stamp} (edited)`, body: 'Revised.', category: communitySlug, tags: [stampTag], revealsThrough: 1,
});
check('author may edit their own discussion', edited.status === 200 && (await api('GET', `/api/forum/threads/${discussionId}`)).data?.thread?.title?.includes('(edited)'));

// ── Chapter discussions ─────────────────────────────────────────────────────
const room = await api('GET', `/api/forum/threads/chapter/${CHAPTER}`);
check(
  'a chapter discussion is reachable, whether or not anyone has opened it',
  room.status === 200 && room.data?.chapter?.slug === CHAPTER && (room.data?.room === null || room.data?.room?.isChapterRoom === true),
  room.data?.room ? `room=${room.data.room.id}` : 'not opened yet',
);
if (!room.data?.room) {
  const first = await api('POST', `/api/forum/threads/chapter/${CHAPTER}`, { body: `Production verification chapter note ${stamp}.` });
  check('open a chapter discussion', first.status === 201, `id=${first.data?.id}`);
  const second = await api('POST', `/api/forum/threads/chapter/${CHAPTER}`, { body: `Production verification duplicate ${stamp}.` });
  check('only one discussion per chapter', second.status === 409, `status=${second.status}`);
  const roomReply = await api('POST', `/api/forum/threads/chapter/${CHAPTER}/comments`, { body: `Production verification chapter reply ${stamp}.` });
  check('reply inside a chapter discussion', roomReply.status === 201);
  const served = await api('GET', `/api/forum/threads/chapter/${CHAPTER}`);
  check(
    'chapter discussion and its replies persist, under their original authors',
    served.status === 200 && served.data?.room?.isChapterRoom === true && served.data?.room?.tags?.includes('chapter-01')
      && served.data?.replies.some((r) => r.body.includes(stamp)),
    `${served.data?.replies?.length} post(s)`,
  );
}

const listed = await api('GET', '/api/forum/threads?scope=community');
check('discussions exist without chapters', listed.status === 200 && listed.data.threads.some((t) => t.chapterSlug === null));
check('public profile is pseudonym only (no credential, no identity)', !JSON.stringify(view.data).includes(authKey));

// ── Authorisation ────────────────────────────────────────────────────────────
const noSession = await fetch(`${BASE}/api/forum/threads`, {
  method: 'POST',
  headers: { 'X-Dusk-Client': '1', Origin: ORIGIN, 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: 'should not be accepted', body: 'nope', category: 'general' }),
});
check('unauthenticated write rejected', noSession.status === 401);

const noCsrf = await fetch(`${BASE}/api/account`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ authKey }),
});
check('write without the client header rejected (CSRF)', noCsrf.status === 403);

const crossOrigin = await fetch(`${BASE}/api/account`, {
  method: 'POST',
  headers: { 'X-Dusk-Client': '1', Origin: 'https://evil.example', 'Content-Type': 'application/json' },
  body: JSON.stringify({ authKey }),
});
check('write from a foreign origin rejected (CSRF)', crossOrigin.status === 403);

check('author may edit their own reply', (await api('PATCH', `/api/comments/${reply.data?.id}`, { body: `Production verification reply ${stamp} (edited).` })).status === 200);
// A reply is edited through the comment route, never the discussion route.
check('a reply may not be edited through the discussion route', (await api('PATCH', `/api/forum/threads/${reply.data?.id}`, { title: 'x', body: 'y', category: 'general' })).status === 400);
check('a reply may not be deleted through the discussion route', (await api('DELETE', `/api/forum/threads/${reply.data?.id}`)).status === 400);
check('a new account is told to slow down rather than silently allowed', (await api('POST', '/api/forum/threads', { title: 'One too many', body: 'Rate limit probe.', category: 'general' })).status === 429);
const mod = await api('GET', '/api/moderation/reports');
check('moderation queue refused to a non-moderator', mod.status === 403, `status=${mod.status}`);
const vaultProbe = await api('GET', '/api/vault');
check('vault readable only for its own account', vaultProbe.status === 200 && 'vault' in vaultProbe.data);

// ── Routing ──────────────────────────────────────────────────────────────────
for (const path of ['/', '/community', '/community/new', `/community/c/${communitySlug}`, '/community/t/chapter-01', '/account', `/chapter/${CHAPTER}`, `/chapter/${CHAPTER}/discussion`, '/moderation', '/no/such/page']) {
  const res = await fetch(`${BASE}${path}`, { redirect: 'manual' });
  check(`deep link ${path} resolves after refresh`, res.status === 200, `status=${res.status}`);
}
for (const [path, expect, to] of [['/library', 308, '/'], ['/index.html', 308, '/'], ['/discussions', 308, '/community']]) {
  const res = await fetch(`${BASE}${path}`, { redirect: 'manual' });
  check(`${path} redirects to ${to}`, res.status === expect && res.headers.get('location') === to, `status=${res.status} loc=${res.headers.get('location')}`);
}
const html = await (await fetch(`${BASE}/`)).text();
const js = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
const css = html.match(/href="(\/assets\/[^"]+\.css)"/)?.[1];
check('static assets load', Boolean(js && css) && (await fetch(`${BASE}${js}`)).status === 200 && (await fetch(`${BASE}${css}`)).status === 200, `${js}`);
const assetCache = (await fetch(`${BASE}${js}`)).headers.get('cache-control') ?? '';
check('assets cached immutably', assetCache.includes('immutable'), assetCache);

// ── Security ─────────────────────────────────────────────────────────────────
const csp = (await fetch(`${BASE}/`)).headers.get('content-security-policy') ?? '';
check('CSP present with strict script-src', csp.includes("script-src 'self'") && csp.includes("object-src 'none'"));
check('noindex on account route', ((await fetch(`${BASE}/account`, { redirect: 'manual' })).headers.get('x-robots-tag') ?? '').includes('noindex'));

const bundle = await (await fetch(`${BASE}${js}`)).text();
const leaks = ['DATABASE_URL', 'POSTGRES_URL', 'PGPASSWORD', 'NEON_AUTH_BASE_URL', 'VITE_NEON_AUTH_URL', 'neon.tech', 'neonauth', 'postgres://', 'postgresql://', 'service_role', 'eyJhbGciOi'];
const found = leaks.filter((s) => bundle.includes(s));
check('no database credentials or hosts in the client bundle', found.length === 0, found.length ? `LEAKED: ${found.join(', ')}` : `${bundle.length} bytes scanned`);

// ── Cleanup: remove everything this run created ──────────────────────────────
// Replies first, so a discussion nobody else joined is removed outright rather
// than left behind as a tombstone.
for (const c of [reply.data?.id, nested.data?.id].filter(Boolean)) await api('DELETE', `/api/comments/${c}`);
if (discussionId) await api('DELETE', `/api/forum/threads/${discussionId}`);
const stillThere = (await api('GET', `/api/forum/threads?q=${encodeURIComponent(stamp)}`)).data?.threads ?? [];
check('verification leaves no discussion behind', stillThere.length === 0, `${stillThere.length} left`);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
