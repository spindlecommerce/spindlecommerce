// @ts-check
/**
 * The visual editing bridge, protocol version 1.
 *
 * A storefront loads this in draft mode (it is served at /visual-editing/bridge.js). When the
 * admin's page editor frames the page, the bridge:
 *   - outlines components and fields marked with data attributes, and reports clicks on them so
 *     the admin selects that component and focuses the field;
 *   - shows a toolbar on the selected component (select parent, move, duplicate, remove, insert),
 *     with the actions the admin allows enabled;
 *   - lets editors double-click a plain-text field (data-ecom-patch="text") to edit it in place;
 *   - applies text patches as the editor types, and asks the page to re-render once the draft is
 *     saved;
 *   - reports navigation so the admin can open the page being viewed.
 *
 * Markup (render it only in draft mode if you like):
 *   data-ecom-document="<page global id>"                    around each document a page shows
 *                                                            (the page itself, the header, the footer)
 *   data-ecom-node="<nodeId>" data-ecom-component="<code>"   on a component's root element
 *   data-ecom-field="<nodeId>.<field>"                        on an element showing a field
 *   data-ecom-field="<nodeId>.<field>.<itemId>"               on a list item
 *   data-ecom-field="<nodeId>.<field>.<itemId>.<subField>"    on a field of a list item
 *   data-ecom-patch="text"                                    when the element's text is the field value as is
 *
 * Messages are plain objects { source, version, type, ...payload }, posted only to the admin's
 * origin; only messages from that origin and the parent window are accepted.
 */
