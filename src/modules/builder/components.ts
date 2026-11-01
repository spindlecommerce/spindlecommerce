import { asc, eq, inArray, or, sql } from "drizzle-orm";
import type { Database } from "../../db/client.ts";
import { InvalidStateError, NotFoundError, ValidationError } from "../../lib/errors.ts";
import { parseInput } from "../../lib/validation.ts";
import { emit } from "../integrations/outbox.ts";
import { componentDefinitionSchema, type ComponentDefinition } from "./model.ts";
import { builderComponents, builderPages } from "./tables.ts";

export type BuilderComponent = typeof builderComponents.$inferSelect;

export const listComponents = (db: Database) => db.select().from(builderComponents).orderBy(asc(builderComponents.kind), asc(builderComponents.groupName), asc(builderComponents.name));

/** The library keyed by code, for document validation. */
export const loadDefinitions = async (db: Database): Promise<Map<string, ComponentDefinition>> =>
  new Map((await listComponents(db)).map((c) => [c.code, toDefinition(c)]));

export const toDefinition = (c: BuilderComponent): ComponentDefinition => ({
  code: c.code,
  kind: c.kind,
  name: c.name,
  description: c.description,
  groupName: c.groupName,
  icon: c.icon,
  previewImageUrl: c.previewImageUrl,
  fields: c.fields,
  variations: c.variations,
  routable: c.routable,
  singleton: c.singleton,
  templateFor: c.templateFor ?? null,
  sectionsFor: c.sectionsFor ?? null,
});

const parseDefinition = (input: unknown, path: string[] = ["input"]) => parseInput(componentDefinitionSchema, input, path);

/** Allowed components that are not in the library. `at` gives each definition's error path. */
const unknownReferences = (definitions: ComponentDefinition[], known: Set<string>, at: (index: number) => string[] = () => ["input"]) =>
  definitions.flatMap((d, i) =>
    d.fields.flatMap((f, j) => (f.allowedComponents ?? []).filter((code) => !known.has(code)).map((code) => ({ path: [...at(i), "fields", String(j), "allowedComponents"], message: `No component ${code}` }))),
  );

const columns = (d: ComponentDefinition) => ({
  code: d.code,
  kind: d.kind,
  name: d.name,
  description: d.description ?? null,
  groupName: d.groupName ?? null,
  icon: d.icon ?? null,
  previewImageUrl: d.previewImageUrl ?? null,
  fields: d.fields,
  variations: d.variations,
  // Templates and sections are never routable: they show on product and category pages.
  routable: d.kind === "content_type" && !d.templateFor && !d.sectionsFor ? (d.routable ?? true) : false,
  singleton: d.kind === "content_type" ? (d.singleton ?? false) : false,
  templateFor: d.templateFor ?? null,
  sectionsFor: d.kind === "content_type" ? (d.sectionsFor ?? null) : null,
});

/** Pages were validated against `templateFor` and `sectionsFor`: neither may change while used. */
const assertBindingUnchanged = async (db: Database, existing: BuilderComponent, next: ComponentDefinition, at: string[]) => {
  const field = (existing.templateFor ?? null) !== (next.templateFor ?? null) ? "templateFor" : (existing.sectionsFor ?? null) !== (next.sectionsFor ?? null) ? "sectionsFor" : null;
  if (!field) return;
  const used = await componentUsage(db, existing.code);
  const change = field === "templateFor" ? "what it is a template for" : "whose sections it holds";
  if (used.length) throw new ValidationError("Used on pages", [{ path: [...at, field], message: `${existing.name} is used on ${used.length} page${used.length === 1 ? "" : "s"}; remove it from them before changing ${change}` }]);
};

export const createComponent = async (db: Database, input: unknown) =>
  db.transaction(async (tx) => {
    const definition = parseDefinition(input);
    const existing = await tx.query.builderComponents.findFirst({ where: eq(builderComponents.code, definition.code) });
    if (existing) throw new ValidationError("Code already used", [{ path: ["input", "code"], message: `A component ${definition.code} already exists` }]);
    const known = new Set([...(await tx.select({ code: builderComponents.code }).from(builderComponents)).map((c) => c.code), definition.code]);
    const unknown = unknownReferences([definition], known);
    if (unknown.length) throw new ValidationError("Unknown components", unknown);
    const [row] = await tx.insert(builderComponents).values({ ...columns(definition), source: "admin" }).returning();
    await emit(tx, { type: "component.updated", aggregateType: "Component", aggregateId: row!.id, payload: { code: row!.code } });
    return row!;
  });

/** Code and kind are fixed: pages refer to components by code. */
export const updateComponent = async (db: Database, id: string, input: unknown) =>
  db.transaction(async (tx) => {
    const existing = await tx.query.builderComponents.findFirst({ where: eq(builderComponents.id, id) });
    if (!existing) throw new NotFoundError("Component", id);
    const definition = parseDefinition({ ...toDefinition(existing), ...(input as object), code: existing.code, kind: existing.kind });
    await assertBindingUnchanged(tx, existing, definition, ["input"]);
    const known = new Set((await tx.select({ code: builderComponents.code }).from(builderComponents)).map((c) => c.code));
    const unknown = unknownReferences([definition], known);
    if (unknown.length) throw new ValidationError("Unknown components", unknown);
    const [row] = await tx
      .update(builderComponents)
      .set({ ...columns(definition), source: "admin", revision: sql`${builderComponents.revision} + 1`, updatedAt: new Date() })
      .where(eq(builderComponents.id, id))
      .returning();
    await emit(tx, { type: "component.updated", aggregateType: "Component", aggregateId: id, payload: { code: row!.code } });
    return row!;
  });

