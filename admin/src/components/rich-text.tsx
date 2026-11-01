import { Image } from "@tiptap/extension-image";
import { Placeholder } from "@tiptap/extensions";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { Bold, Code, CodeXml, Heading2, Heading3, ImagePlus, Images, Italic, Link2, List, ListOrdered, Loader2, Minus, Quote, Redo2, Strikethrough, TriangleAlert, Undo2, Unlink, Upload } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { LocaleTabs } from "@/components/inputs";
import { MediaPicker } from "@/components/media-picker";
import { Button } from "@/components/ui/button";
import { Input, Textarea, useFieldControl } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent, Tooltip } from "@/components/ui/overlay";
import { useAuth } from "@/lib/auth";
import { isUploading, MEDIA_READ, MEDIA_WRITE, mediaAccept, useMediaStorage, useMediaUploads, type MediaAsset } from "@/lib/media-upload";
import { cn } from "@/lib/utils";

/**
 * Tiptap rich text that stores HTML or Markdown, as the field expects. The source view opens first
 * when the text has markup the visual editor would drop (tables, inline styles).
 */

export type RichTextFormat = "html" | "markdown";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl+";

/** Elements the editor keeps, and wrappers it unwraps while keeping their text. */
const KEPT_TAGS = new Set(["P", "BR", "H1", "H2", "H3", "H4", "H5", "H6", "STRONG", "B", "EM", "I", "S", "DEL", "STRIKE", "CODE", "PRE", "BLOCKQUOTE", "UL", "OL", "LI", "A", "IMG", "HR"]);
const WRAPPER_TAGS = new Set(["DIV", "SPAN", "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN"]);

/** Whether the visual editor would drop formatting from this text (tables, styles, embeds…). */
export const hasUnsupportedMarkup = (text: string, format: RichTextFormat) => {
  if (!text.trim()) return false;
  if (format === "markdown") return /^\s*\|.*\|\s*$\n^\s*\|?\s*:?-{3,}/m.test(text) || /<\/?[a-z][a-z0-9-]*(\s[^>]*)?>/i.test(text);
  const body = new DOMParser().parseFromString(text, "text/html").body;
  return [...body.querySelectorAll("*")].some((el) => (!KEPT_TAGS.has(el.tagName) && !WRAPPER_TAGS.has(el.tagName)) || el.hasAttribute("style"));
};

