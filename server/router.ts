import type { Db } from './db.js';
import { ApiError, json, type ApiRequest, type ApiResponse } from './http.js';
import {
  cleanText,
  consumeRateLimit,
  countUrls,
  hashSecret,
  isUuid,
  isWellFormedKey,
  networkBucket,
  newHandle,
  newId,
  newSessionSecret,
  normaliseTags,
  type Limit,
} from './security.js';
import { chapterTag, latestPublishedNumber, publishedCatalog, publishedChapterNumber } from '../src/content/catalog.js';

const SESSION_DAYS = 180;
const MAX_COMMENT = 4000;
const MAX_TITLE = 140;
const MIN_TITLE = 4;
const MAX_PAGE = 50;

const LIMITS = {
  createAccount: { max: 5, windowSeconds: 3600 },
  signIn: { max: 20, windowSeconds: 900 },
  comment: { max: 6, windowSeconds: 600 },
  commentNewAccount: { max: 2, windowSeconds: 600 },
  commentDaily: { max: 40, windowSeconds: 86400 },
  // Starting a discussion is rarer and more costly than replying, so it gets
  // its own, tighter budget.
  thread: { max: 4, windowSeconds: 3600 },
  threadNewAccount: { max: 1, windowSeconds: 3600 },
  edit: { max: 30, windowSeconds: 600 },
  reaction: { max: 60, windowSeconds: 600 },
  report: { max: 10, windowSeconds: 3600 },
  vault: { max: 120, windowSeconds: 600 },
} satisfies Record<string, Limit>;

const REASONS = ['spoiler', 'harassment', 'spam', 'other'];
const AUTO_HIDE_REPORTS = 3;

type Account = { id: string; handle: string; role: 'reader' | 'moderator'; created_at: Date };

type Ctx = { db: Db; req: ApiRequest; params: string[] };
type Handler = (ctx: Ctx) => Promise<ApiResponse>;

// ───────────────────────── helpers ─────────────────────────

