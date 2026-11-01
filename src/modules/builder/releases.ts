import { and, asc, desc, eq, inArray, isNotNull, lte } from "drizzle-orm";
import type { Database } from "../../db/client.ts";
import { InvalidStateError, NotFoundError, ValidationError, type FieldError } from "../../lib/errors.ts";
import { emit } from "../integrations/outbox.ts";
import { loadDefinitions } from "./components.ts";
import { pagesNotReady, publishPageInTransaction, type Actor } from "./pages.ts";
import { builderPages, builderReleasePages, builderReleases } from "./tables.ts";

export type Release = typeof builderReleases.$inferSelect;

export const listReleases = (db: Database) => db.select().from(builderReleases).orderBy(desc(builderReleases.createdAt));

export const getRelease = async (db: Database, id: string) => {
  const release = await db.query.builderReleases.findFirst({ where: eq(builderReleases.id, id) });
  if (!release) throw new NotFoundError("Release", id);
  return release;
};

export const releasePageIds = async (db: Database, releaseId: string) =>
  (await db.select({ pageId: builderReleasePages.pageId }).from(builderReleasePages).where(eq(builderReleasePages.releaseId, releaseId)).orderBy(asc(builderReleasePages.addedAt))).map((r) => r.pageId);

const assertOpen = (release: Release) => {
  if (release.status === "published") throw new InvalidStateError(`${release.name} was published on ${release.publishedAt?.toISOString().slice(0, 10)}; create a new release`);
};

const checkSchedule = (at: Date | null | undefined) => {
  if (at && at.getTime() <= Date.now()) throw new ValidationError("Schedule in the future", [{ path: ["input", "scheduledAt"], message: "Pick a time in the future, or publish now" }]);
};

/** Checked when scheduling, so the release does not fail at its time. */
export const assertPagesReady = async (db: Database, pageIds: string[]) => {
  const problems = await pagesNotReady(db, pageIds);
  if (problems.length) throw new ValidationError(`${new Set(problems.map((p) => p.path[1])).size} page(s) are not ready to publish`, problems);
};

export const createRelease = async (db: Database, input: { name: string; description?: string | null; scheduledAt?: Date | null }, actor: Actor) => {
  if (!input.name.trim()) throw new ValidationError("Name the release", [{ path: ["input", "name"], message: "Required" }]);
  checkSchedule(input.scheduledAt);
  const [row] = await db
    .insert(builderReleases)
    .values({ name: input.name.trim(), description: input.description ?? null, scheduledAt: input.scheduledAt ?? null, status: input.scheduledAt ? "scheduled" : "open", createdBy: actor.staffId })
    .returning();
  return row!;
};

/** `scheduledAt: null` unschedules; omitting it leaves the schedule alone. */
export const updateRelease = async (db: Database, id: string, input: { name?: string; description?: string | null; scheduledAt?: Date | null }) => {
  const release = await getRelease(db, id);
  assertOpen(release);
  checkSchedule(input.scheduledAt);
  const scheduledAt = input.scheduledAt === undefined ? release.scheduledAt : input.scheduledAt;
  if (input.scheduledAt) await assertPagesReady(db, await releasePageIds(db, id));
  const [row] = await db
    .update(builderReleases)
    .set({
      ...(input.name != null ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      scheduledAt,
      status: scheduledAt ? "scheduled" : "open",
      error: null,
      updatedAt: new Date(),
    })
    .where(eq(builderReleases.id, id))
    .returning();
  return row!;
};

export const addPagesToRelease = async (db: Database, id: string, pageIds: string[]) =>
  db.transaction(async (tx) => {
    const release = await getRelease(tx, id);
    assertOpen(release);
    const found = await tx.select({ id: builderPages.id }).from(builderPages).where(inArray(builderPages.id, pageIds));
    const missing = pageIds.filter((p) => !found.some((f) => f.id === p));
    if (missing.length) throw new NotFoundError("Page", missing.join(", "));
    if (pageIds.length) await tx.insert(builderReleasePages).values(pageIds.map((pageId) => ({ releaseId: id, pageId }))).onConflictDoNothing();
    return release;
  });

export const removePagesFromRelease = async (db: Database, id: string, pageIds: string[]) => {
  const release = await getRelease(db, id);
  assertOpen(release);
  if (pageIds.length) await db.delete(builderReleasePages).where(and(eq(builderReleasePages.releaseId, id), inArray(builderReleasePages.pageId, pageIds)));
  return release;
};

/** All pages go live together or none do. Each page's current draft is what gets published. */
export const publishRelease = async (db: Database, id: string, actor: Actor) =>
  db.transaction(async (tx) => {
    const release = await getRelease(tx, id);
    assertOpen(release);
    const pageIds = await releasePageIds(tx, id);
    if (!pageIds.length) throw new InvalidStateError("The release has no pages");
    const components = await loadDefinitions(tx);
    const pages = await tx.select().from(builderPages).where(inArray(builderPages.id, pageIds));
    const problems: FieldError[] = [];
    for (const page of pages) {
      try {
        await publishPageInTransaction(tx, page, components, actor, ["pages", page.id]);
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        problems.push(...error.fieldErrors);
      }
    }
    if (problems.length) throw new ValidationError(`${new Set(problems.map((p) => p.path[1])).size} page(s) in the release are not ready to publish`, problems);
    const [row] = await tx.update(builderReleases).set({ status: "published", publishedAt: new Date(), publishedBy: actor.staffId, error: null, updatedAt: new Date() }).where(eq(builderReleases.id, id)).returning();
    await emit(tx, { type: "release.published", aggregateType: "Release", aggregateId: id, payload: { name: release.name, pageIds } });
    return row!;
  });

export const deleteRelease = async (db: Database, id: string) => {
  await getRelease(db, id);
  await db.delete(builderReleases).where(eq(builderReleases.id, id));
  return id;
};

/** Publish releases whose time has come. A failure marks the release and leaves its pages alone. */
export const publishDueReleases = async (db: Database, now = new Date()) => {
  const due = await db.select().from(builderReleases).where(and(eq(builderReleases.status, "scheduled"), isNotNull(builderReleases.scheduledAt), lte(builderReleases.scheduledAt, now)));
  let published = 0;
  for (const release of due) {
    try {
      await publishRelease(db, release.id, { staffId: release.createdBy });
      published++;
    } catch (error) {
      const message = error instanceof ValidationError ? `${error.message}: ${error.fieldErrors.slice(0, 5).map((f) => f.message).join("; ")}` : error instanceof Error ? error.message : "Publishing failed";
      await db.update(builderReleases).set({ status: "failed", error: message.slice(0, 1000), updatedAt: new Date() }).where(eq(builderReleases.id, release.id));
    }
  }
  return published;
};