/** Pages whose draft or published version uses the component anywhere in their tree. */
export const componentUsage = async (db: Database, code: string) => {
  const uses = sql`jsonb_path_exists(${builderPages.draft}, '$.** ? (@.component == $c)', jsonb_build_object('c', ${code}::text)) or jsonb_path_exists(coalesce(${builderPages.published}, '{}'::jsonb), '$.** ? (@.component == $c)', jsonb_build_object('c', ${code}::text))`;
  const rows = await db.select({ id: builderPages.id }).from(builderPages).where(or(eq(builderPages.type, code), uses));
  return rows.map((r) => r.id);
};

export const deleteComponent = async (db: Database, id: string) =>
  db.transaction(async (tx) => {
    const existing = await tx.query.builderComponents.findFirst({ where: eq(builderComponents.id, id) });
    if (!existing) throw new NotFoundError("Component", id);
    const used = await componentUsage(tx, existing.code);
    if (used.length) throw new InvalidStateError(`${existing.name} is used on ${used.length} page${used.length === 1 ? "" : "s"}; remove it from them first`);
    const referencing = (await tx.select().from(builderComponents)).filter((c) => c.id !== id && c.fields.some((f) => f.allowedComponents?.includes(existing.code)));
    if (referencing.length) throw new InvalidStateError(`Allowed in ${referencing.map((c) => c.name).join(", ")}; remove it there first`);
    await tx.delete(builderComponents).where(eq(builderComponents.id, id));
    await emit(tx, { type: "component.updated", aggregateType: "Component", aggregateId: id, payload: { code: existing.code, deleted: true } });
    return id;
  });

export type SyncResult = { created: string[]; updated: string[]; unchanged: string[]; removed: string[] };

/** JSON with sorted keys, since jsonb does not keep key order. */
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.entries(value)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
          .join(",")}}`
      : JSON.stringify(value);

const sameDefinition = (a: ComponentDefinition, b: ComponentDefinition) => canonical(columns(a)) === canonical(columns(b));

/**
 * Upsert definitions from a frontend's code (@spindlecommerce/storefront-cli). With `prune`, also deletes
 * code-managed components missing from the set; fails if pages still use them. All or nothing.
 */
export const syncComponents = async (db: Database, input: unknown, options: { prune?: boolean } = {}): Promise<SyncResult> =>
  db.transaction(async (tx) => {
    if (!Array.isArray(input) || input.length === 0 || input.length > 500) throw new ValidationError("Expected 1 to 500 component definitions", [{ path: ["definitions"], message: "Between 1 and 500" }]);
    const definitions = input.map((d, i) => parseDefinition(d, ["definitions", String(i)]));
    const codes = definitions.map((d) => d.code);
    const duplicate = codes.find((c, i) => codes.indexOf(c) !== i);
    if (duplicate) throw new ValidationError("Duplicate codes", [{ path: ["definitions"], message: `${duplicate} appears twice` }]);
    const existing = new Map((await tx.select().from(builderComponents)).map((c) => [c.code, c]));
    const removing = options.prune ? [...existing.values()].filter((c) => c.source === "code" && !codes.includes(c.code)) : [];
    const known = new Set([...[...existing.keys()].filter((c) => !removing.some((r) => r.code === c)), ...codes]);
    const unknown = unknownReferences(definitions, known, (i) => ["definitions", String(i)]);
    if (unknown.length) throw new ValidationError("Unknown components", unknown);
    const result: SyncResult = { created: [], updated: [], unchanged: [], removed: [] };
    const changedIds: { id: string; code: string; deleted?: boolean }[] = [];
    for (const definition of definitions) {
      const current = existing.get(definition.code);
      if (!current) {
        const [row] = await tx.insert(builderComponents).values({ ...columns(definition), source: "code" }).returning({ id: builderComponents.id });
        changedIds.push({ id: row!.id, code: definition.code });
        result.created.push(definition.code);
      } else if (current.kind !== definition.kind) {
        throw new ValidationError("Kind changed", [{ path: ["definitions", String(codes.indexOf(definition.code)), "kind"], message: `${definition.code} is a ${current.kind}; delete it before changing its kind` }]);
      } else if (sameDefinition(toDefinition(current), definition) && current.source === "code") {
        result.unchanged.push(definition.code);
      } else {
        await assertBindingUnchanged(tx, current, definition, ["definitions", String(codes.indexOf(definition.code))]);
        await tx.update(builderComponents).set({ ...columns(definition), source: "code", revision: sql`${builderComponents.revision} + 1`, updatedAt: new Date() }).where(eq(builderComponents.id, current.id));
        changedIds.push({ id: current.id, code: definition.code });
        result.updated.push(definition.code);
      }
    }
    for (const component of removing) {
      const used = await componentUsage(tx, component.code);
      if (used.length) throw new InvalidStateError(`${component.code} is still used on ${used.length} page${used.length === 1 ? "" : "s"}; keep it or remove it from them`);
    }
    if (removing.length) await tx.delete(builderComponents).where(inArray(builderComponents.id, removing.map((c) => c.id)));
    result.removed = removing.map((c) => c.code);
    changedIds.push(...removing.map((c) => ({ id: c.id, code: c.code, deleted: true })));
    await emit(tx, ...changedIds.map((c) => ({ type: "component.updated" as const, aggregateType: "Component", aggregateId: c.id, payload: { code: c.code, ...(c.deleted ? { deleted: true } : {}), source: "code" } })));
    return result;
  });