function secure(req: ApiRequest): boolean {
  return (req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
}

function cookieName(req: ApiRequest): string {
  return secure(req) ? '__Host-dusk_session' : 'dusk_session';
}

function sessionCookie(req: ApiRequest, value: string, maxAge: number): string {
  return [
    `${cookieName(req)}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
    secure(req) ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

function readSessionCookie(req: ApiRequest): string | undefined {
  const header = req.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === cookieName(req)) return rest.join('=');
  }
  return undefined;
}

async function limit(db: Db, bucket: string, rule: Limit) {
  if (!(await consumeRateLimit(db, bucket, rule))) {
    throw new ApiError(429, 'rate_limited', 'You are doing that too often. Please wait a little and try again.', {
      retryAfterSeconds: rule.windowSeconds,
    });
  }
}

async function optionalAccount(ctx: Ctx): Promise<Account | undefined> {
  const secret = readSessionCookie(ctx.req);
  if (!secret || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return undefined;
  const { rows } = await ctx.db.query<Account>(
    `SELECT a.id, a.handle, a.role, a.created_at FROM sessions s JOIN accounts a ON a.id = s.account_id
     WHERE s.id_hash = $1 AND s.expires_at > now()`,
    [hashSecret('session', secret)],
  );
  return rows[0];
}

async function requireAccount(ctx: Ctx): Promise<Account> {
  const account = await optionalAccount(ctx);
  if (!account) throw new ApiError(401, 'signed_out', 'Your session has ended. Sign in with your reader key to continue.');
  return account;
}

async function startSession(db: Db, req: ApiRequest, accountId: string): Promise<string> {
  const secret = newSessionSecret();
  await db.query(`INSERT INTO sessions (id_hash, account_id, expires_at) VALUES ($1, $2, now() + $3::interval)`, [
    hashSecret('session', secret),
    accountId,
    `${SESSION_DAYS} days`,
  ]);
  await db.query(`DELETE FROM sessions WHERE account_id = $1 AND expires_at < now()`, [accountId]);
  return sessionCookie(req, secret, SESSION_DAYS * 86400);
}

function body(req: ApiRequest): Record<string, unknown> {
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) return req.body as Record<string, unknown>;
  throw new ApiError(400, 'bad_request', 'The request could not be read.');
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Describe a connection failure well enough to act on, with nothing usable out
 * of it. Connection strings, passwords and user names are redacted; the driver
 * code (ENOTFOUND, ECONNREFUSED, 28P01, XX000 …) and the server's own wording are
 * kept, because without them a dead database is undiagnosable.
 */
function describeDbError(error: unknown): string {
  const name = (error as Error)?.name ?? 'Error';
  const code = String((error as { code?: unknown }).code ?? '');
  const message = String((error as Error)?.message ?? '');
  const safe = message
    .replace(/(postgres(?:ql)?:\/\/)[^\s'"]*/gi, '$1[redacted]')
    .replace(/password=("[^"]*"|\S*)/gi, 'password=[redacted]')
    .replace(/user(name)?=("[^"]*"|\S*)/gi, 'user=$1[redacted]')
    .replace(/(for user\s+)(\S+)/gi, '$1[redacted]')
    .slice(0, 300);
  return `${name}${code ? ` (${code})` : ''}${safe ? `: ${safe}` : ''}`;
}

function chapterNumberOrThrow(slug: string): number {
  const n = publishedChapterNumber(slug);
  if (!n) throw new ApiError(404, 'no_chapter', 'That chapter is not part of the published edition.');
  return n;
}

function validateText(raw: unknown, what: string): { text: string; hasSpoiler: boolean } {
  if (typeof raw !== 'string') throw new ApiError(400, 'bad_request', `A ${what} needs some text.`);
  const text = cleanText(raw);
  if (!text) throw new ApiError(400, 'empty', `A ${what} needs some text.`);
  if (text.length > MAX_COMMENT) throw new ApiError(400, 'too_long', `${what[0].toUpperCase()}${what.slice(1)}s are limited to ${MAX_COMMENT} characters.`);
  if (countUrls(text) > 2) throw new ApiError(400, 'too_many_links', 'Posts may include at most two links.');
  return { text, hasSpoiler: /\|\|[^|]+\|\|/.test(text) };
}

function validateTitle(raw: unknown): string {
  if (typeof raw !== 'string') throw new ApiError(400, 'bad_request', 'A discussion needs a title.');
  const title = cleanText(raw).replace(/\s+/g, ' ');
  if (title.length < MIN_TITLE) throw new ApiError(400, 'short_title', `Give the discussion a title of at least ${MIN_TITLE} characters.`);
  if (title.length > MAX_TITLE) throw new ApiError(400, 'too_long', `Titles are limited to ${MAX_TITLE} characters.`);
  return title;
}

function validateTags(raw: unknown): string[] {
  try {
    return normaliseTags(raw);
  } catch {
    throw new ApiError(400, 'bad_request', 'Tags could not be read.');
  }
}

/**
 * How far into the published edition a post reaches. The floor is the thread's
 * own chapter (or the first chapter for a community-wide discussion); the
 * ceiling is the latest published chapter, so nothing can claim knowledge of
 * an unpublished chapter.
 */
function validateReveals(raw: unknown, floor: number): number {
  const value = raw === undefined || raw === null ? floor : raw;
  const latest = latestPublishedNumber();
  if (typeof value !== 'number' || !Number.isInteger(value) || value < floor || value > latest) {
    throw new ApiError(400, 'bad_spoiler_scope', 'Choose which chapters this discusses.');
  }
  return value;
}

/** The lowest chapter a post in this thread may claim to reach. */
function floorFor(chapterNumber: number | null): number {
  return chapterNumber ?? 1;
}

type CommentRow = {
  id: string;
  parent_id: string | null;
  account_id: string | null;
  handle: string | null;
  body: string;
  reveals_through: number;
  has_spoiler: boolean;
  state: string;
  created_at: Date;
  edited_at: Date | null;
  deleted_at: Date | null;
  reactions: string | number;
  reacted: boolean;
};

function presentComment(row: CommentRow, viewer?: Account) {
  const mine = Boolean(viewer && row.account_id === viewer.id);
  const moderator = viewer?.role === 'moderator';
  const deleted = Boolean(row.deleted_at);
  const concealed = !deleted && row.state !== 'visible' && !mine && !moderator;
  return {
    id: row.id,
    parentId: row.parent_id,
    author: deleted ? null : row.handle,
    body: deleted || concealed ? '' : row.body,
    status: deleted ? 'deleted' : row.state === 'visible' ? 'visible' : row.state,
    revealsThrough: row.reveals_through,
    hasSpoiler: row.has_spoiler,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    reactions: deleted ? 0 : Number(row.reactions),
    reacted: row.reacted,
    mine,
  };
}

/** The columns every thread query needs. `replies`/`activity` keep the feed to one round trip. */
const THREAD_COLUMNS = `
  c.id, c.parent_id, c.account_id, c.chapter_slug, c.title, c.category, c.tags, c.is_chapter_room,
  a.handle, k.name AS category_name, c.body, c.reveals_through, c.has_spoiler, c.state,
  c.created_at, c.edited_at, c.deleted_at,
  (SELECT count(*) FROM comments r WHERE r.parent_id = c.id AND r.state <> 'removed') AS replies,
  (SELECT count(*) FROM reactions x WHERE x.comment_id = c.id) AS reactions,
  EXISTS (SELECT 1 FROM reactions x WHERE x.comment_id = c.id AND x.account_id = $1) AS reacted,
  greatest(c.created_at, coalesce((SELECT max(created_at) FROM comments r WHERE r.parent_id = c.id), c.created_at)) AS activity`;

type ThreadRow = {
  id: string;
  parent_id: string | null;
  account_id: string | null;
  chapter_slug: string | null;
  title: string | null;
  category: string | null;
  tags: string[] | null;
  is_chapter_room: boolean;
  handle: string | null;
  category_name: string | null;
  body: string;
  reveals_through: number;
  has_spoiler: boolean;
  state: string;
  created_at: Date;
  edited_at: Date | null;
  deleted_at: Date | null;
  replies: string | number;
  reactions: string | number;
  reacted: boolean;
  activity: Date;
};

/**
 * A discussion as the reader sees it. `scope` is derived from the chapter
 * association rather than stored, so the two can never disagree. The body is
 * included here but deliberately not in the index payload: a list of bodies
 * would push unmarked spoilers past the chapter gate, and the gate is the only
 * thing standing between a reader and the end of a chapter they have not read.
 */
function presentThread(row: ThreadRow, viewer?: Account) {
  const base = presentComment(row as CommentRow, viewer);
  return {
    ...base,
    scope: row.chapter_slug ? 'chapter' : 'community',
    title: row.title ?? 'Discussion',
    category: row.category ?? 'general',
    categoryName: row.category_name ?? 'General',
    chapterSlug: row.chapter_slug,
    chapterNumber: row.chapter_slug ? (publishedChapterNumber(row.chapter_slug) ?? null) : null,
    tags: row.tags ?? [],
    isChapterRoom: row.is_chapter_room,
    replies: Number(row.replies ?? 0),
    lastActivityAt: row.activity,
  };
}

async function requireCategory(db: Db, slug: unknown): Promise<string> {
  if (typeof slug !== 'string' || !slug) throw new ApiError(400, 'bad_category', 'Choose a category for the discussion.');
  const { rows } = await db.query(`SELECT 1 FROM categories WHERE slug = $1`, [slug]);
  if (!rows[0]) throw new ApiError(400, 'bad_category', 'That category is not one we have. Choose another.');
  return slug;
}

async function loadThread(db: Db, id: string, viewer?: Account) {
  if (!isUuid(id)) throw new ApiError(404, 'no_discussion', 'That discussion no longer exists.');
  const { rows } = await db.query<ThreadRow>(
    `SELECT ${THREAD_COLUMNS} FROM comments c LEFT JOIN accounts a ON a.id = c.account_id
       LEFT JOIN categories k ON k.slug = c.category
     WHERE c.id = $2 AND c.parent_id IS NULL`,
    [viewer?.id ?? null, id],
  );
  const row = rows[0];
  if (!row) throw new ApiError(404, 'no_discussion', 'That discussion no longer exists.');
  // Moderation state is the author's and the moderators' to see; to everyone
  // else a removed discussion is simply gone.
  if (row.state === 'removed' && row.account_id !== viewer?.id && viewer?.role !== 'moderator') {
    throw new ApiError(404, 'no_discussion', 'That discussion no longer exists.');
  }
  return row;
}

async function loadOwnedComment(db: Db, id: string, account: Account) {
  if (!isUuid(id)) throw new ApiError(404, 'no_comment', 'That comment no longer exists.');
  const { rows } = await db.query<{ id: string; parent_id: string | null; account_id: string | null; chapter_slug: string | null; is_chapter_room: boolean; deleted_at: Date | null; state: string }>(
    `SELECT id, parent_id, account_id, chapter_slug, is_chapter_room, deleted_at, state FROM comments WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row || row.deleted_at) throw new ApiError(404, 'no_comment', 'That comment no longer exists.');
  if (row.account_id !== account.id) throw new ApiError(403, 'not_yours', 'You can only change your own posts.');
  return row;
}

/** Delete or tombstone a comment, then clean up tombstones left without replies. */
async function removeComment(db: Db, id: string) {
  const { rows } = await db.query<{ n: string | number }>(`SELECT count(*) AS n FROM comments WHERE parent_id = $1`, [id]);
  if (Number(rows[0].n) > 0) {
    await db.query(`UPDATE comments SET body = '', account_id = NULL, deleted_at = now(), has_spoiler = false WHERE id = $1`, [id]);
    await db.query(`DELETE FROM reactions WHERE comment_id = $1`, [id]);
  } else {
    const parent = await db.query<{ parent_id: string | null }>(`DELETE FROM comments WHERE id = $1 RETURNING parent_id`, [id]);
    const parentId = parent.rows[0]?.parent_id;
    if (parentId) {
      await db.query(
        `DELETE FROM comments p WHERE p.id = $1 AND p.deleted_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM comments c WHERE c.parent_id = p.id)`,
        [parentId],
      );
    }
  }
}

// ───────────────────────── handlers ─────────────────────────

const health: Handler = async () => json(200, { ok: true, database: true });

const createAccount: Handler = async ({ db, req }) => {
  await limit(db, networkBucket('create', req.ip), LIMITS.createAccount);
  const { authKey } = body(req);
  if (!isWellFormedKey(authKey)) throw new ApiError(400, 'bad_request', 'The reader key was malformed.');
  const authHash = hashSecret('auth', authKey);

  const existing = await db.query(`SELECT 1 FROM accounts WHERE auth_hash = $1`, [authHash]);
  if (existing.rows.length) {
    // Astronomically unlikely with 256-bit keys; the client generates a fresh key and retries.
    throw new ApiError(409, 'key_collision', 'Please try again.');
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = newId();
    const handle = newHandle();
    try {
      await db.query(`INSERT INTO accounts (id, auth_hash, handle) VALUES ($1, $2, $3)`, [id, authHash, handle]);
      const cookie = await startSession(db, req, id);
      return json(201, { handle, role: 'reader' }, [cookie]);
    } catch (error) {
      const code = (error as { code?: string }).code;
      const detail = String((error as { constraint?: string; message?: string }).constraint ?? (error as Error).message);
      if (code !== '23505') throw error;
      if (detail.includes('auth_hash')) throw new ApiError(409, 'key_collision', 'Please try again.');
      // handle collision → retry with a new pseudonym
    }
  }
  throw new ApiError(503, 'busy', 'We could not create an account just now. Please try again.');
};

const signIn: Handler = async ({ db, req }) => {
  await limit(db, networkBucket('signin', req.ip), LIMITS.signIn);
  const { authKey } = body(req);
  if (!isWellFormedKey(authKey)) throw new ApiError(401, 'unknown_key', 'That reader key does not match an account.');
  const { rows } = await db.query<{ id: string; handle: string; role: string }>(
    `SELECT id, handle, role FROM accounts WHERE auth_hash = $1`,
    [hashSecret('auth', authKey)],
  );
  if (!rows[0]) throw new ApiError(401, 'unknown_key', 'That reader key does not match an account.');
  const cookie = await startSession(db, req, rows[0].id);
  return json(200, { handle: rows[0].handle, role: rows[0].role }, [cookie]);
};

const signOut: Handler = async ({ db, req }) => {
  const secret = readSessionCookie(req);
  if (secret) await db.query(`DELETE FROM sessions WHERE id_hash = $1`, [hashSecret('session', secret)]);
  return json(200, { ok: true }, [sessionCookie(req, '', 0)]);
};

const signOutEverywhere: Handler = async (ctx) => {
  const account = await requireAccount(ctx);
  await ctx.db.query(`DELETE FROM sessions WHERE account_id = $1`, [account.id]);
  return json(200, { ok: true }, [sessionCookie(ctx.req, '', 0)]);
};

const me: Handler = async (ctx) => {
  const account = await optionalAccount(ctx);
  if (!account) return json(200, { account: null });
  return json(200, { account: { handle: account.handle, role: account.role } });
};

const deleteAccount: Handler = async (ctx) => {
  const account = await requireAccount(ctx);
  if (body(ctx.req).confirm !== 'delete my account') {
    throw new ApiError(400, 'confirm', 'Type the confirmation phrase to delete your account.');
  }
  await ctx.db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM comments WHERE account_id = $1 AND deleted_at IS NULL ORDER BY parent_id NULLS FIRST`,
      [account.id],
    );
    // Replies first so parents with only this reader's replies are fully removed.
    for (const row of rows.reverse()) await removeComment(tx, row.id);
    await tx.query(`DELETE FROM accounts WHERE id = $1`, [account.id]); // cascades sessions, vault, reactions, reports
  });
  return json(200, { ok: true }, [sessionCookie(ctx.req, '', 0)]);
};

const getVault: Handler = async (ctx) => {
  const account = await requireAccount(ctx);
  const { rows } = await ctx.db.query<{ version: number; wrapped_key: string; ciphertext: string }>(
    `SELECT version, wrapped_key, ciphertext FROM vaults WHERE account_id = $1`,
    [account.id],
  );
  if (!rows[0]) return json(200, { vault: null });
  return json(200, { vault: { version: rows[0].version, wrappedKey: rows[0].wrapped_key, ciphertext: rows[0].ciphertext } });
};

const B64 = /^[A-Za-z0-9_-]+$/;

const putVault: Handler = async (ctx) => {
  const account = await requireAccount(ctx);
  await limit(ctx.db, `vault:${account.id}`, LIMITS.vault);
  const { baseVersion, wrappedKey, ciphertext } = body(ctx.req);
  if (
    !(baseVersion === 0 || (typeof baseVersion === 'number' && Number.isInteger(baseVersion) && baseVersion > 0)) ||
    typeof wrappedKey !== 'string' || wrappedKey.length > 512 || !B64.test(wrappedKey) ||
    typeof ciphertext !== 'string' || ciphertext.length > 90000 || !B64.test(ciphertext)
  ) {
    throw new ApiError(400, 'bad_vault', 'The encrypted reading state was malformed.');
  }
  const result = await ctx.db.query<{ version: number }>(
    baseVersion === 0
      ? `INSERT INTO vaults (account_id, version, wrapped_key, ciphertext) VALUES ($1, 1, $2, $3)
         ON CONFLICT (account_id) DO NOTHING RETURNING version`
      : `UPDATE vaults SET version = version + 1, wrapped_key = $2, ciphertext = $3, updated_at = now()
         WHERE account_id = $1 AND version = $4 RETURNING version`,
    baseVersion === 0 ? [account.id, wrappedKey, ciphertext] : [account.id, wrappedKey, ciphertext, baseVersion],
  );
  if (!result.rows[0]) {
    const current = await ctx.db.query<{ version: number; wrapped_key: string; ciphertext: string }>(
      `SELECT version, wrapped_key, ciphertext FROM vaults WHERE account_id = $1`,
      [account.id],
    );
    const v = current.rows[0];
    throw new ApiError(409, 'stale', 'Your reading state changed on another device.', {
      vault: v ? { version: v.version, wrappedKey: v.wrapped_key, ciphertext: v.ciphertext } : null,
    });
  }
  return json(200, { version: result.rows[0].version });
};

// ───────────────────────── community forum ─────────────────────────

/** Index payload for a thread: the summary without the body. */
function presentSummary(row: ThreadRow, viewer?: Account) {
  const { body: _body, ...summary } = presentThread(row, viewer);
  void _body;
  return summary;
}

/** A discussion is listed unless it was removed, unless you wrote it. */
const VISIBLE = '(c.state = \'visible\' OR c.account_id = $1 OR $2::boolean)';

// ───────────────────────── community forum handlers ─────────────────────────

const forumIndex: Handler = async (ctx) => {
  const viewer = await optionalAccount(ctx);
  const me = viewer?.id ?? null;
  const isMod = viewer?.role === 'moderator';

  const categories = await ctx.db.query<{ slug: string; name: string; description: string; discussions: string | number }>(
    `SELECT k.slug, k.name, k.description, count(c.id) AS discussions
     FROM categories k
     LEFT JOIN comments c ON c.category = k.slug AND c.parent_id IS NULL
       AND c.state = 'visible' AND c.deleted_at IS NULL
     GROUP BY k.slug, k.name, k.description, k.position
     ORDER BY k.position, k.name`,
  );
  const rooms = await ctx.db.query<{ chapter_slug: string; n: string | number; latest: Date }>(
    `SELECT chapter_slug, count(*) AS n, max(created_at) AS latest FROM comments
     WHERE parent_id IS NULL AND chapter_slug IS NOT NULL AND state = 'visible' AND deleted_at IS NULL
     GROUP BY chapter_slug`,
  );
  const roomRows = await ctx.db.query<ThreadRow>(
    `SELECT ${THREAD_COLUMNS} FROM comments c LEFT JOIN accounts a ON a.id = c.account_id
     LEFT JOIN categories k ON k.slug = c.category
     WHERE c.is_chapter_room AND c.parent_id IS NULL ORDER BY c.created_at`,
    [me],
  );
  const tags = await ctx.db.query<{ tag: string; discussions: string | number }>(
    `SELECT t.tag, count(*) AS discussions
     FROM comments c, unnest(c.tags) AS t(tag)
     WHERE c.parent_id IS NULL AND c.state = 'visible' AND c.deleted_at IS NULL
     GROUP BY t.tag ORDER BY count(*) DESC, t.tag LIMIT 30`,
  );
  const total = await ctx.db.query<{ n: string | number }>(
    `SELECT count(*) AS n FROM comments c WHERE c.parent_id IS NULL AND c.state = 'visible' AND c.deleted_at IS NULL`,
  );

  const latest = await ctx.db.query<ThreadRow>(
    `SELECT ${THREAD_COLUMNS} FROM comments c LEFT JOIN accounts a ON a.id = c.account_id
     LEFT JOIN categories k ON k.slug = c.category
     WHERE c.parent_id IS NULL AND ${VISIBLE} AND c.deleted_at IS NULL
     ORDER BY c.created_at DESC, c.id DESC LIMIT 12`,
    [me, isMod],
  );
  const active = await ctx.db.query<ThreadRow>(
    `SELECT ${THREAD_COLUMNS} FROM comments c LEFT JOIN accounts a ON a.id = c.account_id
     LEFT JOIN categories k ON k.slug = c.category
     WHERE c.parent_id IS NULL AND ${VISIBLE} AND c.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM comments r WHERE r.parent_id = c.id AND r.state <> 'removed')
     ORDER BY replies DESC, activity DESC LIMIT 6`,
    [me, isMod],
  );

  const bySlug = new Map(rooms.rows.map((r) => [r.chapter_slug, r]));
  const roomBySlug = new Map(roomRows.rows.map((r) => [r.chapter_slug, r]));

  return json(200, {
    categories: categories.rows.map((c) => ({ ...c, discussions: Number(c.discussions) })),
    latest: latest.rows.map((r) => presentSummary(r, viewer)),
    active: active.rows.map((r) => presentSummary(r, viewer)),
    chapterRooms: publishedCatalog().map((c) => {
      const stats = bySlug.get(c.slug);
      const room = roomBySlug.get(c.slug);
      return {
        slug: c.slug,
        number: c.number,
        id: room?.id ?? null,
        title: room?.title ?? null,
        discussions: Number(stats?.n ?? 0),
        replies: Number(room?.replies ?? 0),
        latest: stats?.latest ?? null,
      };
    }),
    tags: tags.rows.map((t) => ({ tag: t.tag, discussions: Number(t.discussions) })),
    total: Number(total.rows[0]?.n ?? 0),
  });
};

const listThreads: Handler = async (ctx) => {
  const viewer = await optionalAccount(ctx);
  const params: unknown[] = [viewer?.id ?? null, viewer?.role === 'moderator'];
  const clause = (sql: string, value: unknown) => {
    params.push(value);
    return sql.replace('?', `$${params.length}`);
  };
  let where = 'c.parent_id IS NULL';
  const q = ctx.req.query ?? {};
  if (typeof q.category === 'string' && q.category) where += ` AND c.category = ${clause('?', q.category)}`;
  if (typeof q.tag === 'string' && q.tag) where += ` AND ${clause('?', q.tag)} = ANY(c.tags)`;
  if (q.scope === 'community') where += ' AND c.chapter_slug IS NULL';
  if (q.scope === 'chapter') where += ' AND c.chapter_slug IS NOT NULL';
  if (typeof q.chapter === 'string' && q.chapter) where += ` AND c.chapter_slug = ${clause('?', q.chapter)}`;
  if (typeof q.q === 'string' && q.q.trim()) {
    const needle = `%${q.q.trim().slice(0, 80)}%`;
    where += ` AND (c.title ILIKE ${clause('?', needle)} OR c.body ILIKE ${clause('?', needle)})`;
  }
  const limit = clamp(Number(q.limit) || 20, 1, MAX_PAGE);
  const offset = clamp(Number(q.offset) || 0, 0, 1000);
  const order = q.sort === 'active' ? 'replies DESC, activity DESC' : 'c.created_at DESC, c.id DESC';
  if (q.sort === 'active') where += ` AND EXISTS (SELECT 1 FROM comments r WHERE r.parent_id = c.id AND r.state <> 'removed')`;

  const { rows } = await ctx.db.query<ThreadRow>(
    `SELECT ${THREAD_COLUMNS} FROM comments c LEFT JOIN accounts a ON a.id = c.account_id
     LEFT JOIN categories k ON k.slug = c.category
     WHERE ${where} AND ${VISIBLE} AND c.deleted_at IS NULL
     ORDER BY ${order} LIMIT $${params.push(limit)} OFFSET $${params.push(offset)}`,
    params,
  );
  return json(200, { threads: rows.map((r) => presentSummary(r, viewer)), offset, limit, hasMore: rows.length === limit });
};

const chapterRoom: Handler = async (ctx) => {
  const slug = ctx.params[0];
  const number = chapterNumberOrThrow(slug);
  const viewer = await optionalAccount(ctx);
  const { rows } = await ctx.db.query<ThreadRow>(
    `SELECT ${THREAD_COLUMNS} FROM comments c LEFT JOIN accounts a ON a.id = c.account_id
     LEFT JOIN categories k ON k.slug = c.category
     WHERE c.is_chapter_room AND c.chapter_slug = $2 AND c.parent_id IS NULL`,
    [viewer?.id ?? null, slug],
  );
  const room = rows[0];
  if (!room) return json(200, { chapter: { slug, number }, room: null, replies: [] });
  const replies = await ctx.db.query<CommentRow>(
    `SELECT c.id, c.parent_id, c.account_id, a.handle, c.body, c.reveals_through, c.has_spoiler, c.state,
            c.created_at, c.edited_at, c.deleted_at,
            (SELECT count(*) FROM reactions x WHERE x.comment_id = c.id) AS reactions,
            EXISTS (SELECT 1 FROM reactions x WHERE x.comment_id = c.id AND x.account_id = $2) AS reacted
     FROM comments c LEFT JOIN accounts a ON a.id = c.account_id
     LEFT JOIN categories k ON k.slug = c.category
     WHERE c.parent_id = $1 AND c.state <> 'removed' OR (c.parent_id = $1 AND c.account_id = $2)
     ORDER BY c.created_at ASC LIMIT 1000`,
    [room.id, viewer?.id ?? null],
  );
  return json(200, {
    chapter: { slug, number },
    room: presentThread(room, viewer),
    replies: replies.rows.map((r) => presentComment(r, viewer)),
  });
};

const getThread: Handler = async (ctx) => {
  const viewer = await optionalAccount(ctx);
  const row = await loadThread(ctx.db, ctx.params[0], viewer);
  const { rows } = await ctx.db.query<CommentRow>(
    `SELECT c.id, c.parent_id, c.account_id, a.handle, c.body, c.reveals_through, c.has_spoiler, c.state,
            c.created_at, c.edited_at, c.deleted_at,
            (SELECT count(*) FROM reactions x WHERE x.comment_id = c.id) AS reactions,
            EXISTS (SELECT 1 FROM reactions x WHERE x.comment_id = c.id AND x.account_id = $2) AS reacted
     FROM comments c LEFT JOIN accounts a ON a.id = c.account_id
     LEFT JOIN categories k ON k.slug = c.category
     WHERE c.parent_id = $1 AND c.state <> 'removed' OR (c.parent_id = $1 AND c.account_id = $2)
     ORDER BY c.created_at ASC LIMIT 1000`,
    [row.id, viewer?.id ?? null],
  );
  return json(200, {
    thread: presentThread(row, viewer),
    replies: rows.map((r) => presentComment(r, viewer)),
    viewer: viewer ? { handle: viewer.handle, role: viewer.role } : null,
  });
};

/** Every post, discussion or reply, spends the shared speaking budget. */
async function spendPostLimits(db: Db, account: Account) {
  const isNew = Date.now() - new Date(account.created_at).getTime() < 10 * 60 * 1000;
  await limit(db, `comment:${account.id}`, isNew ? LIMITS.commentNewAccount : LIMITS.comment);
  await limit(db, `comment-day:${account.id}`, LIMITS.commentDaily);
}

/**
 * Starting a discussion spends an extra budget on top of speaking. It is
 * charged only here, never on a reply, so the two budgets cannot starve each
 * other, and it is charged first so that being told to slow down does not also
 * cost the reader a reply.
 */
async function spendThreadLimits(db: Db, account: Account) {
  const isNew = Date.now() - new Date(account.created_at).getTime() < 10 * 60 * 1000;
  await limit(db, `thread:${account.id}`, isNew ? LIMITS.threadNewAccount : LIMITS.thread);
  await limit(db, `comment:${account.id}`, isNew ? LIMITS.commentNewAccount : LIMITS.comment);
  await limit(db, `comment-day:${account.id}`, LIMITS.commentDaily);
}

/** The same body within the hour is a double submit, not a new post. */
async function rejectDuplicate(db: Db, account: Account, text: string) {
  const dupe = await db.query(
    `SELECT 1 FROM comments WHERE account_id = $1 AND body = $2 AND created_at > now() - interval '1 hour'`,
    [account.id, text],
  );
  if (dupe.rows.length) throw new ApiError(409, 'duplicate', 'You have already posted this.');
}

const createThread: Handler = async (ctx) => {
  const account = await requireAccount(ctx);
  const input = body(ctx.req);
  const { text, hasSpoiler } = validateText(input.body, 'discussion');
  const title = validateTitle(input.title);
  const category = await requireCategory(ctx.db, input.category);
  const tags = validateTags(input.tags);
  const reveals = validateReveals(input.revealsThrough, 1);
  await rejectDuplicate(ctx.db, account, text);
  await spendThreadLimits(ctx.db, account);
  const id = newId();
  await ctx.db.query(
    `INSERT INTO comments (id, chapter_slug, parent_id, account_id, title, category, tags, body, reveals_through, has_spoiler)
     VALUES ($1, NULL, NULL, $2, $3, $4, $5, $6, $7, $8)`,
    [id, account.id, title, category, tags, text, reveals, hasSpoiler],
  );
  return json(201, { id });
};

const createChapterRoom: Handler = async (ctx) => {
  const account = await requireAccount(ctx);
  const slug = ctx.params[0];
  const number = chapterNumberOrThrow(slug);
  const input = body(ctx.req);
  const { text, hasSpoiler } = validateText(input.body, 'discussion');
  const title = typeof input.title === 'string' && input.title.trim() ? validateTitle(input.title) : `Chapter ${String(number).padStart(2, '0')}`;
  await rejectDuplicate(ctx.db, account, text);
  await spendThreadLimits(ctx.db, account);
  const id = newId();
  try {
    await ctx.db.query(
      `INSERT INTO comments (id, chapter_slug, parent_id, account_id, title, category, tags, is_chapter_room, body, reveals_through, has_spoiler)
       VALUES ($1, $2, NULL, $3, $4, 'chapter', $5, true, $6, $7, $8)`,
      [id, slug, account.id, title, [chapterTag(number)], text, number, hasSpoiler],
    );
  } catch (error) {
    // Two readers can open an empty chapter at the same moment; the unique
    // index settles it, and the loser is sent to the room that won.
    if ((error as { code?: string }).code === '23505') {
      const { rows } = await ctx.db.query<{ id: string }>(
        `SELECT id FROM comments WHERE is_chapter_room AND chapter_slug = $1`,
        [slug],
      );
      throw new ApiError(409, 'room_exists', 'Someone opened this chapter’s discussion a moment before you. Your words are not lost — open theirs and add them there.', {
        id: rows[0]?.id ?? null,
      });
    }
    throw error;
  }
  return json(201, { id });
};

const updateThread: Handler = async (ctx) => {
  const account = await requireAccount(ctx);
  await limit(ctx.db, `edit:${account.id}`, LIMITS.edit);
  const row = await loadOwnedComment(ctx.db, ctx.params[0], account);
  if (row.parent_id !== null) throw new ApiError(400, 'not_a_discussion', 'That is a reply, not a discussion.');
  if (row.state === 'removed') throw new ApiError(403, 'moderated', 'This discussion was removed by moderation and cannot be edited.');
  const input = body(ctx.req);
  const { text, hasSpoiler } = validateText(input.body, 'discussion');
  const title = validateTitle(input.title);
  const category = row.is_chapter_room ? 'chapter' : await requireCategory(ctx.db, input.category);
  const tags = row.is_chapter_room ? undefined : validateTags(input.tags);
  const floor = floorFor(row.chapter_slug ? publishedChapterNumber(row.chapter_slug) ?? null : null);
  const reveals = validateReveals(input.revealsThrough, floor);
  await ctx.db.query(
    `UPDATE comments SET title = $2, category = $3, tags = coalesce($4, tags), body = $5, has_spoiler = $6,
            reveals_through = $7, edited_at = now()
     WHERE id = $1`,
    [row.id, title, category, tags ?? null, text, hasSpoiler, reveals],
  );
  return json(200, { ok: true });
};

const deleteThread: Handler = async (ctx) => {
  const account = await requireAccount(ctx);
  const row = await loadOwnedComment(ctx.db, ctx.params[0], account);
  if (row.parent_id !== null) throw new ApiError(400, 'not_a_discussion', 'That is a reply, not a discussion.');
  await ctx.db.transaction((tx) => removeComment(tx, row.id));
  return json(200, { ok: true });
};

const createReply: Handler = async (ctx) => {
  const account = await requireAccount(ctx);
  const thread = await loadThread(ctx.db, ctx.params[0], account);
  if (thread.deleted_at || thread.state !== 'visible') {
    throw new ApiError(400, 'closed', 'This discussion can no longer be replied to.');
  }
  const input = body(ctx.req);
  const { text, hasSpoiler } = validateText(input.body, 'reply');
  const floor = floorFor(thread.chapter_slug ? publishedChapterNumber(thread.chapter_slug) ?? null : null);
  const reveals = validateReveals(input.revealsThrough, floor);

  const dupe = await ctx.db.query(
    `SELECT 1 FROM comments WHERE account_id = $1 AND body = $2 AND created_at > now() - interval '1 hour'`,
    [account.id, text],
  );
  if (dupe.rows.length) throw new ApiError(409, 'duplicate', 'You have already posted this.');
  await spendPostLimits(ctx.db, account);

  const id = newId();
  await ctx.db.query(
    `INSERT INTO comments (id, chapter_slug, parent_id, account_id, body, reveals_through, has_spoiler)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    // Threads are one level deep: a reply to a reply lands on its discussion.
    [id, thread.chapter_slug, thread.id, account.id, text, reveals, hasSpoiler],
  );
  return json(201, { id });
};

