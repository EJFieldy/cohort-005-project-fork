import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { eq, inArray } from "drizzle-orm";
import * as schema from "~/db/schema";
import {
  bookmarks,
  comments,
  lessonProgress,
  lessons,
  modules,
  notes,
  quizAnswers,
  quizAttempts,
  quizOptions,
  quizQuestions,
  quizzes,
  videoWatchEvents,
} from "~/db/schema";
import {
  archiveForCommentSafely,
  type Notifications,
} from "~/lib/notifications.server";

// ─── Deleting Lessons ───
// Foreign keys are on and nothing cascades, so deleting a Lesson deletes what
// is attached to it first: Bookmarks, Notes, progress, watch history, comments
// and its quizzes. One transaction, so a failure leaves the Lesson whole.
//
// Every function takes the database first and the Notifications port last, so
// tests can hand in their own. Uses positional parameters (project convention).

export type Db = BetterSQLite3Database<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Deletes a Lesson and everything attached to it. */
export async function deleteLesson(
  db: Db,
  lessonId: number,
  notifications: Notifications
): Promise<void> {
  const commentIds = db.transaction((tx) =>
    deleteLessonsInTransaction(tx, [lessonId])
  );
  await archiveForComments(commentIds, notifications);
}

/** Deletes a module, its Lessons, and everything attached to them. */
export async function deleteModule(
  db: Db,
  moduleId: number,
  notifications: Notifications
): Promise<void> {
  const commentIds = db.transaction((tx) => {
    const lessonIds = tx
      .select({ id: lessons.id })
      .from(lessons)
      .where(eq(lessons.moduleId, moduleId))
      .all()
      .map((lesson) => lesson.id);
    const deleted = deleteLessonsInTransaction(tx, lessonIds);
    tx.delete(modules).where(eq(modules.id, moduleId)).run();
    return deleted;
  });
  await archiveForComments(commentIds, notifications);
}

/** Returns the ids of the comments that went with the Lessons. */
function deleteLessonsInTransaction(tx: Tx, lessonIds: number[]): number[] {
  deleteQuizzes(tx, lessonIds);

  tx.delete(bookmarks).where(inArray(bookmarks.lessonId, lessonIds)).run();
  tx.delete(notes).where(inArray(notes.lessonId, lessonIds)).run();
  tx.delete(lessonProgress)
    .where(inArray(lessonProgress.lessonId, lessonIds))
    .run();
  tx.delete(videoWatchEvents)
    .where(inArray(videoWatchEvents.lessonId, lessonIds))
    .run();
  const deletedComments = tx
    .delete(comments)
    .where(inArray(comments.lessonId, lessonIds))
    .returning({ id: comments.id })
    .all();

  tx.delete(lessons).where(inArray(lessons.id, lessonIds)).run();
  return deletedComments.map((comment) => comment.id);
}

// Answers point at options and questions as well as attempts, so they go first.
function deleteQuizzes(tx: Tx, lessonIds: number[]) {
  const quizIds = tx
    .select({ id: quizzes.id })
    .from(quizzes)
    .where(inArray(quizzes.lessonId, lessonIds))
    .all()
    .map((quiz) => quiz.id);
  const attemptIds = tx
    .select({ id: quizAttempts.id })
    .from(quizAttempts)
    .where(inArray(quizAttempts.quizId, quizIds))
    .all()
    .map((attempt) => attempt.id);
  const questionIds = tx
    .select({ id: quizQuestions.id })
    .from(quizQuestions)
    .where(inArray(quizQuestions.quizId, quizIds))
    .all()
    .map((question) => question.id);

  tx.delete(quizAnswers).where(inArray(quizAnswers.attemptId, attemptIds)).run();
  tx.delete(quizAttempts).where(inArray(quizAttempts.id, attemptIds)).run();
  tx.delete(quizOptions)
    .where(inArray(quizOptions.questionId, questionIds))
    .run();
  tx.delete(quizQuestions).where(inArray(quizQuestions.id, questionIds)).run();
  tx.delete(quizzes).where(inArray(quizzes.id, quizIds)).run();
}

async function archiveForComments(
  commentIds: number[],
  notifications: Notifications
) {
  for (const commentId of commentIds) {
    await archiveForCommentSafely(notifications, commentId);
  }
}