(() => {
  /** @type {any} */
  const w = window;
  if (w.EcomVisualEditing) return;

  const VERSION = 1;
  const FROM_BRIDGE = "ecom-visual-editing";
  const FROM_ADMIN = "ecom-admin";

  /** @typedef {{ nodeId: string, path: string[], documentId: string | null }} Target */
  /** @typedef {{ adminOrigin: string, onRefresh?: () => void | Promise<void>, onPatch?: (patch: { nodeId: string, path: string[], value: unknown }) => void, navigate?: (path: string) => void }} Options */

  /** @type {Options | null} */
  let options = null;
  let connected = false;
  /** @type {"edit" | "browse"} */
  let mode = "edit";
  /** @type {Record<string, string>} */
  let labels = {};
  /** @type {Target | null} */
  let selected = null;
  /** @type {Target | null} */
  let hovered = null;
  /** @type {Target | null} */
  let externalHover = null;
  let frame = 0;
  let lastPath = "";
  /** The document the admin is editing; selection and patches apply inside it. */
  /** @type {string | null} */
  let documentId = null;

  const framed = window.parent !== window;

  const send = (/** @type {string} */ type, /** @type {Record<string, unknown>} */ payload = {}) => {
    if (!options || !framed) return;
    window.parent.postMessage({ source: FROM_BRIDGE, version: VERSION, type, ...payload }, options.adminOrigin);
  };

  const keyOf = (/** @type {Target} */ t) => [t.nodeId, ...t.path].join(".");
  const sameTarget = (/** @type {Target | null} */ a, /** @type {Target | null} */ b) => !!a && !!b && a.documentId === b.documentId && keyOf(a) === keyOf(b);

  const cssEscape = (/** @type {string} */ value) => (w.CSS && w.CSS.escape ? w.CSS.escape(value) : value.replace(/["\\]/g, "\\$&"));

  /** The innermost annotated element at or above `element`, with the document it belongs to. */
  const targetFrom = (/** @type {Element | null} */ element) => {
    const doc = element?.closest("[data-ecom-document]")?.getAttribute("data-ecom-document") ?? null;
    for (let el = element; el && el !== document.documentElement; el = el.parentElement) {
      const field = el.getAttribute("data-ecom-field");
      if (field) {
        const [nodeId, ...path] = field.split(".");
        if (nodeId) return { target: { nodeId, path, documentId: doc }, element: el };
      }
      const node = el.getAttribute("data-ecom-node");
      if (node) return { target: { nodeId: node, path: [], documentId: doc }, element: el };
    }
    return null;
  };

  /** Where a document's elements are: its wrapper, or the whole page when unmarked. */
  const scopeFor = (/** @type {string | null} */ id) => (id && document.querySelector(`[data-ecom-document="${cssEscape(id)}"]`)) || document;

  const elementFor = (/** @type {Target} */ target) => {
    const scope = scopeFor(target.documentId);
    return target.path.length ? scope.querySelector(`[data-ecom-field="${cssEscape(keyOf(target))}"]`) : scope.querySelector(`[data-ecom-node="${cssEscape(target.nodeId)}"]`);
  };

  const labelFor = (/** @type {Target} */ target) => {
    const nodeEl = scopeFor(target.documentId).querySelector(`[data-ecom-node="${cssEscape(target.nodeId)}"]`);
    const code = nodeEl?.getAttribute("data-ecom-component") ?? "";
    const name = labels[code] ?? code ?? "Component";
    return target.path.length ? `${name} › ${target.path.filter((_, i) => i % 2 === 0).join(" › ")}` : name;
  };

  // ---------------------------------------------------------------- overlay

  /** @type {HTMLElement | null} */
  let host = null;
  /** @type {ShadowRoot | null} */
  let root = null;
  const boxes = /** @type {Record<"hover" | "selected" | "parent", HTMLElement | null>} */ ({ hover: null, selected: null, parent: null });
  /** @type {HTMLElement | null} */
  let toolbar = null;
  /** @type {Map<string, HTMLButtonElement>} */
  const buttons = new Map();
  /** Which toolbar actions the admin allows for the selection (all, until it says otherwise). */
  /** @type {Record<string, boolean>} */
  let allowed = {};
  /** The plain-text field being edited in place, if any. */
  /** @type {{ el: HTMLElement, target: Target, original: string, timer: number } | null} */
  let inline = null;
  let refreshPending = false;

  const STYLE = `
    :host { all: initial; }
    .layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; font: 500 11px/1.2 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
    .box { position: fixed; box-sizing: border-box; border-radius: 3px; display: none; }
    .hover { outline: 1.5px dashed #6366f1; outline-offset: 1px; background: rgb(99 102 241 / 0.06); }
    .selected { outline: 2px solid #4f46e5; outline-offset: 1px; }
    .parent { outline: 1px solid rgb(79 70 229 / 0.35); outline-offset: 3px; }
    .label { position: absolute; left: -2px; top: -20px; padding: 3px 6px; border-radius: 4px 4px 4px 0; background: #4f46e5; color: #fff; white-space: nowrap; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; }
    .hover .label { background: #6366f1; }
    .toolbar { position: fixed; display: none; gap: 2px; padding: 3px; border-radius: 8px; background: #111827; box-shadow: 0 6px 20px rgb(0 0 0 / 0.25); pointer-events: auto; }
    .toolbar button { all: unset; cursor: pointer; color: #e5e7eb; padding: 4px 7px; border-radius: 5px; font: 600 12px/1 ui-sans-serif, system-ui, sans-serif; }
    .toolbar button:hover, .toolbar button:focus-visible { background: #374151; color: #fff; }
    .toolbar button:disabled { opacity: 0.35; cursor: default; background: none; }
    .toolbar .sep { width: 1px; background: #374151; margin: 2px 2px; }
  `;

  /** @type {[action: string, text: string, title: string][]} */
  const TOOLBAR = [
    ["selectParent", "⤴", "Select the parent component"],
    ["insertBefore", "+↑", "Insert a component above"],
    ["moveUp", "↑", "Move up"],
    ["moveDown", "↓", "Move down"],
    ["duplicate", "⧉", "Duplicate"],
    ["remove", "✕", "Remove"],
    ["insertAfter", "+↓", "Insert a component below"],
  ];

  const mount = () => {
    if (host) return;
    host = document.createElement("ecom-visual-editing");
    root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    const layer = document.createElement("div");
    layer.className = "layer";
    for (const kind of /** @type {const} */ (["parent", "hover", "selected"])) {
      const box = document.createElement("div");
      box.className = `box ${kind}`;
      const label = document.createElement("span");
      label.className = "label";
      if (kind !== "parent") box.append(label);
      layer.append(box);
      boxes[kind] = box;
    }
    toolbar = document.createElement("div");
    toolbar.className = "toolbar";
    toolbar.setAttribute("role", "toolbar");
    for (const [action, text, title] of TOOLBAR) {
      if (action === "insertAfter" || action === "insertBefore") toolbar.append(Object.assign(document.createElement("span"), { className: "sep" }));
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = text;
      button.title = title;
      button.setAttribute("aria-label", title);
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (selected && !button.disabled) send("bridge:action", { action, nodeId: selected.nodeId });
      });
      buttons.set(action, button);
      toolbar.append(button);
      if (action === "insertBefore") toolbar.append(Object.assign(document.createElement("span"), { className: "sep" }));
    }
    layer.append(toolbar);
    root.append(style, layer);
    document.documentElement.append(host);
  };

  const place = (/** @type {HTMLElement | null} */ box, /** @type {Element | null} */ el, /** @type {string} */ label = "") => {
    if (!box) return;
    if (!el) {
      box.style.display = "none";
      return;
    }
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      box.style.display = "none";
      return;
    }
    box.style.display = "block";
    box.style.left = `${r.left}px`;
    box.style.top = `${r.top}px`;
    box.style.width = `${r.width}px`;
    box.style.height = `${r.height}px`;
    const chip = box.querySelector(".label");
    if (chip) {
      chip.textContent = label;
      // Keep the chip on screen for elements at the very top.
      /** @type {HTMLElement} */ (chip).style.top = r.top < 22 ? "2px" : "-20px";
    }
  };

  const render = () => {
    frame = 0;
    if (!connected || mode !== "edit") {
      for (const box of Object.values(boxes)) if (box) box.style.display = "none";
      if (toolbar) toolbar.style.display = "none";
      return;
    }
    const hover = externalHover ?? hovered;
    const selectedEl = selected ? elementFor(selected) : null;
    const hoverEl = hover && !sameTarget(hover, selected) ? elementFor(hover) : null;
    // A selected field also shows its component, faintly.
    const parentEl = selected && selected.path.length ? scopeFor(selected.documentId).querySelector(`[data-ecom-node="${cssEscape(selected.nodeId)}"]`) : null;
    place(boxes.selected, selectedEl, selected ? labelFor(selected) : "");
    place(boxes.hover, hoverEl, hover ? labelFor(hover) : "");
    place(boxes.parent, parentEl);
    if (toolbar) {
      // The toolbar acts on components; it is hidden for fields and the page root.
      const nodeEl = selected && !selected.path.length && selected.nodeId !== "root" && !inline ? selectedEl : null;
      const r = nodeEl?.getBoundingClientRect();
      // Only while the component is on screen; scrolled away, it would float over other content.
      if (!nodeEl || !r || r.bottom < 0 || r.top > window.innerHeight) toolbar.style.display = "none";
      else {
        for (const [action, button] of buttons) button.disabled = allowed[action] === false;
        toolbar.style.display = "flex";
        const top = r.top > 40 ? r.top - 34 : Math.min(r.bottom + 6, window.innerHeight - 36);
        toolbar.style.top = `${Math.max(4, top)}px`;
        toolbar.style.left = `${Math.max(4, Math.min(r.right - toolbar.offsetWidth, window.innerWidth - toolbar.offsetWidth - 4))}px`;
      }
    }
    // Keep following layout changes (images loading, animations, scrolling) while something shows.
    if (selected || hover) schedule();
  };

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(render);
  };

  // ---------------------------------------------------------------- page events

  const onPointerMove = (/** @type {PointerEvent} */ event) => {
    if (!connected || mode !== "edit") return;
    const found = targetFrom(/** @type {Element} */ (event.target));
    const next = found ? found.target : null;
    if (!sameTarget(next, hovered)) {
      hovered = next;
      send("bridge:hover", { nodeId: next ? next.nodeId : null, path: next ? next.path : [], documentId: next ? next.documentId : null });
      schedule();
    }
  };

  const onPointerLeave = () => {
    if (!hovered) return;
    hovered = null;
    send("bridge:hover", { nodeId: null, path: [], documentId: null });
    schedule();
  };

  const onClick = (/** @type {MouseEvent} */ event) => {
    if (!connected || mode !== "edit" || event.altKey) return;
    const path = event.composedPath ? event.composedPath() : [];
    if (host && path.includes(host)) return;
    // Clicks inside the field being edited place the caret; clicks elsewhere end the edit.
    if (inline) {
      if (path.includes(inline.el)) return;
      finishInline();
    }
    const found = targetFrom(/** @type {Element} */ (event.target));
    if (!found) return;
    // In edit mode a click selects; links and buttons in the page do not fire. Alt-click to use them.
    event.preventDefault();
    event.stopPropagation();
    // Another document (say the header while editing a page): report it, and let the admin decide.
    if (!documentId || !found.target.documentId || found.target.documentId === documentId) selected = found.target;
    send("bridge:select", { nodeId: found.target.nodeId, path: found.target.path, documentId: found.target.documentId });
    schedule();
  };

  const finishInline = (/** @type {{ revert?: boolean }} */ options = {}) => {
    if (!inline) return;
    const { el, target, original, timer } = inline;
    clearTimeout(timer);
    if (options.revert) el.textContent = original;
    send("bridge:input", { nodeId: target.nodeId, path: target.path, value: el.textContent ?? "", documentId: target.documentId, done: true });
    el.removeAttribute("contenteditable");
    el.style.removeProperty("outline");
    inline = null;
    schedule();
    // A save that landed while typing re-renders now, not under the caret.
    if (refreshPending) {
      refreshPending = false;
      void refresh();
    }
  };

  const onDoubleClick = (/** @type {MouseEvent} */ event) => {
    if (!connected || mode !== "edit" || event.altKey) return;
    const found = targetFrom(/** @type {Element} */ (event.target));
    if (!found || !found.target.path.length || found.element.getAttribute("data-ecom-patch") !== "text") return;
    if (documentId && found.target.documentId && found.target.documentId !== documentId) return;
    if (inline && inline.el === found.element) return;
    finishInline();
    event.preventDefault();
    event.stopPropagation();
    const el = /** @type {HTMLElement} */ (found.element);
    try {
      el.contentEditable = "plaintext-only";
    } catch {
      el.contentEditable = "true";
    }
    el.style.outline = "none";
    inline = { el, target: found.target, original: el.textContent ?? "", timer: 0 };
    selected = found.target;
    send("bridge:select", { nodeId: found.target.nodeId, path: found.target.path, documentId: found.target.documentId });
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    schedule();
  };

  const onInput = (/** @type {Event} */ event) => {
    if (!inline || event.target !== inline.el) return;
    const current = inline;
    clearTimeout(current.timer);
    current.timer = window.setTimeout(() => send("bridge:input", { nodeId: current.target.nodeId, path: current.target.path, value: current.el.textContent ?? "", documentId: current.target.documentId }), 120);
  };

  const onKeyDown = (/** @type {KeyboardEvent} */ event) => {
    if (inline) {
      if (event.key === "Escape") {
        event.preventDefault();
        finishInline({ revert: true });
      } else if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        finishInline();
      }
      return;
    }
    if (!connected || mode !== "edit") return;
    if (event.key === "Escape" && selected) {
      selected = null;
      send("bridge:select", { nodeId: null, path: [], documentId });
      schedule();
    }
  };

  const reportLocation = () => {
    const path = `${location.pathname}${location.search}`;
    if (path === lastPath) return;
    lastPath = path;
    send("bridge:navigated", { path: location.pathname, url: location.href, title: document.title });
  };

  // Client-side routers navigate with the History API; report those too.
  const wrapHistory = () => {
    for (const method of /** @type {const} */ (["pushState", "replaceState"])) {
      const original = history[method];
      history[method] = function (...args) {
        const result = original.apply(this, /** @type {any} */ (args));
        queueMicrotask(reportLocation);
        return result;
      };
    }
    window.addEventListener("popstate", reportLocation);
  };

  // ---------------------------------------------------------------- admin messages

  const onMessage = async (/** @type {MessageEvent} */ event) => {
    if (!options || event.origin !== options.adminOrigin || event.source !== window.parent) return;
    const data = event.data;
    if (!data || typeof data !== "object" || data.source !== FROM_ADMIN || typeof data.type !== "string") return;
    switch (data.type) {
      case "editor:ping":
        send("bridge:ready", ready());
        return;
      case "editor:connect":
        connected = true;
        mode = data.mode === "browse" ? "browse" : "edit";
        labels = data.labels && typeof data.labels === "object" ? data.labels : {};
        documentId = typeof data.documentId === "string" ? data.documentId : null;
        mount();
        send("bridge:connected", { path: location.pathname });
        schedule();
        return;
      case "editor:mode":
        mode = data.mode === "browse" ? "browse" : "edit";
        schedule();
        return;
      case "editor:select": {
        selected = typeof data.nodeId === "string" ? { nodeId: data.nodeId, path: Array.isArray(data.path) ? data.path.map(String) : [], documentId } : null;
        allowed = data.actions && typeof data.actions === "object" ? data.actions : {};
        const el = selected ? elementFor(selected) : null;
        if (el && data.scroll !== false) {
          const r = el.getBoundingClientRect();
          if (r.bottom < 0 || r.top > window.innerHeight) el.scrollIntoView({ block: "center", behavior: "smooth" });
        }
        schedule();
        return;
      }
      case "editor:hover":
        externalHover = typeof data.nodeId === "string" ? { nodeId: data.nodeId, path: Array.isArray(data.path) ? data.path.map(String) : [], documentId } : null;
        schedule();
        return;
      case "editor:patch": {
        if (typeof data.nodeId !== "string" || !Array.isArray(data.path)) return;
        const key = [data.nodeId, ...data.path].join(".");
        if (typeof data.value === "string" || typeof data.value === "number") {
          for (const el of scopeFor(documentId).querySelectorAll(`[data-ecom-field="${cssEscape(key)}"][data-ecom-patch="text"]`)) if (el !== inline?.el) el.textContent = String(data.value);
        }
        options.onPatch?.({ nodeId: data.nodeId, path: data.path.map(String), value: data.value });
        schedule();
        return;
      }
      case "editor:refresh":
        if (inline) refreshPending = true;
        else await refresh();
        return;
      case "editor:navigate":
        if (typeof data.path === "string" && data.path.startsWith("/")) {
          if (options.navigate) options.navigate(data.path);
          else location.assign(data.path);
        }
        return;
    }
  };

  const ready = () => ({ path: location.pathname, url: location.href, title: document.title, bridgeVersion: VERSION, features: ["inline-text", "actions", "documents"] });

  const refresh = async () => {
    if (options?.onRefresh) await options.onRefresh();
    else location.reload();
  };

  // ---------------------------------------------------------------- public API

  w.EcomVisualEditing = {
    version: VERSION,
    /** True once the admin's editor has connected. */
    get connected() {
      return connected;
    },
    /** Start the bridge. Call once, in draft mode, with the admin origin from the preview session. */
    init(/** @type {Options} */ init) {
      if (options) return this;
      if (!init || typeof init.adminOrigin !== "string" || !/^https?:\/\//.test(init.adminOrigin)) throw new Error("EcomVisualEditing.init needs { adminOrigin }");
      options = { ...init, adminOrigin: new URL(init.adminOrigin).origin };
      window.addEventListener("message", onMessage);
      if (framed) {
        document.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
        document.documentElement.addEventListener("pointerleave", onPointerLeave);
        document.addEventListener("click", onClick, { capture: true });
        document.addEventListener("dblclick", onDoubleClick, { capture: true });
        document.addEventListener("input", onInput, { capture: true });
        document.addEventListener("keydown", onKeyDown, { capture: true });
        window.addEventListener("resize", schedule, { passive: true });
        window.addEventListener("scroll", schedule, { capture: true, passive: true });
        wrapHistory();
        lastPath = `${location.pathname}${location.search}`;
        send("bridge:ready", ready());
      }
      return this;
    },
    /** Tell the admin a refresh has rendered (it shows "updating" until then). */
    rendered() {
      send("bridge:rendered", { path: location.pathname });
      schedule();
    },
    /** Attribute helpers for frontends rendering plain HTML. */
    attributes: {
      document: (/** @type {string} */ id) => ({ "data-ecom-document": id }),
      node: (/** @type {string} */ nodeId, /** @type {string} */ component) => ({ "data-ecom-node": nodeId, "data-ecom-component": component }),
      field: (/** @type {string} */ nodeId, /** @type {...string} */ ...path) => ({ "data-ecom-field": [nodeId, ...path].join(".") }),
    },
  };
})();