/** Plain text that reads as Markdown, so pasting it formats it rather than showing the symbols. */
const MARKDOWN_HINT = /(^|\n) {0,3}(#{1,6} |[-*+] |\d+[.)] |> |```)|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\)/;

/** "" for an empty editor, and no trailing empty paragraphs. */
const serialize = (editor: Editor, format: RichTextFormat) => {
  if (editor.isEmpty) return "";
  return format === "markdown" ? editor.getMarkdown().trimEnd() : editor.getHTML().replace(/(<p><\/p>)+$/, "");
};

const SAFE_URL = /^(https?:\/\/|mailto:|tel:|\/|#)/i;
/** "example.com/x" becomes https://example.com/x; javascript: and the like are refused. */
const normalizeUrl = (input: string) => {
  const url = input.trim();
  if (!url) return "";
  if (SAFE_URL.test(url)) return url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
  return `https://${url}`;
};

type RichTextEditorProps = {
  value: string;
  onChange: (value: string) => void;
  /** What the field stores: HTML (catalog descriptions) or Markdown (page builder text). */
  format: RichTextFormat;
  placeholder?: string;
  id?: string;
  invalid?: boolean;
  disabled?: boolean;
  /** Height of the empty editor, in lines. */
  rows?: number;
  className?: string;
  /** The text's language, for library images' alt text. */
  locale?: string;
};

export const RichTextEditor = ({ value, onChange, format, placeholder, id, invalid, disabled, rows = 6, className, locale }: RichTextEditorProps) => {
  // A surrounding Field labels, describes and marks the editor invalid.
  const wiring = useFieldControl({ id, "aria-invalid": invalid });
  const controlId = wiring.props.id;
  const describedBy = wiring.props["aria-describedby"];
  const isInvalid = wiring.props["aria-invalid"] === true || wiring.props["aria-invalid"] === "true";
  // The value this component last reported, to tell its own updates from outside changes.
  const emitted = useRef(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const editorRef = useRef<Editor | null>(null);
  const [source, setSource] = useState(() => hasUnsupportedMarkup(value, format));
  const [confirmVisual, setConfirmVisual] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Underline has no Markdown and reads as a link; the storefront sets link attributes.
        underline: false,
        // It keeps an empty paragraph at the end, which would be saved with every text.
        trailingNode: false,
        link: { openOnClick: false, autolink: true, defaultProtocol: "https", HTMLAttributes: { target: null, rel: null } },
      }),
      Image.configure({ allowBase64: false }),
      Placeholder.configure({ placeholder: placeholder ?? "" }),
      Markdown,
    ],
    content: value,
    contentType: format,
    editable: !disabled,
    editorProps: {
      attributes: {
        class: "rich-text-content outline-none",
        role: "textbox",
        "aria-multiline": "true",
        // Reapplied on every render (useEditor passes changed options on), so errors show up.
        ...(controlId ? { id: controlId } : {}),
        ...(wiring.labelledBy ? { "aria-labelledby": wiring.labelledBy } : {}),
        ...(describedBy ? { "aria-describedby": describedBy } : {}),
        ...(isInvalid ? { "aria-invalid": "true" } : {}),
        style: `min-height: ${rows * 1.6 + 1}rem`,
      },
      handlePaste: (_view, event) => {
        const data = event.clipboardData;
        const text = data?.getData("text/plain");
        // Rich pastes (from a web page or a document) keep their formatting as usual.
        if (!text || data?.types.includes("text/html") || !MARKDOWN_HINT.test(text)) return false;
        editorRef.current?.commands.insertContent(text, { contentType: "markdown" });
        return true;
      },
      handleKeyDown: (_view, event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
          event.preventDefault();
          setLinkOpen(true);
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor }) => {
      const next = serialize(editor, format);
      if (next === emitted.current) return;
      emitted.current = next;
      onChangeRef.current(next);
    },
  });
  editorRef.current = editor;

  // Outside changes (a reset, another locale, a restored version) replace the content.
  useEffect(() => {
    if (!editor || value === emitted.current) return;
    emitted.current = value;
    editor.commands.setContent(value, { contentType: format, emitUpdate: false });
  }, [editor, value, format]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  const showVisual = () => {
    setConfirmVisual(false);
    setSource(false);
    editor?.commands.setContent(value, { contentType: format, emitUpdate: false });
  };
  const sourceLabel = format === "markdown" ? "Markdown" : "HTML";
  const unsupported = source && hasUnsupportedMarkup(value, format);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border border-input bg-transparent shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/40 dark:bg-input/30",
        isInvalid && "border-destructive focus-within:ring-destructive/30",
        disabled && "opacity-60",
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-0.5 border-b bg-muted/40 px-1 py-0.5" role="toolbar" aria-label="Formatting">
        {editor && !source ? (
          <FormattingTools editor={editor} disabled={disabled} linkOpen={linkOpen} onLinkOpen={setLinkOpen} locale={locale} />
        ) : (
          <span className="px-2 text-[11px] text-muted-foreground">Editing the {sourceLabel} source</span>
        )}
        <Tooltip content={source ? "Back to the visual editor" : `Edit the ${sourceLabel} directly`}>
          <button
            type="button"
            disabled={disabled}
            onClick={() => (source ? (hasUnsupportedMarkup(value, format) ? setConfirmVisual(true) : showVisual()) : setSource(true))}
            aria-pressed={source}
            className={cn(
              "ml-auto flex h-7 items-center gap-1 rounded px-2 text-[11px] font-medium text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-40",
              source && "bg-background text-foreground shadow-xs",
            )}
          >
            <CodeXml className="size-3.5" />
            {sourceLabel}
          </button>
        </Tooltip>
      </div>

      {unsupported ? (
        <div className="flex items-start gap-2 border-b bg-warning/10 px-3 py-2 text-xs text-foreground">
          <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" />
          {confirmVisual ? (
            <div className="flex flex-1 flex-wrap items-center gap-2">
              <span className="flex-1">The visual editor removes tables, inline styles and embeds from this text once you edit it there.</span>
              <Button type="button" size="sm" variant="outline" className="h-7" onClick={() => setConfirmVisual(false)}>
                Keep {sourceLabel}
              </Button>
              <Button type="button" size="sm" className="h-7" onClick={showVisual}>
                Edit visually
              </Button>
            </div>
          ) : (
            <span>This text has formatting the visual editor can't show (such as tables or inline styles), so it opens as {sourceLabel}.</span>
          )}
        </div>
      ) : null}

      {source ? (
        <Textarea
          id={controlId}
          value={value}
          rows={Math.max(rows, 8)}
          spellCheck={false}
          disabled={disabled}
          aria-invalid={isInvalid || undefined}
          aria-labelledby={wiring.labelledBy}
          aria-describedby={describedBy}
          onChange={(event) => {
            emitted.current = event.target.value;
            onChangeRef.current(event.target.value);
          }}
          className="rounded-none border-0 font-mono text-[13px] shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
      ) : (
        // A click on the padding around the text puts the caret at the end.
        <EditorContent editor={editor} className="cursor-text px-3 py-2" onClick={(event) => event.target === event.currentTarget && editor?.commands.focus("end")} />
      )}
    </div>
  );
};

