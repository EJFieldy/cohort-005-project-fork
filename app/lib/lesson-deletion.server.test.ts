import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { saveNote, toggleBookmark } from "./bookmarks-and-notes.server";
import { createComment } from "./comments.server";
import { deleteLesson, deleteModule } from "./lesson-deletion.server";
import {
  fakeNotifications,
  type FakeNotifications,
} from "./notifications.fake.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

// Every table that hangs off a Lesson, directly or through its quiz.
const DEPENDENTS: Record<string, SQLiteTable> = {
  bookmarks: schema.bookmarks,
  notes: schema.notes,
  lessonProgress: schema.lessonProgress,
  videoWatchEvents: schema.videoWatchEvents,
  comments: schema.comments,
  quizzes: schema.quizzes,
  quizQuestions: schema.quizQuestions,
  quizOptions: schema.quizOptions,
  quizAttempts: schema.quizAttempts,
  quizAnswers: schema.quizAnswers,
};

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let moduleId: number;
let notifications: FakeNotifications;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  notifications = fakeNotifications();
  moduleId = addModule();
});

function addModule() {
  return db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get().id;
}

function addBareLesson(inModuleId: number) {
  return db
    .insert(schema.lessons)
    .values({ moduleId: inModuleId, title: "Lesson", position: 1 })
    .returning()
    .get().id;
}

/** A Lesson with one row in every dependent table (two in comments). */
async function addUsedLesson(inModuleId: number) {
  const lessonId = addBareLesson(inModuleId);
  const userId = base.user.id;

  toggleBookmark(db, userId, lessonId, NOW);
  saveNote(db, userId, lessonId, "My note", NOW);
  db.insert(schema.lessonProgress)
    .values({
      userId,
      lessonId,
      status: schema.LessonProgressStatus.Completed,
    })
    .run();
  db.insert(schema.videoWatchEvents)
    .values({ userId, lessonId, eventType: "progress", positionSeconds: 30 })
    .run();

  const question = await createComment(
    db,
    userId,
    lessonId,
    null,
    "Why?",
    NOW,
    notifications
  );
  if (!question.ok) throw new Error(question.error);
  const reply = await createComment(
    db,
    base.instructor.id,
    lessonId,
    question.comment.id,
    "Because.",
    NOW,
    notifications
  );
  if (!reply.ok) throw new Error(reply.error);

  const quiz = db
    .insert(schema.quizzes)
    .values({ lessonId, title: "Quiz", passingScore: 0.7 })
    .returning()
    .get();
  const quizQuestion = db
    .insert(schema.quizQuestions)
    .values({
      quizId: quiz.id,
      questionText: "?",
      questionType: schema.QuestionType.MultipleChoice,
      position: 1,
    })
    .returning()
    .get();
  const option = db
    .insert(schema.quizOptions)
    .values({ questionId: quizQuestion.id, optionText: "A", isCorrect: true })
    .returning()
    .get();
  const attempt = db
    .insert(schema.quizAttempts)
    .values({ userId, quizId: quiz.id, score: 1, passed: true })
    .returning()
    .get();
  db.insert(schema.quizAnswers)
    .values({
      attemptId: attempt.id,
      questionId: quizQuestion.id,
      selectedOptionId: option.id,
    })
    .run();

  return lessonId;
}

function countDependents() {
  return Object.fromEntries(
    Object.entries(DEPENDENTS).map(([name, table]) => [
      name,
      db.select().from(table).all().length,
    ])
  );
}

const NONE = Object.fromEntries(
  Object.keys(DEPENDENTS).map((name) => [name, 0])
);

function lessonIds() {
  return db
    .select({ id: schema.lessons.id })
    .from(schema.lessons)
    .all()
    .map((lesson) => lesson.id);
}

describe("deleting a Lesson", () => {
  it("deletes a Lesson nobody has used", async () => {
    const lessonId = addBareLesson(moduleId);

    await deleteLesson(db, lessonId, notifications);

    expect(lessonIds()).toEqual([]);
  });

  it("deletes everything attached to the Lesson with it", async () => {
    const lessonId = await addUsedLesson(moduleId);

    await deleteLesson(db, lessonId, notifications);

    expect(lessonIds()).toEqual([]);
    expect(countDependents()).toEqual(NONE);
  });

  it("leaves other Lessons and what is attached to them alone", async () => {
    const keptId = await addUsedLesson(moduleId);
    const before = countDependents();
    const deletedId = await addUsedLesson(moduleId);

    await deleteLesson(db, deletedId, notifications);

    expect(lessonIds()).toEqual([keptId]);
    expect(countDependents()).toEqual(before);
  });

  it("archives the Notifications its comments caused", async () => {
    const lessonId = await addUsedLesson(moduleId);
    expect(notifications.feedOf(base.instructor.id)).toHaveLength(1);
    expect(notifications.feedOf(base.user.id)).toHaveLength(1);

    await deleteLesson(db, lessonId, notifications);

    expect(notifications.feedOf(base.instructor.id)).toEqual([]);
    expect(notifications.feedOf(base.user.id)).toEqual([]);
  });

  it("still deletes the Lesson when archiving a Notification fails", async () => {
    const lessonId = await addUsedLesson(moduleId);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    notifications.failWith(new Error("Knock is down"));

    await deleteLesson(db, lessonId, notifications);

    expect(lessonIds()).toEqual([]);
    logged.mockRestore();
  });
});

describe("deleting a module", () => {
  it("deletes its Lessons and everything attached to them", async () => {
    await addUsedLesson(moduleId);
    await addUsedLesson(moduleId);

    await deleteModule(db, moduleId, notifications);

    expect(db.select().from(schema.modules).all()).toEqual([]);
    expect(lessonIds()).toEqual([]);
    expect(countDependents()).toEqual(NONE);
  });

  it("leaves another module's Lessons alone", async () => {
    const otherModuleId = addModule();
    const keptId = await addUsedLesson(otherModuleId);
    const before = countDependents();
    await addUsedLesson(moduleId);

    await deleteModule(db, moduleId, notifications);

    expect(lessonIds()).toEqual([keptId]);
    expect(countDependents()).toEqual(before);
  });

  it("deletes a module with no Lessons", async () => {
    await deleteModule(db, moduleId, notifications);

    expect(db.select().from(schema.modules).all()).toEqual([]);
  });
});