const editComment: Handler = async (ctx) => {
  const account = await requireAccount(ctx);
  await limit(ctx.db, `edit:${account.id}`, LIMITS.edit);
  const row = await loadOwnedComment(ctx.db, ctx.params[0], account);
  if (row.parent_id === null) throw new ApiError(400, 'is_a_discussion', 'Edit the discussion itself, not this post.');
  if (row.state === 'removed') throw new ApiError(403, 'moderated', 'This post was removed by moderation and cannot be edited.');
  const input = body(ctx.req);
  const { text, hasSpoiler } = validateText(input.body, 'reply');
  const parent = await loadThread(ctx.db, row.parent_id, account);
  const floor = floorFor(parent.chapter_slug ? publishedChapterNumber(parent.chapter_slug) ?? null : null);
  const reveals = validateReveals(input.revealsThrough, floor);
  await ctx.db.query(
    `UPDATE comments SET body = $2, has_spoiler = $3, reveals_through = $4, edited_at = now() WHERE id = $1`,
    [row.id, text, hasSpoiler, reveals],
  );
  return json(200, { ok: true });
};

const deleteComment: Handler = async (ctx) => {
  const account = await requireAccount(ctx);
  const row = await loadOwnedComment(ctx.db, ctx.params[0], account);
  if (row.parent_id === null) throw new ApiError(400, 'is_a_discussion', 'Delete the discussion itself, not this post.');
  await ctx.db.transaction((tx) => removeComment(tx, row.id));
  return json(200, { ok: true });
};

