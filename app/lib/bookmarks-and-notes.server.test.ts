import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { UserRole } from "~/db/schema";
import {
  getNote,
  isBookmarked,
  listBookmarks,
  listNotes,
  saveNote,
  toggleBookmark,
} from "./bookmarks-and-notes.server";
import { approveRefundRequest, raiseRefundRequest } from "./refunds.server";
import { fakeNotifications } from "./notifications.fake.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

function minutesLater(minutes: number) {
  return new Date(NOW.getTime() + minutes * 60_000);
}

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let studentId: number;
let otherStudentId: number;
let lessonIds: number[];

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  studentId = base.user.id;
  otherStudentId = db
    .insert(schema.users)
    .values({
      name: "Other Student",
      email: "other@example.com",
      role: UserRole.Student,
    })
    .returning()
    .get().id;
  lessonIds = addLessons(base.course.id, ["Lesson 1", "Lesson 2"]);
});

function addLessons(courseId: number, titles: string[]) {
  const module = db
    .insert(schema.modules)
    .values({ courseId, title: "Basics", position: 1 })
    .returning()
    .get();
  return titles.map(
    (title, i) =>
      db
        .insert(schema.lessons)
        .values({ moduleId: module.id, title, position: i + 1 })
        .returning()
        .get().id
  );
}

function addOtherCourse() {
  return db
    .insert(schema.courses)
    .values({
      title: "Other Course",
      slug: "other-course",
      description: "Another course",
      salesCopy: "",
      instructorId: base.instructor.id,
      categoryId: base.category.id,
      status: schema.CourseStatus.Published,
    })
    .returning()
    .get();
}

describe("toggling a Bookmark", () => {
  it("bookmarks a Lesson, then removes the Bookmark", () => {
    expect(isBookmarked(db, studentId, lessonIds[0])).toBe(false);

    expect(toggleBookmark(db, studentId, lessonIds[0], NOW)).toBe(true);
    expect(isBookmarked(db, studentId, lessonIds[0])).toBe(true);

    expect(toggleBookmark(db, studentId, lessonIds[0], NOW)).toBe(false);
    expect(isBookmarked(db, studentId, lessonIds[0])).toBe(false);
  });

  it("leaves another Student's Bookmark on the same Lesson alone", () => {
    toggleBookmark(db, studentId, lessonIds[0], NOW);
    toggleBookmark(db, otherStudentId, lessonIds[0], NOW);

    toggleBookmark(db, studentId, lessonIds[0], NOW);

    expect(isBookmarked(db, otherStudentId, lessonIds[0])).toBe(true);
  });

  it("leaves the Student's other Bookmarks alone", () => {
    toggleBookmark(db, studentId, lessonIds[0], NOW);
    toggleBookmark(db, studentId, lessonIds[1], NOW);

    toggleBookmark(db, studentId, lessonIds[0], NOW);

    expect(isBookmarked(db, studentId, lessonIds[1])).toBe(true);
  });

  it("never holds two Bookmarks for one Student and Lesson", () => {
    toggleBookmark(db, studentId, lessonIds[0], NOW);

    expect(() =>
      db
        .insert(schema.bookmarks)
        .values({ userId: studentId, lessonId: lessonIds[0] })
        .run()
    ).toThrow(/UNIQUE/);
    expect(listBookmarks(db, studentId)).toHaveLength(1);
  });
});

describe("saving a Note", () => {
  it("has no Note until one is saved", () => {
    expect(getNote(db, studentId, lessonIds[0])).toBeNull();
  });

  it("creates the Note with the body trimmed", () => {
    expect(
      saveNote(db, studentId, lessonIds[0], "  # not *Markdown*\nline 2  ", NOW)
    ).toEqual({ ok: true });

    expect(getNote(db, studentId, lessonIds[0])).toEqual({
      body: "# not *Markdown*\nline 2",
      updatedAt: NOW.toISOString(),
    });
  });

  it("replaces the body and moves the last edited time on when saved again", () => {
    saveNote(db, studentId, lessonIds[0], "First", NOW);
    saveNote(db, studentId, lessonIds[0], "Second", minutesLater(5));

    expect(getNote(db, studentId, lessonIds[0])).toEqual({
      body: "Second",
      updatedAt: minutesLater(5).toISOString(),
    });
    expect(listNotes(db, studentId)).toHaveLength(1);
    expect(db.select().from(schema.notes).get()).toMatchObject({
      createdAt: NOW.toISOString(),
    });
  });

  it("accepts a body of exactly 2,000 characters", () => {
    const body = "a".repeat(2000);

    expect(saveNote(db, studentId, lessonIds[0], body, NOW)).toEqual({
      ok: true,
    });
    expect(getNote(db, studentId, lessonIds[0])?.body).toBe(body);
  });

  it("refuses a body over 2,000 characters and keeps the Note as it was", () => {
    saveNote(db, studentId, lessonIds[0], "Keep me", NOW);

    expect(
      saveNote(db, studentId, lessonIds[0], "a".repeat(2001), minutesLater(5))
    ).toEqual({
      ok: false,
      error: "Note must be 2,000 characters or fewer",
    });
    expect(getNote(db, studentId, lessonIds[0])).toEqual({
      body: "Keep me",
      updatedAt: NOW.toISOString(),
    });
  });

  it("removes the Note when the body is blank", () => {
    saveNote(db, studentId, lessonIds[0], "Mine", NOW);
    saveNote(db, otherStudentId, lessonIds[0], "Theirs", NOW);

    expect(saveNote(db, studentId, lessonIds[0], "  \n ", NOW)).toEqual({
      ok: true,
    });

    expect(getNote(db, studentId, lessonIds[0])).toBeNull();
    expect(getNote(db, otherStudentId, lessonIds[0])?.body).toBe("Theirs");
  });

  it("keeps each Student's Note on a Lesson separate", () => {
    saveNote(db, studentId, lessonIds[0], "Mine", NOW);
    saveNote(db, otherStudentId, lessonIds[0], "Theirs", NOW);

    expect(getNote(db, studentId, lessonIds[0])?.body).toBe("Mine");
    expect(getNote(db, otherStudentId, lessonIds[0])?.body).toBe("Theirs");
  });

  it("never holds two Notes for one Student and Lesson", () => {
    saveNote(db, studentId, lessonIds[0], "Mine", NOW);

    expect(() =>
      db
        .insert(schema.notes)
        .values({ userId: studentId, lessonId: lessonIds[0], body: "Again" })
        .run()
    ).toThrow(/UNIQUE/);
  });
});

