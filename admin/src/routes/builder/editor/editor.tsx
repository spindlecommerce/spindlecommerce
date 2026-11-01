import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker, useNavigate, useParams, useRouter } from "@tanstack/react-router";
import { ArrowLeft, FileQuestion } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { request } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { relativeTime } from "@/lib/format";
import { useReference } from "@/lib/hooks";
import type { ListSearch } from "@/router";
import { gid } from "@/routes/catalog/shared";
import type { ComponentDef, LocalizedText, PageDocument, PageNode, PageSeo, TemplateFor } from "../model";
import { BUILDER_KEYS, PageEditorQuery, PageMetaQuery, pageGid, useFrontends, useLibrary, type Frontend, type Library } from "./api";
import { Inspector } from "./inspector";
import { ComponentPicker } from "./picker";
import { PreviewPane } from "./preview";
import { StatusBanners, usePublishing } from "./publish";
import { createActions, createStore, DEVICES, EditorContext, type BridgeHandle, type Device, type EditorContextValue, type EditorState, type PageMeta, type PreviewKind } from "./store";
import { CompactControls, TopBar } from "./topbar";
import { StructureTree } from "./tree";
import { docTitle, indexTree, isObject, isTyping } from "./util";

/** The page editor (/pages/$id), full window: structure tree, live preview and inspector. */

type EditorPage = NonNullable<Awaited<ReturnType<typeof loadPage>>["page"]>;
const loadPage = (id: string, signal?: AbortSignal) => request(PageEditorQuery, { id }, { signal });

export const PageEditorPage = () => {
  const { id = "" } = useParams({ strict: false }) as { id?: string };
  const pageId = pageGid(id);
  const library = useLibrary();
  const reference = useReference();
  const frontends = useFrontends();
  const page = useQuery({ queryKey: BUILDER_KEYS.page(pageId), queryFn: ({ signal }) => loadPage(pageId, signal), staleTime: Infinity, gcTime: 0, refetchOnWindowFocus: false, retry: false });

  if (page.isLoading || library.loading || reference.loading || frontends.loading) return <EditorSkeleton />;
  const data = page.data?.page;
  if (!data) {
    return (
      <Problem
        title="Page not found"
        description={page.error instanceof Error ? page.error.message : "It may have been deleted, or the link is wrong."}
      />
    );
  }
  const contentType = library.defs.get(data.type ?? "");
  if (!contentType) return <Problem title="Unknown content type" description={`This page is a ${data.type}, which is not in the component library. Add the content type back in Components to edit it.`} />;
  return <Editor key={pageId} pageId={pageId} page={data} library={library} locales={reference.locales} defaultLocale={reference.defaultLocale} channels={reference.channels} defaultChannelId={reference.defaultChannelId} frontend={frontends.preferred} contentType={contentType} />;
};

const Problem = ({ title, description }: { title: string; description: string }) => (
  <div className="flex flex-1 items-center justify-center">
    <EmptyState
      icon={FileQuestion}
      title={title}
      description={description}
      action={
        <Button asChild variant="outline">
          <Link to="/pages">
            <ArrowLeft /> All pages
          </Link>
        </Button>
      }
    />
  </div>
);

const EditorSkeleton = () => (
  <div className="flex h-dvh flex-col">
    <div className="flex h-14 items-center gap-3 border-b px-3">
      <Skeleton className="size-8" />
      <Skeleton className="h-4 w-48" />
      <Skeleton className="ml-auto h-8 w-64" />
    </div>
    <div className="flex min-h-0 flex-1">
      <div className="flex w-72 flex-col gap-2 border-r p-3">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-7" style={{ marginLeft: (i % 3) * 14 }} />
        ))}
      </div>
      <div className="flex-1 bg-muted/50 p-6">
        <Skeleton className="mx-auto h-full max-w-5xl" />
      </div>
      <div className="flex w-[22rem] flex-col gap-4 border-l p-4">
        <Skeleton className="h-10" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
    </div>
  </div>
);

// ---------------------------------------------------------------- editor

const PREF_KEY = "ecom:page-editor";
type Prefs = { previewKind?: PreviewKind; tree?: boolean; inspector?: boolean };
const readPrefs = (): Prefs => {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}") as Prefs;
  } catch {
    return {};
  }
};
const writePrefs = (prefs: Prefs) => {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({ ...readPrefs(), ...prefs }));
  } catch {
    // Private mode and the like: preferences don't stick.
  }
};

