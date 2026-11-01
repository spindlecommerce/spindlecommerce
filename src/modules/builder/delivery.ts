import { pickLocalized, type LocalizedText } from "../../lib/i18n.ts";
import type { ComponentDefinition, FieldDefinition, ImageValue, LinkValue, ListItem, PageDocument, PageNode } from "./model.ts";

/** Resolve a stored page document for one locale, channel and time, as a frontend renders it. */

export type DeliveredImage = { url: string; alt: string | null; width: number | null; height: number | null };
export type DeliveredLink = { kind: LinkValue["kind"]; href: string | null; id: string | null; newTab: boolean };
export type DeliveredNode = { id: string; component: string; variation: string | null; fields: Record<string, unknown> };
export type DeliveredItem = { id: string; fields: Record<string, unknown> };

export type DeliveryOptions = {
  components: ReadonlyMap<string, ComponentDefinition>;
  locale: string;
  fallbackLocale: string;
  /** Global id of the channel being served. */
  channelId: string;
  now: Date;
};

export type Delivery = {
  title: string | null;
  seo: { title: string | null; description: string | null; image: DeliveredImage | null; noIndex: boolean };
  root: DeliveredNode;
  references: { products: string[]; categories: string[]; pages: string[] };
  /** Link objects inside `root` whose href the caller fills in once targets are loaded. */
  links: DeliveredLink[];
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const isNodeVisible = (node: PageNode, options: Pick<DeliveryOptions, "channelId" | "locale" | "now">) => {
  if (node.hidden) return false;
  const v = node.visibility;
  if (!v) return true;
  if (v.channelIds?.length && !v.channelIds.includes(options.channelId)) return false;
  if (v.locales?.length && !v.locales.some((l) => l === options.locale || l === options.locale.split("-")[0])) return false;
  const now = options.now.getTime();
  if (v.from && Date.parse(v.from) > now) return false;
  if (v.until && Date.parse(v.until) <= now) return false;
  return true;
};

export const deliverDocument = (document: PageDocument, options: DeliveryOptions): Delivery => {
  const products = new Set<string>();
  const categories = new Set<string>();
  const pages = new Set<string>();
  const links: DeliveredLink[] = [];
  const text = (value: unknown) => (typeof value === "string" ? value : isObject(value) ? pickLocalized(value as LocalizedText, options.locale, options.fallbackLocale) : null);

  const image = (value: unknown): DeliveredImage | null => {
    if (!isObject(value) || typeof value.url !== "string") return null;
    const v = value as ImageValue;
    return { url: v.url, alt: text(v.alt) ?? null, width: v.width ?? null, height: v.height ?? null };
  };

  const link = (value: unknown): DeliveredLink | null => {
    if (!isObject(value)) return null;
    const v = value as LinkValue;
    const delivered: DeliveredLink = v.kind === "url" ? { kind: "url", href: v.url, id: null, newTab: !!v.newTab } : { kind: v.kind, href: null, id: v.id, newTab: !!v.newTab };
    if (v.kind === "product") products.add(v.id);
    if (v.kind === "category") categories.add(v.id);
    if (v.kind === "page") pages.add(v.id);
    if (v.kind !== "url") links.push(delivered);
    return delivered;
  };

  const value = (field: FieldDefinition, raw: unknown): unknown => {
    const v = raw === undefined ? field.defaultValue : raw;
    switch (field.type) {
      case "text":
      case "richText":
        return text(v) ?? null;
      case "number":
        return typeof v === "number" ? v : null;
      case "boolean":
        return v === true;
      case "select":
      case "color":
      case "date":
        return typeof v === "string" ? v : null;
      case "image":
        return image(v);
      case "link":
        return link(v);
      case "product":
        if (typeof v !== "string") return null;
        products.add(v);
        return v;
      case "category":
        if (typeof v !== "string") return null;
        categories.add(v);
        return v;
      case "products": {
        const ids = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
        for (const id of ids) products.add(id);
        return ids;
      }
      case "list":
        return (Array.isArray(v) ? v : []).filter(isObject).map((item) => {
          const i = item as ListItem;
          return { id: i.id, fields: Object.fromEntries((field.fields ?? []).map((sub) => [sub.key, value(sub, isObject(i.fields) ? i.fields[sub.key] : undefined)])) } satisfies DeliveredItem;
        });
      case "blocks":
        return (Array.isArray(v) ? v : []).filter((child): child is PageNode => isObject(child) && isNodeVisible(child as PageNode, options)).flatMap((child) => {
          const delivered = node(child);
          return delivered ? [delivered] : [];
        });
    }
  };

  const node = (n: PageNode): DeliveredNode | null => {
    const definition = options.components.get(n.component);
    if (!definition) return null;
    const variation = n.variation ?? definition.variations[0]?.code ?? null;
    const fields = definition.fields
      .filter((f) => !f.variations?.length || !variation || f.variations.includes(variation))
      .map((f) => [f.key, value(f, n.fields[f.key])] as const);
    return { id: n.id, component: n.component, variation, fields: Object.fromEntries(fields) };
  };

  const root = node(document.root) ?? { id: document.root.id, component: document.root.component, variation: null, fields: {} };
  return {
    title: text(document.title),
    seo: {
      title: text(document.seo.title),
      description: text(document.seo.description),
      image: image(document.seo.image),
      noIndex: document.seo.noIndex === true,
    },
    root,
    references: { products: [...products], categories: [...categories], pages: [...pages] },
    links,
  };
};

/** Storefront URLs for linked objects; frontends resolve these paths through `route`. */
export const productHref = (slug: string) => `/products/${slug}`;
export const categoryHref = (path: string) => `/categories/${path}`;