const ToolButton = ({ label, keys, active, disabled, onClick, children }: { label: string; keys?: string; active?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) => (
  <Tooltip content={keys ? `${label} ${keys}` : label}>
    <button
      type="button"
      // Keep the selection in the editor while clicking the toolbar.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-40 [&_svg]:size-3.5",
        active && "bg-background text-foreground shadow-xs",
      )}
    >
      {children}
    </button>
  </Tooltip>
);

const Divider = () => <span className="mx-0.5 h-4 w-px bg-border" aria-hidden />;

const FormattingTools = ({ editor, disabled, linkOpen, onLinkOpen, locale }: { editor: Editor; disabled?: boolean; linkOpen: boolean; onLinkOpen: (open: boolean) => void; locale?: string }) => {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      strike: e.isActive("strike"),
      code: e.isActive("code"),
      h2: e.isActive("heading", { level: 2 }),
      h3: e.isActive("heading", { level: 3 }),
      bulletList: e.isActive("bulletList"),
      orderedList: e.isActive("orderedList"),
      blockquote: e.isActive("blockquote"),
      link: e.isActive("link"),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const chain = () => editor.chain().focus();
  return (
    <>
      <ToolButton label="Bold" keys={`${MOD}B`} active={state.bold} disabled={disabled} onClick={() => chain().toggleBold().run()}>
        <Bold />
      </ToolButton>
      <ToolButton label="Italic" keys={`${MOD}I`} active={state.italic} disabled={disabled} onClick={() => chain().toggleItalic().run()}>
        <Italic />
      </ToolButton>
      <ToolButton label="Strikethrough" active={state.strike} disabled={disabled} onClick={() => chain().toggleStrike().run()}>
        <Strikethrough />
      </ToolButton>
      <ToolButton label="Code" active={state.code} disabled={disabled} onClick={() => chain().toggleCode().run()}>
        <Code />
      </ToolButton>
      <Divider />
      <ToolButton label="Heading (##)" active={state.h2} disabled={disabled} onClick={() => chain().toggleHeading({ level: 2 }).run()}>
        <Heading2 />
      </ToolButton>
      <ToolButton label="Subheading (###)" active={state.h3} disabled={disabled} onClick={() => chain().toggleHeading({ level: 3 }).run()}>
        <Heading3 />
      </ToolButton>
      <ToolButton label="Bulleted list (-)" active={state.bulletList} disabled={disabled} onClick={() => chain().toggleBulletList().run()}>
        <List />
      </ToolButton>
      <ToolButton label="Numbered list (1.)" active={state.orderedList} disabled={disabled} onClick={() => chain().toggleOrderedList().run()}>
        <ListOrdered />
      </ToolButton>
      <ToolButton label="Quote (>)" active={state.blockquote} disabled={disabled} onClick={() => chain().toggleBlockquote().run()}>
        <Quote />
      </ToolButton>
      <ToolButton label="Divider (---)" disabled={disabled} onClick={() => chain().setHorizontalRule().run()}>
        <Minus />
      </ToolButton>
      <Divider />
      <LinkTool editor={editor} active={state.link} disabled={disabled} open={linkOpen} onOpenChange={onLinkOpen} />
      <ImageTool editor={editor} disabled={disabled} locale={locale} />
      <Divider />
      <ToolButton label="Undo" keys={`${MOD}Z`} disabled={disabled || !state.canUndo} onClick={() => chain().undo().run()}>
        <Undo2 />
      </ToolButton>
      <ToolButton label="Redo" keys={isMac ? "⇧⌘Z" : "Ctrl+Y"} disabled={disabled || !state.canRedo} onClick={() => chain().redo().run()}>
        <Redo2 />
      </ToolButton>
    </>
  );
};