/** The stored draft, with the parts the editor relies on always present. */
const toDocument = (value: unknown, contentType: ComponentDef): PageDocument => {
  const doc = isObject(value) ? value : {};
  const root = isObject(doc.root) && typeof doc.root.id === "string" && typeof doc.root.component === "string" ? (doc.root as PageNode) : { id: "root", component: contentType.code, fields: {} };
  return {
    title: isObject(doc.title) ? (doc.title as LocalizedText) : {},
    path: typeof doc.path === "string" ? doc.path : null,
    seo: isObject(doc.seo) ? (doc.seo as PageSeo) : {},
    root: isObject(root.fields) ? root : { ...root, fields: {} },
  };
};

const metaOf = (page: EditorPage): PageMeta => {
  const { document: _document, ...meta } = page;
  return meta;
};

const isDevice = (value: string | undefined): value is Device => !!value && value in DEVICES;

/** The URL parameter holding a template preview's product or category. */
const PREVIEW_PARAM = { PRODUCT: { key: "product", type: "Product" }, CATEGORY: { key: "category", type: "Category" } } as const;

/** A template preview's product or category from the URL (a global id or a bare UUID). */
const previewWithFrom = (search: ListSearch, templateFor: TemplateFor | null) => {
  if (!templateFor) return null;
  const { key, type } = PREVIEW_PARAM[templateFor];
  const value = search[key]?.trim();
  return value ? gid(type, value) : null;
};

const useMediaQuery = (query: string) => {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
};

const overlayOpen = () => !!document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]');

type EditorProps = {
  pageId: string;
  page: EditorPage;
  library: Library;
  locales: readonly string[];
  defaultLocale: string;
  channels: EditorContextValue["channels"];
  defaultChannelId: string;
  frontend: Frontend | null;
  contentType: ComponentDef;
};

