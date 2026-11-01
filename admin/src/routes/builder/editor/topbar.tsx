import { Link } from "@tanstack/react-router";
import { AlertCircle, ArrowLeft, Check, CloudOff, ExternalLink, Hand, History, Keyboard, Loader2, Monitor, MousePointer2, PanelLeft, PanelRight, Redo2, Smartphone, Tablet, Undo2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/feedback";
import { Select } from "@/components/ui/menu";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Tooltip } from "@/components/ui/overlay";
import { languageName } from "@/lib/format";
import { usePreviousScreen } from "@/lib/nav-history";
import { cn } from "@/lib/utils";
import { HistorySheet } from "./history";
import { ComponentIcon } from "./icons";
import { usePreviewSession } from "./preview";
import { PublishMenu, type Publishing } from "./publish";
import { SectionsBadge } from "./sections";
import { StatusBadge } from "./status";
import { useEditor, useEditorState, type Device } from "./store";
import { TemplateBadge } from "./template";
import { docTitle, MOD } from "./util";

export const TopBar = ({ publishing, panels, onPanels }: { publishing: Publishing; panels: { tree: boolean; inspector: boolean }; onPanels: (panels: { tree: boolean; inspector: boolean }) => void }) => {
  const { contentType } = useEditor();
  const title = useEditorState((s) => docTitle(s.doc, s.locale));
  const path = useEditorState((s) => s.doc.path);
  const status = useEditorState((s) => s.meta.status);
  const scheduledAt = useEditorState((s) => s.meta.scheduledAt);
  const dirty = useEditorState((s) => s.doc !== s.savedDoc);
  const [history, setHistory] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  // The screen the editor was opened from, such as a product or a filtered page list; else /pages.
  const back = usePreviousScreen("/pages");
  const backLabel = back.title ? `Back to ${back.title}` : "Back to pages";

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-2 sm:px-3">
      <Tooltip content={back.title ? backLabel : "All pages"}>
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to={back.to} search={back.search} hash={back.hash} aria-label={backLabel}>
            <ArrowLeft />
          </Link>
        </Button>
      </Tooltip>
      <div className="flex min-w-0 items-center gap-2.5 pr-2">
        <span className="hidden size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary sm:flex">
          <ComponentIcon name={contentType.icon} />
        </span>
        <div className="min-w-0 leading-tight">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-sm font-semibold">{title || "Untitled"}</h1>
            <StatusBadge status={status} dirty={dirty} scheduledAt={scheduledAt} className="hidden md:inline-flex" />
          </div>
          {contentType.templateFor ? (
            <div className="mt-0.5 flex min-w-0">
              <TemplateBadge onOpen={() => !panels.inspector && onPanels({ ...panels, inspector: true })} />
            </div>
          ) : contentType.sectionsFor ? (
            <div className="mt-0.5 flex min-w-0">
              <SectionsBadge />
            </div>
          ) : (
            <p className="truncate font-mono text-[11px] text-muted-foreground">{path ?? contentType.name}</p>
          )}
        </div>
      </div>

      <div className="mx-auto hidden items-center gap-1.5 lg:flex">
        <LocaleSwitch />
        <DeviceSwitch />
        <ModeSwitch />
      </div>

      <div className="ml-auto flex items-center gap-1 lg:ml-0">
        <PanelToggle label={panels.tree ? "Hide the structure" : "Show the structure"} active={panels.tree} onClick={() => onPanels({ ...panels, tree: !panels.tree })}>
          <PanelLeft />
        </PanelToggle>
        <PanelToggle label={panels.inspector ? "Hide the inspector" : "Show the inspector"} active={panels.inspector} onClick={() => onPanels({ ...panels, inspector: !panels.inspector })}>
          <PanelRight />
        </PanelToggle>
        <span className="mx-1 h-5 w-px bg-border" />
        <UndoRedo />
        <SaveState />
        <span className="mx-1 h-5 w-px bg-border" />
        <Tooltip content="Keyboard shortcuts">
          <Button variant="ghost" size="icon-sm" aria-label="Keyboard shortcuts" onClick={() => setShortcuts(true)} className="hidden xl:inline-flex">
            <Keyboard />
          </Button>
        </Tooltip>
        <Tooltip content="History">
          <Button variant="ghost" size="icon-sm" aria-label="History" onClick={() => setHistory(true)}>
            <History />
          </Button>
        </Tooltip>
        <OpenPreview />
        <PublishMenu publishing={publishing} />
      </div>
      <HistorySheet open={history} onOpenChange={setHistory} />
      <ShortcutsDialog open={shortcuts} onOpenChange={setShortcuts} />
    </header>
  );
};