async function reactableComment(db: Db, id: string) {
  if (!isUuid(id)) throw new ApiError(404, 'no_comment', 'That comment no longer exists.');
  const { rows } = await db.query<{ id: string; account_id: string | null }>(
    `SELECT id, account_id FROM comments WHERE id = $1 AND deleted_at IS NULL AND state = 'visible'`,
    [id],
  );
  if (!rows[0]) throw new ApiError(404, 'no_comment', 'That comment no longer exists.');
  return rows[0];
}

const addReaction: Handler = async (ctx) => {
  const account = await requireAccount(ctx);
  await limit(ctx.db, `reaction:${account.id}`, LIMITS.reaction);
  const comment = await reactableComment(ctx.db, ctx.params[0]);
  if (comment.account_id === account.id) throw new ApiError(400, 'own_comment', 'You cannot mark your own comment.');
  await ctx.db.query(`INSERT INTO reactions (comment_id, account_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [comment.id, account.id]);
  return json(200, { ok: true });
};

const removeReaction: Handler = async (ctx) => {
  const account = await requireAccount(ctx);
  if (!isUuid(ctx.params[0])) throw new ApiError(404, 'no_comment', 'That comment no longer exists.');
  await ctx.db.query(`DELETE FROM reactions WHERE comment_id = $1 AND account_id = $2`, [ctx.params[0], account.id]);
  return json(200, { ok: true });
};

const reportComment: Handler = async (ctx) => {
  const account = await requireAccount(ctx);
  await limit(ctx.db, `report:${account.id}`, LIMITS.report);
  const post = await reactableComment(ctx.db, ctx.params[0]);
  if (post.account_id === account.id) throw new ApiError(400, 'own_comment', 'You cannot report your own post.');
  const { reason, note } = body(ctx.req);
  if (typeof reason !== 'string' || !REASONS.includes(reason)) throw new ApiError(400, 'bad_reason', 'Choose a reason for the report.');
  const cleanNote = typeof note === 'string' ? cleanText(note).slice(0, 500) || null : null;
  await ctx.db.query(
    `INSERT INTO reports (id, comment_id, reporter_id, reason, note) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (comment_id, reporter_id) DO NOTHING`,
    [newId(), post.id, account.id, reason, cleanNote],
  );
  // Community safety valve: enough independent reports hide the post pending moderator review.
  await ctx.db.query(
    `UPDATE comments SET state = 'hidden' WHERE id = $1 AND state = 'visible'
     AND (SELECT count(*) FROM reports WHERE comment_id = $1 AND resolved_at IS NULL) >= $2`,
    [post.id, AUTO_HIDE_REPORTS],
  );
  return json(200, { ok: true });
};

const notifications: Handler = async (ctx) => {
  const account = await requireAccount(ctx);
  const { rows } = await ctx.db.query<{ id: string; discussion_id: string; title: string | null; handle: string | null; created_at: Date; unread: boolean }>(
    `SELECT r.id, r.parent_id AS discussion_id, t.title, a.handle, r.created_at,
            r.created_at > me.replies_seen_at AS unread
     FROM comments r
     JOIN comments t ON t.id = r.parent_id AND t.parent_id IS NULL
     JOIN accounts me ON me.id = $1
     LEFT JOIN accounts a ON a.id = r.account_id
     WHERE t.account_id = $1 AND (r.account_id IS NULL OR r.account_id <> $1)
       AND r.deleted_at IS NULL AND r.state = 'visible'
     ORDER BY r.created_at DESC LIMIT 20`,
    [account.id],
  );
  const moderated = await ctx.db.query<{ id: string; discussion_id: string | null; title: string | null; state: string }>(
    `SELECT m.id, m.parent_id AS discussion_id, t.title, m.state
     FROM comments m LEFT JOIN comments t ON t.id = m.parent_id
     WHERE m.account_id = $1 AND m.state <> 'visible' AND m.deleted_at IS NULL LIMIT 20`,
    [account.id],
  );
  return json(200, {
    replies: rows.map((r) => ({ id: r.id, discussionId: r.discussion_id, title: r.title, author: r.handle, createdAt: r.created_at, unread: r.unread })),
    moderated: moderated.rows.map((m) => ({ id: m.id, discussionId: m.discussion_id, title: m.title, state: m.state })),
  });
};

const markNotificationsSeen: Handler = async (ctx) => {
  const account = await requireAccount(ctx);
  await ctx.db.query(`UPDATE accounts SET replies_seen_at = now() WHERE id = $1`, [account.id]);
  return json(200, { ok: true });
};

async function requireModerator(ctx: Ctx): Promise<Account> {
  const account = await requireAccount(ctx);
  if (account.role !== 'moderator') throw new ApiError(403, 'forbidden', 'This area is for moderators.');
  return account;
}

const moderationQueue: Handler = async (ctx) => {
  await requireModerator(ctx);
  const { rows } = await ctx.db.query<{
    id: string; discussion_id: string | null; discussion_title: string | null; chapter_slug: string | null;
    body: string; state: string; handle: string | null; reports: string | number; reasons: string[];
  }>(
    `SELECT c.id, coalesce(c.parent_id, c.id) AS discussion_id, t.title AS discussion_title, c.chapter_slug,
            c.body, c.state, a.handle, count(r.id) AS reports, array_agg(DISTINCT r.reason) AS reasons
     FROM reports r
     JOIN comments c ON c.id = r.comment_id
     LEFT JOIN comments t ON t.id = coalesce(c.parent_id, c.id)
     LEFT JOIN accounts a ON a.id = c.account_id
     LEFT JOIN categories k ON k.slug = c.category
     WHERE r.resolved_at IS NULL AND c.deleted_at IS NULL
     GROUP BY c.id, t.title, a.handle ORDER BY count(r.id) DESC LIMIT 100`,
  );
  return json(200, {
    items: rows.map((r) => ({
      id: r.id,
      discussionId: r.discussion_id,
      discussionTitle: r.discussion_title,
      chapterSlug: r.chapter_slug,
      body: r.body,
      state: r.state,
      author: r.handle,
      reports: Number(r.reports),
      reasons: r.reasons,
    })),
  });
};

const moderate: Handler = async (ctx) => {
  await requireModerator(ctx);
  const id = ctx.params[0];
  if (!isUuid(id)) throw new ApiError(404, 'no_comment', 'That comment no longer exists.');
  const { state } = body(ctx.req);
  if (state !== 'visible' && state !== 'hidden' && state !== 'removed') throw new ApiError(400, 'bad_state', 'Unknown moderation state.');
  const result = await ctx.db.query(`UPDATE comments SET state = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [id, state]);
  if (!result.rows.length) throw new ApiError(404, 'no_comment', 'That comment no longer exists.');
  await ctx.db.query(`UPDATE reports SET resolved_at = now() WHERE comment_id = $1 AND resolved_at IS NULL`, [id]);
  return json(200, { ok: true });
};