/** Add, change or remove the link on the selection (or insert the URL as a link). */
const LinkTool = ({ editor, active, disabled, open, onOpenChange }: { editor: Editor; active: boolean; disabled?: boolean; open: boolean; onOpenChange: (open: boolean) => void }) => {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setUrl((editor.getAttributes("link").href as string | undefined) ?? "");
    setError(null);
  }, [open, editor]);
  const apply = () => {
    const href = normalizeUrl(url);
    if (href === null) return setError("Use a web address (https://…), a path (/about), mailto: or tel:");
    if (!href) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
    } else if (editor.state.selection.empty && !editor.isActive("link")) {
      editor.chain().focus().insertContent({ type: "text", text: url.trim(), marks: [{ type: "link", attrs: { href } }] }).run();
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    }
    onOpenChange(false);
  };
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <span>
          <ToolButton label="Link" keys={`${MOD}K`} active={active} disabled={disabled} onClick={() => onOpenChange(!open)}>
            <Link2 />
          </ToolButton>
        </span>
      </PopoverAnchor>
      <PopoverContent className="w-80 p-3">
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            apply();
          }}
        >
          <label className="text-xs font-medium" htmlFor="rich-text-link">
            Link to
          </label>
          <Input id="rich-text-link" autoFocus value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://… or /about" aria-invalid={!!error || undefined} />
          {error ? <p className="text-xs text-destructive">{error}</p> : <p className="text-xs text-muted-foreground">A web address, a storefront path, mailto: or tel:.</p>}
          <div className="flex justify-end gap-2">
            {active ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  editor.chain().focus().extendMarkRange("link").unsetLink().run();
                  onOpenChange(false);
                }}
              >
                <Unlink />
                Remove link
              </Button>
            ) : null}
            <Button type="submit" size="sm">
              {active ? "Update" : "Add link"}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
};

/** Library alt text in the text's language, else the API's default. */
const libraryAlt = (asset: MediaAsset, locale: string | undefined) => (locale ? asset.alts?.find((a) => a.locale === locale)?.value : null) || asset.alt || "";