const Editor = memo(({ pageId, page, library, locales: referenceLocales, defaultLocale, channels, defaultChannelId, frontend, contentType }: EditorProps) => {
  const router = useRouter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { can } = useAuth();
  const canWrite = can("content:write");
  const locales = useMemo(() => (referenceLocales.length ? referenceLocales : ["en-US"]), [referenceLocales]);
  const defsRef = useRef(library.defs);
  defsRef.current = library.defs;
  const componentsRef = useRef(library.list);
  componentsRef.current = library.list;
  const bridge = useRef<BridgeHandle | null>(null);

  const [store] = useState(() => {
    const search = router.state.location.search as ListSearch;
    const doc = toDocument(page.document, contentType);
    const meta = metaOf(page);
    const pageChannels = meta.allChannels ? channels.map((c) => c.id) : (meta.channels ?? []).map((c) => c.id);
    const preferredChannel = [frontend?.defaultChannel?.id, defaultChannelId, pageChannels[0]].find((id) => id && (pageChannels.length === 0 || pageChannels.includes(id)));
    const prefs = readPrefs();
    const initial: EditorState = {
      doc,
      savedDoc: doc,
      version: page.version ?? 0,
      past: [],
      future: [],
      coalesce: null,
      selection: search.node && indexTree(doc.root, library.defs).has(search.node) ? { nodeId: search.node, path: [] } : null,
      selectionSource: "editor",
      focusRequest: 0,
      focusMode: "focus",
      hoveredNodeId: null,
      locale: search.locale && locales.includes(search.locale) ? search.locale : locales.includes(defaultLocale) ? defaultLocale : locales[0]!,
      channelId: preferredChannel ?? "",
      previewWith: previewWithFrom(search, contentType.templateFor),
      device: isDevice(search.device) ? search.device : "desktop",
      mode: "edit",
      previewKind: frontend ? (prefs.previewKind ?? "live") : "structure",
      saving: false,
      saveError: null,
      conflict: null,
      issues: [],
      saveIssues: [],
      meta,
      picker: null,
    };
    return createStore(initial);
  });

  const canWriteRef = useRef(canWrite);
  canWriteRef.current = canWrite;
  const [actions] = useState(() =>
    createActions(store, {
      pageId,
      defs: () => defsRef.current,
      components: () => componentsRef.current,
      bridge,
      canWrite: () => canWriteRef.current,
      onSaved: () => void queryClient.invalidateQueries({ queryKey: BUILDER_KEYS.pages }),
    }),
  );
  useEffect(() => () => actions.dispose(), [actions]);

  const context = useMemo<EditorContextValue>(
    () => ({ store, actions, pageId, defs: library.defs, components: library.components, contentType, locales, defaultLocale, channels, frontend, bridge }),
    [store, actions, pageId, library.defs, library.components, contentType, locales, defaultLocale, channels, frontend],
  );

  // ---------------------------------------------------------------- preferences and URL

  const wide = useMediaQuery("(min-width: 1024px)");
  const [panels, setPanels] = useState(() => {
    const prefs = readPrefs();
    return { tree: prefs.tree ?? true, inspector: prefs.inspector ?? true, treeOverlay: false };
  });
  const changePanels = (next: { tree: boolean; inspector: boolean }) => {
    // Narrow windows toggle the slide-over tree and keep the wide-window preference as it was.
    if (!wide) {
      setPanels((p) => ({ ...p, treeOverlay: next.tree, inspector: next.inspector }));
      writePrefs({ inspector: next.inspector });
      return;
    }
    setPanels((p) => ({ ...p, tree: next.tree, inspector: next.inspector, treeOverlay: false }));
    writePrefs({ tree: next.tree, inspector: next.inspector });
  };
  useEffect(() => {
    let kind = store.get().previewKind;
    return store.subscribe(() => {
      const next = store.get().previewKind;
      if (next !== kind) writePrefs({ previewKind: (kind = next) });
    });
  }, [store]);

  // Kept in the URL so a link opens the editor as it was.
  useEffect(() => {
    let last = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    const kind = contentType.templateFor;
    const sync = () => {
      const s = store.get();
      const node = s.selection && s.selection.nodeId !== s.doc.root.id ? s.selection.nodeId : undefined;
      const locale = s.locale !== defaultLocale ? s.locale : undefined;
      const device = s.device !== "desktop" ? s.device : undefined;
      const product = kind === "PRODUCT" ? (s.previewWith ?? undefined) : undefined;
      const category = kind === "CATEGORY" ? (s.previewWith ?? undefined) : undefined;
      const key = `${node}|${locale}|${device}|${product}|${category}`;
      if (key === last) return;
      last = key;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void navigate({ to: ".", search: (prev: ListSearch) => ({ ...prev, node, locale, device, product, category }), replace: true }), 150);
    };
    sync();
    const unsubscribe = store.subscribe(sync);
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [store, navigate, defaultLocale, contentType.templateFor]);

  useEffect(() => {
    const update = () => {
      document.title = `${docTitle(store.get().doc, store.get().locale) || "Untitled"} · Page editor · SpindleCommerce`;
    };
    update();
    return store.subscribe(update);
  }, [store]);

  // ---------------------------------------------------------------- leaving

  useBlocker({
    shouldBlockFn: async ({ current, next }) => {
      if (current.pathname === next.pathname) return false;
      const s = store.get();
      if (s.doc === s.savedDoc && !actions.isSaving()) return false;
      if (s.conflict) return !window.confirm("Leave without saving? Your latest edits conflict with a newer version and will be lost.");
      if (await actions.flush()) return false;
      return !window.confirm("Your latest changes could not be saved. Leave anyway?");
    },
    enableBeforeUnload: () => {
      const s = store.get();
      return s.doc !== s.savedDoc || actions.isSaving();
    },
  });

  // ---------------------------------------------------------------- someone else editing

  const poll = useQuery({ queryKey: BUILDER_KEYS.pageMeta(pageId), queryFn: () => request(PageMetaQuery, { id: pageId }), refetchInterval: 30_000, refetchOnWindowFocus: true, staleTime: 0 });
  useEffect(() => {
    if (!poll.data) return;
    const latest = poll.data.page;
    const s = store.get();
    if (s.saving || actions.isSaving() || s.conflict) return;
    if (!latest) {
      store.set({ conflict: "The page was deleted." });
      return;
    }
    if ((latest.version ?? 0) > s.version) {
      const who = latest.draftUpdatedBy?.name ?? latest.draftUpdatedBy?.email;
      store.set({ conflict: `Version ${latest.version} was saved${who ? ` by ${who}` : ""} ${relativeTime(latest.draftUpdatedAt)}.` });
      return;
    }
    if (latest.version === s.version) actions.setMeta(latest);
  }, [poll.data, store, actions]);

  const reload = useCallback(async () => {
    try {
      const fresh = (await queryClient.fetchQuery({ queryKey: BUILDER_KEYS.page(pageId), queryFn: () => loadPage(pageId), staleTime: 0 })).page;
      if (!fresh) throw new Error("The page no longer exists");
      actions.replaceDocument(toDocument(fresh.document, contentType), fresh.version ?? 0, metaOf(fresh));
      toast.success("Reloaded the latest version");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not reload the page");
    }
  }, [queryClient, pageId, actions, contentType]);

  // ---------------------------------------------------------------- keyboard

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (mod && key === "s") {
        event.preventDefault();
        void actions.flush().then((ok) => ok && toast.success("Saved", { duration: 1200 }));
        return;
      }
      if (event.defaultPrevented || overlayOpen()) return;
      if (mod && key === "z") {
        event.preventDefault();
        if (event.shiftKey) actions.redo();
        else actions.undo();
        return;
      }
      if (mod && key === "y") {
        event.preventDefault();
        actions.redo();
        return;
      }
      const s = store.get();
      const nodeId = s.selection && s.selection.nodeId !== s.doc.root.id ? s.selection.nodeId : null;
      const typing = isTyping(event.target);
      if (mod && key === "d") {
        if (!nodeId) return;
        event.preventDefault();
        actions.duplicate(nodeId);
        return;
      }
      // Controls in the inspector, such as list item buttons, keep their own keys.
      const inPanel = event.target instanceof HTMLElement && !!event.target.closest('[aria-label="Inspector"]');
      if (mod && (event.key === "ArrowUp" || event.key === "ArrowDown") && !typing && !inPanel) {
        if (!nodeId) return;
        event.preventDefault();
        actions.move(nodeId, event.key === "ArrowUp" ? -1 : 1);
        return;
      }
      if (event.key === "Escape") {
        if (typing) (event.target as HTMLElement).blur();
        else if (s.selection) actions.select(null);
        return;
      }
      if (typing || mod || event.altKey || inPanel) return;
      if ((event.key === "Delete" || event.key === "Backspace") && nodeId) {
        event.preventDefault();
        actions.remove(nodeId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions, store]);

  return (
    <EditorContext.Provider value={context}>
      <div className="flex h-dvh min-h-0 flex-col bg-background">
        <EditorChrome panels={{ tree: wide ? panels.tree : panels.treeOverlay, inspector: panels.inspector }} onPanels={changePanels} onReload={reload} canWrite={canWrite} />
        <div className="relative flex min-h-0 flex-1">
          {wide ? (
            panels.tree ? (
              <aside className="flex w-72 shrink-0 flex-col border-r bg-sidebar/50" aria-label="Structure">
                <StructureTree />
              </aside>
            ) : null
          ) : panels.treeOverlay ? (
            // Narrow windows: the tree slides over the preview instead of squeezing it.
            <aside className="absolute inset-y-0 left-0 z-30 flex w-72 max-w-[85vw] flex-col border-r bg-background shadow-xl" aria-label="Structure">
              <StructureTree />
            </aside>
          ) : null}
          <PreviewPane />
          {panels.inspector ? (
            <aside className="flex w-[21rem] shrink-0 flex-col border-l bg-background xl:w-[23rem]" aria-label="Inspector">
              <Inspector />
            </aside>
          ) : null}
        </div>
        <ComponentPicker />
      </div>
    </EditorContext.Provider>
  );
});

/** Its own component so usePublishing runs inside the editor context. */
const EditorChrome = ({ panels, onPanels, onReload, canWrite }: { panels: { tree: boolean; inspector: boolean }; onPanels: (panels: { tree: boolean; inspector: boolean }) => void; onReload: () => void; canWrite: boolean }) => {
  const publishing = usePublishing();
  return (
    <>
      <TopBar publishing={publishing} panels={panels} onPanels={onPanels} />
      <CompactControls />
      {!canWrite ? <div className="border-b bg-muted/60 px-4 py-1.5 text-[13px] text-muted-foreground">You can look around, but your role cannot edit pages (it needs content:write).</div> : null}
      <StatusBanners publishing={publishing} onReload={onReload} />
    </>
  );
};
