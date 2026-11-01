import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark, CloudUpload, History, Loader2, RotateCcw, Save, Sparkles, Upload } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog, Sheet, SheetContent } from "@/components/ui/overlay";
import { DialogDescription, DialogTitle } from "@/components/ui/overlay";
import { request, unwrap } from "@/lib/api";
import { formatDateTime, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { BUILDER_KEYS, PageVersionRestoreMutation, PageVersionSaveMutation, PageVersionsQuery, type PageVersionRow } from "./api";
import { useEditor, useEditorState, type PageMeta } from "./store";
import type { PageDocument } from "../model";

/** Version history; the API adds an autosave checkpoint every ten minutes of editing. */

const KINDS: Record<string, { label: string; tone: BadgeVariant; icon: ReactNode }> = {
  PUBLISH: { label: "Published", tone: "success", icon: <Upload className="size-3" /> },
  SAVE: { label: "Saved", tone: "info", icon: <Bookmark className="size-3" /> },
  RESTORE: { label: "Restored", tone: "warning", icon: <RotateCcw className="size-3" /> },
  AUTOSAVE: { label: "Autosave", tone: "secondary", icon: <CloudUpload className="size-3" /> },
};

export const HistorySheet = ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) => {
  const { pageId, actions, store } = useEditor();
  const queryClient = useQueryClient();
  const version = useEditorState((s) => s.version);
  const versions = useQuery({ queryKey: BUILDER_KEYS.versions(pageId), queryFn: () => request(PageVersionsQuery, { id: pageId }), enabled: open, staleTime: 0 });
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [restoring, setRestoring] = useState<PageVersionRow | null>(null);
  const [busy, setBusy] = useState(false);
  const list = versions.data?.page?.versions ?? [];

  const saveVersion = async () => {
    setSaving(true);
    try {
      if (!(await actions.flush())) throw new Error(store.get().saveError ?? "Save the latest changes first");
      unwrap((await request(PageVersionSaveMutation, { id: pageId, label: label.trim() || null })).pageVersionSave);
      setLabel("");
      toast.success("Version saved", { description: "Named versions are kept when old autosaves are pruned." });
      void queryClient.invalidateQueries({ queryKey: BUILDER_KEYS.versions(pageId) });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the version");
    } finally {
      setSaving(false);
    }
  };

  const restore = async (row: PageVersionRow) => {
    setBusy(true);
    try {
      if (!(await actions.flush())) throw new Error(store.get().saveError ?? "Save the latest changes first");
      // The API keeps the replaced draft in history ("Before restoring …").
      const page = unwrap((await request(PageVersionRestoreMutation, { id: pageId, versionId: row.id! })).pageVersionRestore).page;
      if (page) {
        const { document, ...meta } = page;
        actions.replaceDocument(document as PageDocument, page.version ?? store.get().version, meta as Partial<PageMeta>);
      }
      toast.success(`Restored ${row.label ?? `version ${row.version}`}`, { description: "It is in the draft now; publish to make it live." });
      setRestoring(null);
      void queryClient.invalidateQueries({ queryKey: BUILDER_KEYS.versions(pageId) });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not restore the version");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 p-0 sm:w-[26rem]">
        <div className="border-b px-5 pt-5 pb-4">
          <DialogTitle className="flex items-center gap-2 text-base font-semibold">
            <History className="size-4 text-muted-foreground" /> History
          </DialogTitle>
          <DialogDescription className="mt-1 text-[13px]">Restore any version into the draft. Publishes, named versions and autosave checkpoints are kept.</DialogDescription>
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void saveVersion();
            }}
          >
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name this version (optional)" className="h-8 text-[13px]" aria-label="Version name" />
            <Button type="submit" size="sm" loading={saving}>
              {saving ? null : <Save />}
              Save version
            </Button>
          </form>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {versions.isLoading ? (
            <p className="flex items-center gap-2 px-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading history…
            </p>
          ) : list.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">No versions yet. Publishing, naming a version and long editing sessions add them.</p>
          ) : (
            <ol className="relative flex flex-col">
              <li className="flex items-center gap-3 px-2 pb-3">
                <span className="flex size-7 items-center justify-center rounded-full bg-primary/12 text-primary">
                  <Sparkles className="size-3.5" />
                </span>
                <span className="text-[13px] font-medium">Current draft</span>
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">v{version}</span>
              </li>
              {list.map((row) => {
                const kind = KINDS[row.kind ?? "AUTOSAVE"] ?? KINDS.AUTOSAVE!;
                return (
                  <li key={row.id} className="group flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-muted/60">
                    <span className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border bg-background text-muted-foreground")}>{kind.icon}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[13px] font-medium">{row.label ?? `Version ${row.version}`}</span>
                        <Badge variant={kind.tone} className="px-1.5 py-0 text-[10px]">
                          {kind.label}
                        </Badge>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground" title={formatDateTime(row.createdAt)}>
                        {relativeTime(row.createdAt)}
                        {row.createdBy ? ` · ${row.createdBy.name ?? row.createdBy.email}` : ""} · v{row.version}
                      </p>
                    </div>
                    <Button size="sm" variant="outline" className="h-7 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100" onClick={() => setRestoring(row)}>
                      <RotateCcw /> Restore
                    </Button>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </SheetContent>
      <ConfirmDialog
        open={!!restoring}
        onOpenChange={(next) => !next && setRestoring(null)}
        title={`Restore ${restoring?.label ?? `version ${restoring?.version ?? ""}`}?`}
        description="It replaces the current draft. The current draft is saved as a version first, and nothing goes live until you publish."
        confirmLabel="Restore"
        loading={busy}
        onConfirm={() => restoring && void restore(restoring)}
      />
    </Sheet>
  );
};