/** Language, device and mode, for narrow windows (shown under the top bar). */
export const CompactControls = () => (
  <div className="flex shrink-0 items-center justify-center gap-1.5 border-b bg-background px-2 py-1.5 lg:hidden">
    <LocaleSwitch />
    <DeviceSwitch />
    <ModeSwitch />
  </div>
);

const PanelToggle = ({ label, active, onClick, children }: { label: string; active: boolean; onClick: () => void; children: ReactNode }) => (
  <Tooltip content={label}>
    <Button variant="ghost" size="icon-sm" aria-label={label} aria-pressed={active} onClick={onClick} className={cn(!active && "text-muted-foreground")}>
      {children}
    </Button>
  </Tooltip>
);

const LocaleSwitch = () => {
  const { locales, store } = useEditor();
  const locale = useEditorState((s) => s.locale);
  if (locales.length < 2) return null;
  return (
    <Tooltip content="The language you edit and preview">
      <div>
        <Select aria-label="Language" className="h-8 w-[11.5rem] text-[13px]" value={locale} onValueChange={(next) => store.set({ locale: next })} options={locales.map((l) => ({ value: l, label: `${languageName(l)}`, description: l }))} />
      </div>
    </Tooltip>
  );
};

const DEVICE_ICONS: Record<Device, typeof Monitor> = { desktop: Monitor, tablet: Tablet, mobile: Smartphone };

const Segmented = <T extends string,>({ value, onChange, options, label }: { value: T; onChange: (value: T) => void; options: { value: T; label: string; icon: typeof Monitor; text?: string }[]; label: string }) => (
  <div className="flex rounded-md bg-muted p-0.5" role="radiogroup" aria-label={label}>
    {options.map((o) => (
      <Tooltip key={o.value} content={o.label}>
        <button
          type="button"
          role="radio"
          aria-checked={value === o.value}
          aria-label={o.label}
          onClick={() => onChange(o.value)}
          className={cn("flex h-7 items-center gap-1.5 rounded px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground", value === o.value && "bg-background text-foreground shadow-xs")}
        >
          <o.icon className="size-3.5" />
          {o.text ? <span className="hidden xl:inline">{o.text}</span> : null}
        </button>
      </Tooltip>
    ))}
  </div>
);

const DeviceSwitch = () => {
  const { store } = useEditor();
  const device = useEditorState((s) => s.device);
  return (
    <Segmented
      label="Device"
      value={device}
      onChange={(next) => store.set({ device: next })}
      options={[
        { value: "desktop", label: "Desktop", icon: DEVICE_ICONS.desktop },
        { value: "tablet", label: "Tablet (820px)", icon: DEVICE_ICONS.tablet },
        { value: "mobile", label: "Mobile (390px)", icon: DEVICE_ICONS.mobile },
      ]}
    />
  );
};

const ModeSwitch = () => {
  const { store } = useEditor();
  const mode = useEditorState((s) => s.mode);
  return (
    <Segmented
      label="Mode"
      value={mode}
      onChange={(next) => store.set({ mode: next })}
      options={[
        { value: "edit", label: "Edit: click to select", icon: MousePointer2, text: "Edit" },
        { value: "browse", label: "Browse: use links and buttons", icon: Hand, text: "Browse" },
      ]}
    />
  );
};