// ───────────────────────── routing ─────────────────────────

const routes: Array<[string, RegExp, Handler]> = [
  ['GET', /^\/api\/health$/, health],
  ['POST', /^\/api\/account$/, createAccount],
  ['DELETE', /^\/api\/account$/, deleteAccount],
  ['GET', /^\/api\/me$/, me],
  ['POST', /^\/api\/session$/, signIn],
  ['DELETE', /^\/api\/session$/, signOut],
  ['DELETE', /^\/api\/sessions$/, signOutEverywhere],
  ['GET', /^\/api\/vault$/, getVault],
  ['PUT', /^\/api\/vault$/, putVault],
  ['GET', /^\/api\/forum$/, forumIndex],
  ['GET', /^\/api\/forum\/threads$/, listThreads],
  ['POST', /^\/api\/forum\/threads$/, createThread],
  ['GET', /^\/api\/forum\/threads\/chapter\/([a-z0-9-]{1,80})$/, chapterRoom],
  ['POST', /^\/api\/forum\/threads\/chapter\/([a-z0-9-]{1,80})$/, createChapterRoom],
  ['GET', /^\/api\/forum\/threads\/([^/]+)$/, getThread],
  ['PATCH', /^\/api\/forum\/threads\/([^/]+)$/, updateThread],
  ['DELETE', /^\/api\/forum\/threads\/([^/]+)$/, deleteThread],
  ['POST', /^\/api\/forum\/threads\/([^/]+)\/comments$/, createReply],
  ['PATCH', /^\/api\/comments\/([^/]+)$/, editComment],
  ['DELETE', /^\/api\/comments\/([^/]+)$/, deleteComment],
  ['PUT', /^\/api\/comments\/([^/]+)\/reaction$/, addReaction],
  ['DELETE', /^\/api\/comments\/([^/]+)\/reaction$/, removeReaction],
  ['POST', /^\/api\/comments\/([^/]+)\/report$/, reportComment],
  ['GET', /^\/api\/notifications$/, notifications],
  ['POST', /^\/api\/notifications\/seen$/, markNotificationsSeen],
  ['GET', /^\/api\/moderation\/reports$/, moderationQueue],
  ['POST', /^\/api\/moderation\/comments\/([^/]+)$/, moderate],
];

