import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink, LayoutPanelTop, Loader2, MonitorPlay, PlugZap, RefreshCw, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/overlay";
import { request, unwrap } from "@/lib/api";
import { cn } from "@/lib/utils";
import { editorMessage, findSlot, readBridgeMessage, type EditorMessage } from "../model";
import { NodeNamesQuery, PageByPathQuery, PreviewSessionMutation, rawIdOf, type Frontend } from "./api";
import { DEVICES, useEditor, useEditorState } from "./store";
import { StructurePreview } from "./structure-preview";
import { isTemplatePath, PreviewWith } from "./template";
import { indexTree, labelsOf, nodeLimits, normalizePath } from "./util";

/**
 * The storefront in a frame, talking to src/visual-editing/bridge.js by postMessage (origin and
 * window checked both ways), or the structure preview, drawn in the admin.
 */

const READY_TIMEOUT_MS = 8000;
const RENDER_TIMEOUT_MS = 10_000;
/** Preview tokens last two hours; get a fresh one well before. */
const SESSION_REFRESH_MS = 90 * 60_000;

type Connection = "loading" | "connected" | "timeout";
type Visit = { path: string; page: { id: string; title?: string | null; path?: string | null } | null };

const originOf = (url: string | null | undefined) => {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

export const usePreviewSession = (frontend: Frontend | null) => {
  const { pageId, contentType } = useEditor();
  const locale = useEditorState((s) => s.locale);
  const channelId = useEditorState((s) => s.channelId);
  // A new path (once saved) needs a new preview URL.
  const path = useEditorState((s) => s.savedDoc.path);
  const previewWith = useEditorState((s) => s.previewWith);
  const productId = contentType.templateFor === "PRODUCT" ? previewWith : null;
  const categoryId = contentType.templateFor === "CATEGORY" ? previewWith : null;
  return useQuery({
    queryKey: ["preview-session", pageId, frontend?.id ?? null, locale, channelId, path, productId, categoryId],
    queryFn: async () => {
      const result = unwrap((await request(PreviewSessionMutation, { frontendId: frontend!.id, pageId, locale, channelId: channelId || null, productId, categoryId })).previewSessionCreate);
      return result.session!;
    },
    enabled: !!frontend,
    staleTime: SESSION_REFRESH_MS,
    gcTime: SESSION_REFRESH_MS,
    refetchInterval: SESSION_REFRESH_MS,
    refetchOnWindowFocus: false,
    retry: 1,
  });
};

export const PreviewPane = () => {
  const { frontend, store } = useEditor();
  const kind = useEditorState((s) => s.previewKind);
  const session = usePreviewSession(frontend);
  const [reload, setReload] = useState(0);
  const [connection, setConnection] = useState<Connection>("loading");
  // Templates: the product or category page the frame browsed to, for the preview it was in.
  const [browsed, setBrowsed] = useState<{ url: string; path: string } | null>(null);
  const live = kind === "live" && !!frontend;
  const url = session.data?.url ?? null;
  const adminOrigin = session.data?.adminOrigin ?? null;
  const mismatch = !!adminOrigin && adminOrigin !== window.location.origin;
  const onTemplatePath = useCallback(
    (path: string) => {
      if (url) setBrowsed({ url, path });
    },
    [url],
  );
  const previewPath = (browsed && browsed.url === url ? browsed.path : null) ?? session.data?.path ?? null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-muted/50">
      <PreviewToolbar
        frontend={frontend}
        connection={live ? (session.isError ? "timeout" : connection) : null}
        loading={session.isFetching}
        onReload={() => {
          // A reload opens the preview's own page again.
          setBrowsed(null);
          if (url) setReload((n) => n + 1);
          else void session.refetch();
        }}
        url={url}
        previewPath={previewPath}
      />
      <div className="relative min-h-0 flex-1">
        {frontend && url ? (
          <DeviceFrame hidden={!live}>
            <LivePreview key={`${reload}:${url}`} frontend={frontend} url={url} onConnection={setConnection} onTemplatePath={onTemplatePath} />
          </DeviceFrame>
        ) : null}
        {!live ? <StructurePreview /> : null}
        {live && session.isLoading ? (
          <Overlay>
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Opening a preview of {frontend.name ?? "the storefront"}…</p>
          </Overlay>
        ) : null}
        {live && session.isError ? (
          <Overlay>
            <Notice
              icon={<TriangleAlert className="size-5" />}
              title="Could not open a preview"
              actions={
                <>
                  <Button size="sm" variant="outline" onClick={() => void session.refetch()}>
                    <RefreshCw /> Try again
                  </Button>
                  <Button size="sm" onClick={() => store.set({ previewKind: "structure" })}>
                    <LayoutPanelTop /> Use structure preview
                  </Button>
                </>
              }
            >
              {session.error instanceof Error ? session.error.message : "The preview session could not be created."}
            </Notice>
          </Overlay>
        ) : null}
        {live && url && (connection === "timeout" || mismatch) ? (
          <Overlay translucent>
            <Notice
              icon={<PlugZap className="size-5" />}
              title={mismatch ? "The storefront is set up for another admin address" : `No answer from ${frontend.name ?? "the storefront"}`}
              actions={
                <>
                  <Button size="sm" variant="outline" onClick={() => setReload((n) => n + 1)}>
                    <RefreshCw /> Retry
                  </Button>
                  <Button size="sm" variant="outline" asChild>
                    <a href={url} target="_blank" rel="noreferrer">
                      <ExternalLink /> Open in a new tab
                    </a>
                  </Button>
                  <Button size="sm" onClick={() => store.set({ previewKind: "structure" })}>
                    <LayoutPanelTop /> Use structure preview
                  </Button>
                </>
              }
            >
              {mismatch ? (
                <>
                  Its bridge only talks to <code className="font-mono">{adminOrigin}</code>, but this admin runs at <code className="font-mono">{window.location.origin}</code>. Set <code className="font-mono">ADMIN_URL</code> on the API to this
                  address so the preview can connect.
                </>
              ) : (
                <>
                  The page at <code className="font-mono break-all">{frontend.url ?? url}</code> did not connect within {READY_TIMEOUT_MS / 1000} seconds. Either the storefront is not running, or its pages do not load the visual editing bridge (
                  <code className="font-mono">/visual-editing/bridge.js</code>) in draft mode. You can keep editing in the structure preview; changes are saved either way.
                </>
              )}
            </Notice>
          </Overlay>
        ) : null}
      </div>
    </div>
  );
};