const UndoRedo = () => {
  const { actions } = useEditor();
  const canUndo = useEditorState((s) => s.past.length > 0);
  const canRedo = useEditorState((s) => s.future.length > 0);
  return (
    <>
      <Tooltip content={`Undo ${MOD}Z`}>
        <Button variant="ghost" size="icon-sm" aria-label="Undo" disabled={!canUndo} onClick={actions.undo}>
          <Undo2 />
        </Button>
      </Tooltip>
      <Tooltip content={`Redo ⇧${MOD}Z`}>
        <Button variant="ghost" size="icon-sm" aria-label="Redo" disabled={!canRedo} onClick={actions.redo}>
          <Redo2 />
        </Button>
      </Tooltip>
    </>
  );
};

const SaveState = () => {
  const { actions } = useEditor();
  const saving = useEditorState((s) => s.saving);
  const dirty = useEditorState((s) => s.doc !== s.savedDoc);
  const error = useEditorState((s) => s.saveError);
  const conflict = useEditorState((s) => !!s.conflict);
  const state = conflict
    ? { icon: <AlertCircle className="text-destructive" />, text: "Conflict", hint: "Someone else saved this page; reload to continue", tone: "text-destructive" }
    : saving
      ? { icon: <Loader2 className="animate-spin" />, text: "Saving…", hint: "Saving the draft", tone: "text-muted-foreground" }
      : error
        ? { icon: <CloudOff className="text-destructive" />, text: "Not saved", hint: `${error} · click to retry`, tone: "text-destructive" }
        : dirty
          ? { icon: <span className="size-2 rounded-full bg-warning" />, text: "Unsaved changes", hint: `Saving shortly · ${MOD}S saves now`, tone: "text-muted-foreground" }
          : { icon: <Check className="text-success" />, text: "Saved", hint: "Every change is saved to the draft automatically", tone: "text-muted-foreground" };
  return (
    <Tooltip content={state.hint}>
      <button
        type="button"
        onClick={() => void actions.flush()}
        aria-live="polite"
        className={cn("flex h-8 min-w-[7.5rem] items-center gap-1.5 rounded-md px-2 text-xs whitespace-nowrap hover:bg-accent [&_svg]:size-3.5", state.tone)}
      >
        {state.icon}
        <span className="hidden sm:inline">{state.text}</span>
      </button>
    </Tooltip>
  );
};

const OpenPreview = () => {
  const { frontend } = useEditor();
  const session = usePreviewSession(frontend);
  const url = session.data?.url;
  return (
    <Tooltip content={frontend ? "Open the preview in a new tab" : "No storefront to preview in yet"}>
      <span>
        <Button variant="ghost" size="icon-sm" aria-label="Open the preview in a new tab" disabled={!url} asChild={!!url}>
          {url ? (
            <a href={url} target="_blank" rel="noreferrer">
              <ExternalLink />
            </a>
          ) : (
            <ExternalLink />
          )}
        </Button>
      </span>
    </Tooltip>
  );
};

const SHORTCUTS: [string, string][] = [
  [`${MOD}S`, "Save now"],
  [`${MOD}Z`, "Undo"],
  [`⇧${MOD}Z`, "Redo"],
  [`${MOD}D`, "Duplicate the selected component"],
  ["⌫ / Delete", "Delete the selected component"],
  [`${MOD}↑ / ${MOD}↓`, "Move it up or down"],
  ["↑ / ↓ in the tree", "Select the previous or next component"],
  ["← / → in the tree", "Fold or unfold"],
  ["Esc", "Deselect (shows page settings)"],
  ["Alt-click in the preview", "Use a link or button while editing"],
];

const ShortcutsDialog = ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>Keyboard shortcuts</DialogTitle>
        <DialogDescription>Shortcuts that change components work when you are not typing in a field.</DialogDescription>
      </DialogHeader>
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-[13px]">
        {SHORTCUTS.map(([keys, what]) => (
          <div key={keys} className="contents">
            <dt>
              <Kbd className="h-6 px-2 text-[12px]">{keys}</Kbd>
            </dt>
            <dd className="text-muted-foreground">{what}</dd>
          </div>
        ))}
      </dl>
    </DialogContent>
  </Dialog>
);
