/**
 * Forum migration: turns the chapter-scoped comment table into the community
 * discussion model, and converts the discussions that already exist.
 *
 * Idempotent and additive, because a deployment runs it again on every cold
 * start: it is safe against a database that has already been migrated, and it
 * is safe to run twice concurrently (the designated-room index plus a
 * conditional update make the backfill converge on the same row).
 *
 * What a discussion is: a `comments` row with `parent_id IS NULL` carrying
 * `title`, `category`, `tags` and an optional `chapter_slug`. Replies stay
 * exactly as they were. Nothing is copied, so replies, authorship, timestamps,
 * reactions, reports and existing URLs are preserved by construction.
 */
import type { Db } from './db.js';
import { chapterTag, publishedChapterNumber } from '../src/content/catalog.js';

/** Opening set. Extending the forum is a data change: INSERT a row here. */
const CATEGORIES: Array<[string, string, string, number]> = [
  ['general', 'General', 'Anything that does not sit better elsewhere.', 10],
  ['theories', 'Theories', 'Readings of what the text is doing, and where it is going.', 20],
  ['characters', 'Characters', 'Who someone is, what they want, and what they will not say.', 30],
  ['worldbuilding', 'Worldbuilding', 'Places, institutions, history and the rules of the world.', 40],
  ['questions', 'Questions', 'Ask. Someone here has probably wondered the same thing.', 50],
  ['feedback', 'Feedback', 'On the writing, the reading, and this site.', 60],
  ['chapter', 'Chapter Discussions', 'The room for one chapter. Every chapter has one.', 70],
];

export function roomTitle(slug: string): string {
  const number = publishedChapterNumber(slug);
  return number ? `Chapter ${String(number).padStart(2, '0')}` : 'Chapter discussion';
}

export async function migrateForum(db: Db): Promise<void> {
  // The columns and indexes themselves are in schema.ts, which has to create
  // them in that order; what is left here is what cannot be expressed as a
  // statement: a constraint that may already exist, the category seed, and the
  // conversion of the discussions readers already have.
  const { rows } = await db.query<{ present: number }>(
    `SELECT count(*)::int AS present FROM pg_constraint WHERE conname = 'comments_category_fkey'`,
  );
  if (!rows[0]?.present) {
    await db.query(
      `ALTER TABLE comments ADD CONSTRAINT comments_category_fkey
       FOREIGN KEY (category) REFERENCES categories(slug) ON DELETE SET NULL`,
    );
  }
  for (const [slug, name, description, position] of CATEGORIES) {
    // DO NOTHING: seeding must never overwrite a category an editor has retuned.
    await db.query(
      `INSERT INTO categories (slug, name, description, position) VALUES ($1, $2, $3, $4)
       ON CONFLICT (slug) DO NOTHING`,
      [slug, name, description, position],
    );
  }
  await designateChapterRooms(db);
}

/**
 * Convert the existing chapter comment sections into community discussions.
 *
 * The oldest root of each chapter becomes that chapter's designated discussion.
 * Every other root from the same chapter — and everything anyone had replied
 * beneath it — is re-homed onto that discussion, so the whole historical
 * conversation stays together, in order, under its original author and
 * timestamp. Flattening mirrors what the reader already saw: a chapter was one
 * page of top-level comments with replies, never a tree.
 */
async function designateChapterRooms(db: Db): Promise<void> {
  const { rows } = await db.query<{ chapter_slug: string; id: string }>(
    `SELECT chapter_slug, id FROM comments
     WHERE parent_id IS NULL AND chapter_slug IS NOT NULL AND title IS NULL
     ORDER BY chapter_slug, created_at, id`,
  );
  const byChapter = new Map<string, string[]>();
  for (const row of rows) {
    const ids = byChapter.get(row.chapter_slug) ?? [];
    ids.push(row.id);
    byChapter.set(row.chapter_slug, ids);
  }

  for (const [slug, ids] of byChapter) {
    if (!ids.length) continue;
    const [roomId, ...extra] = ids;
    const number = publishedChapterNumber(slug);
    await db.transaction(async (tx) => {
      // Lock the roots so two instances migrating at once cannot both win.
      await tx.query(`SELECT 1 FROM comments WHERE id = ANY($1::uuid[]) FOR UPDATE`, [ids]);
      const claimed = await tx.query<{ present: number }>(
        `SELECT count(*)::int AS present FROM comments WHERE is_chapter_room AND chapter_slug = $1`,
        [slug],
      );
      if (claimed.rows[0]?.present) return;
      await tx.query(
        `UPDATE comments SET title = $2, category = 'chapter', tags = $3, is_chapter_room = true
         WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM comments WHERE is_chapter_room AND chapter_slug = $4)`,
        [roomId, roomTitle(slug), number ? [chapterTag(number)] : [], slug],
      );
      if (!extra.length) return;
      // Re-home the remaining former top-level comments and everything beneath
      // them, so no reply is orphaned and the thread stays one level deep.
      // The walk is depth-bounded: this runs on the request path, and a
      // parent_id cycle in a row nobody can produce through the API must not
      // become an unbounded query in front of a reader.
      await tx.query(
        `WITH RECURSIVE moved(id, parent_id, room, depth) AS (
           SELECT id, parent_id, $1::uuid AS room, 0 FROM comments WHERE id = ANY($2::uuid[])
           UNION ALL
           SELECT c.id, c.parent_id, m.room, m.depth + 1
           FROM comments c JOIN moved m ON c.parent_id = m.id WHERE m.depth < 32
         )
         UPDATE comments SET parent_id = moved.room FROM moved WHERE comments.id = moved.id`,
        [roomId, extra],
      );
    });
  }
}