describe("the Saved lists", () => {
  it("lists only the Student's own Bookmarks, newest first, with Lesson and Course", () => {
    const otherCourse = addOtherCourse();
    const [otherLessonId] = addLessons(otherCourse.id, ["Elsewhere"]);
    toggleBookmark(db, studentId, lessonIds[0], minutesLater(1));
    toggleBookmark(db, studentId, otherLessonId, minutesLater(3));
    toggleBookmark(db, studentId, lessonIds[1], minutesLater(2));
    toggleBookmark(db, otherStudentId, lessonIds[0], minutesLater(4));

    expect(listBookmarks(db, studentId)).toMatchObject([
      {
        lessonId: otherLessonId,
        lessonTitle: "Elsewhere",
        courseTitle: "Other Course",
        courseSlug: "other-course",
      },
      { lessonId: lessonIds[1], courseTitle: "Test Course" },
      { lessonId: lessonIds[0], courseTitle: "Test Course" },
    ]);
  });

  it("lists only the Student's own Notes, last edited first, with Lesson and Course", () => {
    const otherCourse = addOtherCourse();
    const [otherLessonId] = addLessons(otherCourse.id, ["Elsewhere"]);
    saveNote(db, studentId, lessonIds[0], "Oldest, then edited", NOW);
    saveNote(db, studentId, otherLessonId, "Elsewhere note", minutesLater(1));
    saveNote(db, studentId, lessonIds[0], "Edited", minutesLater(2));
    saveNote(db, otherStudentId, lessonIds[0], "Private", minutesLater(3));

    expect(listNotes(db, studentId)).toMatchObject([
      {
        lessonId: lessonIds[0],
        lessonTitle: "Lesson 1",
        courseTitle: "Test Course",
        courseSlug: "test-course",
        body: "Edited",
        updatedAt: minutesLater(2).toISOString(),
      },
      {
        lessonId: otherLessonId,
        courseTitle: "Other Course",
        body: "Elsewhere note",
      },
    ]);
  });

  it("are empty for a Student with nothing saved", () => {
    expect(listBookmarks(db, studentId)).toEqual([]);
    expect(listNotes(db, studentId)).toEqual([]);
  });
});

describe("approving a Refund Request", () => {
  it("keeps the Student's Bookmarks and Notes", async () => {
    const notifications = fakeNotifications();
    const platformAdmin = db
      .insert(schema.users)
      .values({
        name: "Pat Admin",
        email: "pat@example.com",
        role: UserRole.Admin,
      })
      .returning()
      .get();
    const purchase = db
      .insert(schema.purchases)
      .values({
        userId: studentId,
        courseId: base.course.id,
        amountPaid: 7900,
        createdAt: NOW.toISOString(),
      })
      .returning()
      .get();
    db.insert(schema.enrollments)
      .values({ userId: studentId, courseId: base.course.id })
      .run();
    toggleBookmark(db, studentId, lessonIds[0], NOW);
    saveNote(db, studentId, lessonIds[0], "Still here", NOW);

    const raised = await raiseRefundRequest(
      db,
      purchase.id,
      studentId,
      "It was not what I expected.",
      NOW,
      notifications
    );
    if (!raised.ok) throw new Error(raised.error);
    const approved = await approveRefundRequest(
      db,
      raised.refundRequestId,
      platformAdmin.id,
      null,
      NOW,
      notifications
    );

    expect(approved.ok).toBe(true);
    expect(isBookmarked(db, studentId, lessonIds[0])).toBe(true);
    expect(getNote(db, studentId, lessonIds[0])?.body).toBe("Still here");
  });
});