/** CSRF defence for state-changing requests: custom header (forces CORS preflight) + same-origin check. */
function checkCsrf(req: ApiRequest) {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  if (req.headers['x-dusk-client'] !== '1') throw new ApiError(403, 'csrf', 'This request was blocked for your protection.');
  const origin = req.headers.origin;
  if (origin) {
    const host = (req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim();
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      /* fallthrough */
    }
    if (!host || originHost !== host) throw new ApiError(403, 'csrf', 'This request was blocked for your protection.');
  }
}

export async function handle(req: ApiRequest, getDb: () => Promise<Db> | undefined): Promise<ApiResponse> {
  try {
    const match = routes.find(([method, pattern]) => method === req.method && pattern.test(req.path));
    if (!match) {
      const pathExists = routes.some(([, pattern]) => pattern.test(req.path));
      throw new ApiError(pathExists ? 405 : 404, pathExists ? 'method' : 'not_found', 'There is nothing here.');
    }
    checkCsrf(req);
    const dbPromise = getDb();
    if (!dbPromise) {
      throw new ApiError(503, 'not_configured', 'Accounts and discussions are not connected yet. Reading is unaffected.');
    }
    let db: Db;
    try {
      db = await dbPromise;
    } catch (error) {
      // Without this line an unreachable database is completely silent and
      // indistinguishable from a healthy deployment. describeDbError keeps the
      // diagnostic value while stripping anything credential-bearing.
      console.error(`[api] database unavailable: ${describeDbError(error)}`);
      throw new ApiError(503, 'db_unavailable', 'The reading room’s records are unavailable right now. Reading is unaffected.');
    }
    const [, pattern, handler] = match;
    const params = (req.path.match(pattern) ?? []).slice(1).map((p) => decodeURIComponent(p));
    return await handler({ db, req, params });
  } catch (error) {
    if (error instanceof ApiError) {
      return json(error.status, { error: { code: error.code, message: error.message, ...error.extra } });
    }
    // Log only the error class and route shape — never bodies, cookies, keys or parameters.
    console.error(`[api] ${req.method} ${req.path.replace(/[0-9a-f-]{36}/gi, ':id')} failed: ${(error as Error)?.name ?? 'Error'}`);
    return json(500, { error: { code: 'server', message: 'The server could not complete that request. Nothing was lost; please try again shortly.' } });
  }
}