/** Typed alt text wins over a library image's own. An upload carries on if the popover closes. */
const ImageTool = ({ editor, disabled, locale }: { editor: Editor; disabled?: boolean; locale?: string }) => {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [src, setSrc] = useState("");
  const [alt, setAlt] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const storage = useMediaStorage();
  const uploads = useMediaUploads({ kind: "IMAGE" });
  const sending = uploads.uploads.find(isUploading);
  const insert = (url: string, fallbackAlt = "") => {
    if (editor.isDestroyed) return;
    if (!/^(https?:\/\/|\/)/i.test(url.trim())) return toast.error("Use an https:// address or upload a file");
    editor.chain().focus().setImage({ src: url.trim(), alt: alt.trim() || fallbackAlt.trim() || undefined }).run();
    setOpen(false);
    setSrc("");
    setAlt("");
  };
  const insertAsset = (asset: MediaAsset) => insert(asset.url ?? "", libraryAlt(asset, locale));
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <span>
            <ToolButton label="Image" disabled={disabled} onClick={() => setOpen(!open)}>
              <ImagePlus />
            </ToolButton>
          </span>
        </PopoverAnchor>
        <PopoverContent className="w-80 p-3">
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              insert(src);
            }}
          >
            <label className="text-xs font-medium" htmlFor="rich-text-image">
              Image address
            </label>
            <Input id="rich-text-image" autoFocus value={src} onChange={(event) => setSrc(event.target.value)} placeholder="https://…" />
            <label className="text-xs font-medium" htmlFor="rich-text-alt">
              Description for screen readers
            </label>
            <Input id="rich-text-alt" value={alt} onChange={(event) => setAlt(event.target.value)} placeholder="What the image shows" />
            <div className="flex flex-wrap items-center gap-2">
              {can(MEDIA_WRITE) ? (
                <Button type="button" size="sm" variant="outline" disabled={!!sending} onClick={() => file.current?.click()}>
                  {sending ? <Loader2 className="animate-spin" /> : <Upload />}
                  {sending ? <span className="tabular-nums">{`Uploading ${Math.floor(sending.progress * 100)}%`}</span> : "Upload…"}
                </Button>
              ) : null}
              {can(MEDIA_READ) ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setOpen(false);
                    setPicking(true);
                  }}
                >
                  <Images />
                  Library…
                </Button>
              ) : null}
              <Button type="submit" size="sm" className="ml-auto" disabled={!src.trim()}>
                Insert
              </Button>
            </div>
          </form>
        </PopoverContent>
      </Popover>
      <input
        ref={file}
        type="file"
        accept={mediaAccept(storage, "IMAGE")}
        className="hidden"
        tabIndex={-1}
        aria-hidden
        onChange={async (event) => {
          const chosen = event.target.files?.[0];
          event.target.value = "";
          if (!chosen) return;
          const [upload] = await uploads.add([chosen]);
          uploads.dismiss();
          if (upload?.asset) insertAsset(upload.asset);
          else if (upload) toast.error(`Couldn't upload ${chosen.name}`, { description: upload.error ?? undefined });
        }}
      />
      <MediaPicker open={picking} onOpenChange={setPicking} kind="IMAGE" title="Insert an image" confirmLabel="Insert" onSelect={([asset]) => asset && insertAsset(asset)} />
    </>
  );
};

/**
 * One rich text per locale; empty ones fall back to the first on the storefront. `format: "detect"`
 * keeps each text's format and writes new ones as HTML.
 */
export const LocalizedRichText = ({
  value,
  onChange,
  locales,
  format,
  placeholder,
  rows,
  invalid,
  disabled,
}: {
  value: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
  locales: readonly string[];
  format: RichTextFormat | "detect";
  placeholder?: string;
  rows?: number;
  invalid?: boolean;
  disabled?: boolean;
}) => {
  const [active, setActive] = useState(locales[0] ?? "en-US");
  const current = locales.includes(active) ? active : (locales[0] ?? active);
  const formats = useRef(new Map<string, RichTextFormat>());
  const text = value[current] ?? "";
  let resolved = format === "detect" ? formats.current.get(current) : format;
  if (!resolved) {
    resolved = !text.trim() || /<\/?[a-z][a-z0-9-]*(\s[^>]*)?>/i.test(text) ? "html" : "markdown";
    formats.current.set(current, resolved);
  }
  const fallback = current !== locales[0] ? value[locales[0]!]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
  return (
    <div className="flex flex-col gap-1.5">
      <LocaleTabs locales={locales} value={value} current={current} onSelect={setActive} />
      <RichTextEditor
        key={current}
        locale={current}
        value={text}
        onChange={(next) => onChange({ ...value, [current]: next })}
        format={resolved}
        placeholder={fallback ? `Empty: shows the ${locales[0]} text (${fallback.slice(0, 80)}${fallback.length > 80 ? "…" : ""})` : placeholder}
        rows={rows}
        invalid={invalid}
        disabled={disabled}
      />
    </div>
  );
};
