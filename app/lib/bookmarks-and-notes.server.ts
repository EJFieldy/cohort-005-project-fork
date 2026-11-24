import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, desc, eq } from "drizzle-orm";
import * as schema from "~/db/schema";
import { bookmarks, courses, lessons, modules, notes } from "~/db/schema";
import { NOTE_TOO_LONG, noteBodySchema } from "~/lib/bookmarks-and-notes";

// ─── Bookmarks and Notes ───
// What a Student attaches to a Lesson for themselves. See GLOSSARY.md for the
// language.
//
// A Note is private to the Student who wrote it: every read here takes the
// owning Student's id, and nothing may show a Note to anyone else.
//
// Every function takes the database first, so tests can hand in an in-memory
// one. Uses positional parameters (project convention). Callers check content
// access.

export type Db = BetterSQLite3Database<typeof schema>;

function isStudentsBookmark(userId: number, lessonId: number) {
  return and(eq(bookmarks.userId, userId), eq(bookmarks.lessonId, lessonId));
}

function isStudentsNote(userId: number, lessonId: number) {
  return and(eq(notes.userId, userId), eq(notes.lessonId, lessonId));
}

export function isBookmarked(db: Db, userId: number, lessonId: number) {
  return !!db
    .select({ id: bookmarks.id })
    .from(bookmarks)
    .where(isStudentsBookmark(userId, lessonId))
    .get();
}

/** Returns whether the Lesson is now bookmarked. */
export function toggleBookmark(
  db: Db,
  userId: number,
  lessonId: number,
  now: Date
): boolean {
  const removed = db
    .delete(bookmarks)
    .where(isStudentsBookmark(userId, lessonId))
    .returning({ id: bookmarks.id })
    .all();
  if (removed.length > 0) return false;

  db.insert(bookmarks)
    .values({ userId, lessonId, createdAt: now.toISOString() })
    .onConflictDoNothing()
    .run();
  return true;
}

/** The Student's own Note on a Lesson, or null if they have none. */
export function getNote(db: Db, userId: number, lessonId: number) {
  const note = db
    .select({ body: notes.body, updatedAt: notes.updatedAt })
    .from(notes)
    .where(isStudentsNote(userId, lessonId))
    .get();
  return note ?? null;
}

export type SaveNoteResult = { ok: true } | { ok: false; error: string };

/**
 * Writes the Student's one Note on a Lesson, replacing the body of any Note
 * already there. A blank body removes the Note.
 */
export function saveNote(
  db: Db,
  userId: number,
  lessonId: number,
  body: string,
  now: Date
): SaveNoteResult {
  const parsed = noteBodySchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: NOTE_TOO_LONG };
  }

  if (parsed.data.length === 0) {
    db.delete(notes).where(isStudentsNote(userId, lessonId)).run();
    return { ok: true };
  }

  const savedAt = now.toISOString();
  db.insert(notes)
    .values({
      userId,
      lessonId,
      body: parsed.data,
      createdAt: savedAt,
      updatedAt: savedAt,
    })
    .onConflictDoUpdate({
      target: [notes.userId, notes.lessonId],
      set: { body: parsed.data, updatedAt: savedAt },
    })
    .run();
  return { ok: true };
}

const lessonColumns = {
  lessonId: lessons.id,
  lessonTitle: lessons.title,
  moduleTitle: modules.title,
  courseId: courses.id,
  courseTitle: courses.title,
  courseSlug: courses.slug,
};

/** The Student's own Bookmarks, newest first. */
export function listBookmarks(db: Db, userId: number) {
  return db
    .select({ id: bookmarks.id, ...lessonColumns })
    .from(bookmarks)
    .innerJoin(lessons, eq(lessons.id, bookmarks.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .innerJoin(courses, eq(courses.id, modules.courseId))
    .where(eq(bookmarks.userId, userId))
    .orderBy(desc(bookmarks.createdAt), desc(bookmarks.id))
    .all();
}

/** The Student's own Notes, last edited first. */
export function listNotes(db: Db, userId: number) {
  return db
    .select({
      id: notes.id,
      body: notes.body,
      updatedAt: notes.updatedAt,
      ...lessonColumns,
    })
    .from(notes)
    .innerJoin(lessons, eq(lessons.id, notes.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .innerJoin(courses, eq(courses.id, modules.courseId))
    .where(eq(notes.userId, userId))
    .orderBy(desc(notes.updatedAt), desc(notes.id))
    .all();
}