/** Centered over the preview; scrolls rather than clipping when the panel is short or narrow. */
const Overlay = ({ children, translucent }: { children: ReactNode; translucent?: boolean }) => (
  <div className={cn("absolute inset-0 z-20 overflow-y-auto p-4 sm:p-6", translucent ? "bg-background/70 backdrop-blur-[2px]" : "bg-muted/60")}>
    <div className="flex min-h-full flex-col items-center justify-center gap-3">{children}</div>
  </div>
);

const Notice = ({ icon, title, children, actions }: { icon: ReactNode; title: string; children: ReactNode; actions: ReactNode }) => (
  <div role="alert" className="w-full max-w-lg rounded-xl border bg-card p-5 shadow-lg">
    <div className="flex gap-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-warning/15 text-warning">{icon}</span>
      <div className="min-w-0">
        <p className="font-medium">{title}</p>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{children}</p>
      </div>
    </div>
    <div className="mt-4 flex flex-wrap justify-end gap-2">{actions}</div>
  </div>
);

// ---------------------------------------------------------------- toolbar

const PreviewToolbar = ({
  frontend,
  connection,
  loading,
  onReload,
  url,
  previewPath,
}: {
  frontend: Frontend | null;
  connection: Connection | null;
  loading: boolean;
  onReload: () => void;
  url: string | null;
  /** The storefront path the preview shows (templates name its product or category). */
  previewPath: string | null;
}) => {
  const { store, channels, contentType } = useEditor();
  const kind = useEditorState((s) => s.previewKind);
  const channelId = useEditorState((s) => s.channelId);
  const allChannels = useEditorState((s) => s.meta.allChannels);
  const pageChannels = useEditorState((s) => s.meta.channels);
  const options = (allChannels || !pageChannels?.length ? channels : channels.filter((c) => pageChannels.some((p) => p.id === c.id))).map((c) => ({ value: c.id, label: c.name ?? c.code ?? "Channel" }));
  const status =
    connection === "connected" ? { dot: "bg-success", text: "Connected" } : connection === "timeout" ? { dot: "bg-destructive", text: "Not connected" } : connection === "loading" ? { dot: "bg-warning animate-pulse", text: "Connecting…" } : null;
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur">
      <div className="flex rounded-md bg-muted p-0.5" role="radiogroup" aria-label="Preview">
        <Tooltip content={frontend ? `The storefront, ${frontend.name ?? frontend.url}` : "Set up a storefront in Settings › Storefronts to preview the real page"}>
          <button
            type="button"
            role="radio"
            aria-checked={kind === "live"}
            disabled={!frontend}
            onClick={() => store.set({ previewKind: "live" })}
            className={cn("flex h-7 items-center gap-1.5 rounded px-2.5 text-xs font-medium text-muted-foreground disabled:opacity-50", kind === "live" && frontend && "bg-background text-foreground shadow-xs")}
          >
            <MonitorPlay className="size-3.5" /> Live
          </button>
        </Tooltip>
        <Tooltip content="Wireframe of the document, drawn in the admin">
          <button
            type="button"
            role="radio"
            aria-checked={kind === "structure" || !frontend}
            onClick={() => store.set({ previewKind: "structure" })}
            className={cn("flex h-7 items-center gap-1.5 rounded px-2.5 text-xs font-medium text-muted-foreground", (kind === "structure" || !frontend) && "bg-background text-foreground shadow-xs")}
          >
            <LayoutPanelTop className="size-3.5" /> Structure
          </button>
        </Tooltip>
      </div>
      {kind === "live" && frontend && contentType.templateFor ? <PreviewWith path={previewPath} /> : null}
      {kind === "live" && frontend && options.length > 1 ? <Select aria-label="Preview channel" className="h-7 w-40 text-xs" value={channelId} options={options} onValueChange={(v) => store.set({ channelId: v })} /> : null}
      {kind === "live" && status ? (
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className={cn("size-2 shrink-0 rounded-full", status.dot)} />
          <span className="truncate">
            {status.text}
            {frontend ? ` · ${frontend.name ?? frontend.url}` : ""}
          </span>
        </span>
      ) : null}
      {!frontend ? (
        <span className="truncate text-xs text-muted-foreground">
          No storefront yet.{" "}
          <Link to="/settings/storefronts" className="text-primary hover:underline">
            Set one up
          </Link>{" "}
          for a live preview.
        </span>
      ) : null}
      <div className="ml-auto flex items-center gap-0.5">
        {kind === "live" && frontend ? (
          <>
            <Tooltip content="Reload the preview">
              <Button variant="ghost" size="icon-sm" className="size-7" onClick={onReload} aria-label="Reload the preview">
                <RefreshCw className={cn(loading && "animate-spin")} />
              </Button>
            </Tooltip>
            {url ? (
              <Tooltip content="Open the preview in a new tab">
                <Button variant="ghost" size="icon-sm" className="size-7" asChild>
                  <a href={url} target="_blank" rel="noreferrer" aria-label="Open the preview in a new tab">
                    <ExternalLink />
                  </a>
                </Button>
              </Tooltip>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------- device frame

/** The preview at the device's width, scaled down to fit when the panel is narrower. */
const DeviceFrame = ({ children, hidden }: { children: ReactNode; hidden?: boolean }) => {
  const device = useEditorState((s) => s.device);
  const width = DEVICES[device].width;
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => entry && setBox({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const gutter = width ? 20 : 0;
  const available = { width: Math.max(0, box.width - gutter * 2), height: Math.max(0, box.height - gutter * 2) };
  const scale = width && available.width && available.width < width ? available.width / width : 1;
  return (
    <div ref={ref} className={cn("absolute inset-0 overflow-hidden", hidden && "pointer-events-none invisible")} aria-hidden={hidden || undefined}>
      <div className="flex h-full justify-center" style={{ padding: gutter }}>
        <div
          className={cn("shrink-0 overflow-hidden bg-white transition-[width] duration-200", width && "rounded-2xl border shadow-xl ring-[6px] ring-foreground/[0.04]")}
          style={{ width: width ?? "100%", height: width ? available.height / scale : "100%", transform: scale < 1 ? `scale(${scale})` : undefined, transformOrigin: "top center" }}
        >
          {children}
        </div>
      </div>
      {width ? <span className="pointer-events-none absolute bottom-1.5 left-1/2 -translate-x-1/2 text-[10px] text-muted-foreground tabular-nums">{`${width}px${scale < 1 ? ` · ${Math.round(scale * 100)}%` : ""}`}</span> : null}
    </div>
  );
};

// ---------------------------------------------------------------- the framed storefront

const LivePreview = ({ frontend, url, onConnection, onTemplatePath }: { frontend: Frontend; url: string; onConnection: (connection: Connection) => void; onTemplatePath: (path: string) => void }) => {
  const { store, actions, pageId, defs, bridge, contentType } = useEditor();
  const navigate = useNavigate();
  const frame = useRef<HTMLIFrameElement>(null);
  const origin = useMemo(() => originOf(frontend.url), [frontend.url]);
  // Names for every code, content types included (the header's root is a site_header).
  const labels = useMemo(() => labelsOf([...defs.values()]), [defs]);
  const templateFor = contentType.templateFor;
  const [updating, setUpdating] = useState(false);
  const [visiting, setVisiting] = useState<Visit | null>(null);
  const [foreign, setForeign] = useState<{ id: string; title: string } | null>(null);
  const connected = useRef(false);
  const features = useRef<string[]>([]);
  const firstPath = useRef<string | null>(null);
  /** Templates: the last product or category page shown, where "Back" returns to. */
  const templatePath = useRef<string | null>(null);
  const renderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lookups = useRef(0);
  /** The selection and toolbar actions last sent, so changes are sent once. */
  const sent = useRef({ selection: "", actions: "" });
  /** The field being edited in place in the frame, and whether a refresh waits for it. */
  const inline = useRef<{ key: string; refreshWaiting: boolean } | null>(null);
  const lastSelect = useRef<{ key: string; at: number } | null>(null);

  const post = useCallback(
    (message: EditorMessage) => {
      if (origin) frame.current?.contentWindow?.postMessage(editorMessage(message), origin);
    },
    [origin],
  );

  const showUpdating = useCallback(() => {
    setUpdating(true);
    if (renderTimer.current) clearTimeout(renderTimer.current);
    // Storefronts that never call rendered() should not show "updating" forever.
    renderTimer.current = setTimeout(() => setUpdating(false), RENDER_TIMEOUT_MS);
  }, []);

  /** Tell the frame the selection and its toolbar actions whenever either changes. */
  const syncSelection = useCallback(
    (force = false) => {
      if (!connected.current) return;
      const s = store.get();
      const selection = s.selection;
      const isPage = !selection || selection.nodeId === s.doc.root.id;
      const nodeId = isPage ? null : selection.nodeId;
      // "@…" paths are admin-only (the variation picker, visibility settings).
      const path = isPage ? [] : selection.path.filter((p) => !p.startsWith("@"));
      const allowed = nodeId ? (nodeLimits(s.doc.root, defs, nodeId)?.abilities ?? null) : null;
      const key = [nodeId, ...path].join(".");
      const flags = JSON.stringify(allowed);
      if (!force && key === sent.current.selection && flags === sent.current.actions) return;
      const moved = key !== sent.current.selection;
      sent.current = { selection: key, actions: flags };
      post({ type: "editor:select", nodeId, path, scroll: moved && s.selectionSource === "editor", ...(allowed ? { actions: allowed } : {}) });
    },
    [store, defs, post],
  );

  // What the editor sends.
  useEffect(() => {
    bridge.current = {
      select: () => syncSelection(),
      hover: (nodeId) => connected.current && post({ type: "editor:hover", nodeId: nodeId === store.get().doc.root.id ? null : nodeId, path: [] }),
      patch: (nodeId, path, value) => {
        // The frame is showing that field's own typing; do not echo it back.
        if (!connected.current || inline.current?.key === [nodeId, ...path].join(".")) return;
        post({ type: "editor:patch", nodeId, path, value });
      },
      refresh: () => {
        if (!connected.current) return;
        post({ type: "editor:refresh", reason: "draft saved" });
        // While text is edited in place the bridge holds the refresh until the edit ends.
        if (inline.current) inline.current.refreshWaiting = true;
        else showUpdating();
      },
    };
    const unsubscribe = store.subscribe(() => syncSelection());
    return () => {
      unsubscribe();
      bridge.current = null;
      if (renderTimer.current) clearTimeout(renderTimer.current);
      if (focusTimer.current) clearTimeout(focusTimer.current);
    };
  }, [bridge, post, store, syncSelection, showUpdating]);

  // No bridge:ready within a few seconds: the storefront is down or does not load the bridge.
  useEffect(() => {
    connected.current = false;
    onConnection("loading");
    const timer = setTimeout(() => !connected.current && onConnection("timeout"), READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [url, onConnection]);

  useEffect(() => {
    let mode = store.get().mode;
    return store.subscribe(() => {
      const next = store.get().mode;
      if (next === mode) return;
      mode = next;
      if (connected.current) post({ type: "editor:mode", mode });
    });
  }, [store, post]);

  // What the bridge sends.
  useEffect(() => {
    const onPath = (path: string) => {
      firstPath.current ??= path;
      if (templateFor && isTemplatePath(templateFor, path)) {
        // A template's preview renders every product (or category) page with the template being
        // edited, so another one is still this page: keep editing, and say what it shows.
        lookups.current++;
        templatePath.current = path;
        onTemplatePath(path);
        setVisiting(null);
        return;
      }
      const own = store.get().savedDoc.path;
      if (path === firstPath.current || (own && normalizePath(path) === own)) {
        setVisiting(null);
        return;
      }
      const seq = ++lookups.current;
      request(PageByPathQuery, { path })
        .then((r) => seq === lookups.current && setVisiting({ path, page: r.page && r.page.id !== pageId ? r.page : null }))
        .catch(() => seq === lookups.current && setVisiting({ path, page: null }));
    };
    const cancelFocus = () => {
      if (focusTimer.current) clearTimeout(focusTimer.current);
      focusTimer.current = null;
    };
    const onSelect = (nodeId: string | null, path: string[]) => {
      cancelFocus();
      if (!nodeId) return actions.select(null, { source: "bridge" });
      if (!indexTree(store.get().doc.root, defs).has(nodeId)) {
        // The frame shows something the draft no longer has; bring it up to date.
        bridge.current?.refresh();
        return;
      }
      const selection = { nodeId, path };
      const key = [nodeId, ...path].join(".");
      const now = Date.now();
      // The second click of a double-click, or text being edited in place: keep focus in the frame.
      const again = lastSelect.current?.key === key && now - lastSelect.current.at < 600;
      lastSelect.current = { key, at: now };
      if (again || inline.current || !path.length) return actions.select(selection, { source: "bridge", focus: path.length ? "reveal" : undefined });
      if (!features.current.includes("inline-text")) return actions.select(selection, { source: "bridge", focus: true });
      // A double-click may follow to edit in place: reveal the field now, focus its input after.
      actions.select(selection, { source: "bridge", focus: "reveal" });
      focusTimer.current = setTimeout(() => actions.select(selection, { source: "bridge", focus: true }), 350);
    };
    const onMessage = (event: MessageEvent) => {
      if (!origin || event.origin !== origin || !frame.current || event.source !== frame.current.contentWindow) return;
      const message = readBridgeMessage(event.data);
      if (!message) return;
      switch (message.type) {
        case "bridge:ready":
          connected.current = false;
          features.current = Array.isArray(message.features) ? message.features : [];
          inline.current = null;
          post({ type: "editor:connect", mode: store.get().mode, labels, documentId: pageId });
          setUpdating(false);
          onPath(message.path);
          return;
        case "bridge:connected":
          connected.current = true;
          onConnection("connected");
          syncSelection(true);
          return;
        case "bridge:select": {
          if (message.documentId && message.documentId !== pageId) {
            // The header, footer or another page shown alongside: offer to open it instead.
            const id = message.documentId;
            setForeign({ id, title: "" });
            request(NodeNamesQuery, { ids: [id] })
              .then((r) => {
                const node = r.nodes[0];
                setForeign((f) => (f?.id === id ? { id, title: node && "title" in node ? (node.title ?? "") : "" } : f));
              })
              .catch(() => undefined);
            return;
          }
          setForeign(null);
          onSelect(message.nodeId, message.path);
          return;
        }
        case "bridge:hover":
          actions.hover(message.documentId && message.documentId !== pageId ? null : message.nodeId, { fromPreview: true });
          return;
        case "bridge:input": {
          if (message.documentId && message.documentId !== pageId) return;
          cancelFocus();
          const key = [message.nodeId, ...message.path].join(".");
          const waiting = inline.current?.refreshWaiting ?? false;
          inline.current = message.done ? null : { key, refreshWaiting: waiting };
          if (!actions.setText(message.nodeId, message.path, message.value)) return;
          // The bridge refreshes once the edit ends if a save landed meanwhile.
          if (message.done && waiting) showUpdating();
          return;
        }
        case "bridge:action": {
          const { nodeId, action } = message;
          if (action === "selectParent") actions.selectParent(nodeId);
          else if (action === "moveUp") actions.move(nodeId, -1);
          else if (action === "moveDown") actions.move(nodeId, 1);
          else if (action === "duplicate") actions.duplicate(nodeId);
          else if (action === "remove") actions.remove(nodeId);
          else if (action === "insertBefore" || action === "insertAfter") {
            const slot = findSlot(store.get().doc.root, defs, nodeId);
            if (slot) actions.openPicker({ parentId: slot.parent.id, fieldKey: slot.field.key, index: slot.index + (action === "insertAfter" ? 1 : 0) });
          }
          return;
        }
        case "bridge:navigated":
          onPath(message.path);
          return;
        case "bridge:rendered":
          setUpdating(false);
          if (renderTimer.current) clearTimeout(renderTimer.current);
          return;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [origin, labels, pageId, post, store, actions, defs, bridge, onConnection, syncSelection, showUpdating, templateFor, onTemplatePath]);

  const open = (id: string) => void navigate({ to: "/pages/$id", params: { id: rawIdOf(id) } });

  return (
    <div className="relative size-full">
      <iframe
        ref={frame}
        title="Storefront preview"
        src={url}
        // No allow-top-navigation: the storefront can never navigate the admin.
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        className="size-full border-0 bg-white"
        onLoad={() => post({ type: "editor:ping" })}
      />
      {updating ? (
        <span className="pointer-events-none absolute top-3 right-3 flex items-center gap-1.5 rounded-full border bg-background/95 px-2.5 py-1 text-[11px] font-medium text-muted-foreground shadow-sm">
          <Loader2 className="size-3 animate-spin" /> Updating preview…
        </span>
      ) : null}
      {foreign ? (
        <Banner onClose={() => setForeign(null)}>
          <span>
            {foreign.title ? <strong className="font-medium">{foreign.title}</strong> : "That part"} is a separate page{foreign.title ? "" : " (the header, footer or another page)"}.
          </span>
          <Button size="sm" className="h-7" onClick={() => open(foreign.id)}>
            Open it in the editor
          </Button>
        </Banner>
      ) : visiting ? (
        <Banner onClose={() => setVisiting(null)}>
          <span className="min-w-0 truncate">
            Viewing {visiting.page ? <strong className="font-medium">{visiting.page.title || visiting.page.path}</strong> : <code className="font-mono">{visiting.path}</code>}
            {visiting.page ? <span className="text-muted-foreground"> ({visiting.page.path ?? visiting.path})</span> : null}
          </span>
          {visiting.page ? (
            <Button size="sm" className="h-7" onClick={() => open(visiting.page!.id)}>
              Edit this page
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            onClick={() => {
              post({ type: "editor:navigate", path: templatePath.current ?? firstPath.current ?? store.get().savedDoc.path ?? "/" });
              setVisiting(null);
            }}
          >
            <ArrowLeft /> Back
          </Button>
        </Banner>
      ) : null}
    </div>
  );
};

const Banner = ({ children, onClose }: { children: ReactNode; onClose: () => void }) => (
  <div className="absolute inset-x-3 top-3 z-10 flex items-center gap-2 rounded-lg border bg-background/95 px-3 py-2 text-[13px] shadow-lg backdrop-blur">
    {children}
    <button type="button" onClick={onClose} aria-label="Dismiss" className="ml-auto flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground">
      <X className="size-3.5" />
    </button>
  </div>
);
