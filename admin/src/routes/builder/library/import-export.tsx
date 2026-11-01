import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CircleCheck, FileUp, KeyRound, Terminal } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/controls";
import { Alert } from "@/components/ui/feedback";
import { Label, Textarea } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Sheet, SheetContent } from "@/components/ui/overlay";
import { MutationError, request, unwrap } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { parseDefinitionsJson } from "./definition";
import { ComponentsSync, invalidateMatching, type LibraryComponent } from "./queries";
import { CodeBlock, InlineCode } from "./ui";

type SyncResult = { created: string[]; updated: string[]; unchanged: string[]; removed: string[] };
type Problem = { where: string; message: string };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** ["definitions", "3", "fields", "0", "key"] → "hero (#4) › fields.title › key". */
const describeSyncPath = (path: readonly string[], definitions: readonly Record<string, unknown>[]) => {
  if (path[0] !== "definitions" || !/^\d+$/.test(path[1] ?? "")) return path.join(".") || "Definitions";
  const index = Number(path[1]);
  const definition = definitions[index];
  const parts = [typeof definition?.code === "string" && definition.code ? `${definition.code} (#${index + 1})` : `Definition #${index + 1}`];
  let scope: unknown = definition;
  for (let i = 2; i < path.length; i++) {
    const segment = path[i]!;
    const next = path[i + 1];
    if ((segment === "fields" || segment === "variations" || segment === "options") && next !== undefined && /^\d+$/.test(next)) {
      const list = isObject(scope) && Array.isArray(scope[segment]) ? (scope[segment] as unknown[]) : [];
      const entry = list[Number(next)];
      const name = isObject(entry) ? (entry.key ?? entry.code ?? entry.value) : undefined;
      parts.push(`${segment}.${typeof name === "string" && name ? name : `#${Number(next) + 1}`}`);
      scope = entry;
      i++;
    } else parts.push(segment);
  }
  return parts.join(" › ");
};

const ResultTile = ({ label, codes, tone }: { label: string; codes: string[]; tone: string }) => (
  <div className="rounded-lg border p-3">
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <span className={cn("text-xl font-semibold tabular", codes.length ? tone : "text-muted-foreground")}>{codes.length}</span>
    </div>
    {codes.length ? (
      <div className="mt-2 flex flex-wrap gap-1">
        {codes.slice(0, 12).map((code) => (
          <span key={code} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
            {code}
          </span>
        ))}
        {codes.length > 12 ? <span className="text-[11px] text-muted-foreground">+{codes.length - 12}</span> : null}
      </div>
    ) : null}
  </div>
);

/** Like `pnpm components push`: upserts by code; prune removes code-managed ones the file lacks. */
export const ImportDialog = ({ open, onOpenChange, library }: { open: boolean; onOpenChange: (open: boolean) => void; library: readonly LibraryComponent[] }) => {
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [prune, setPrune] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [failure, setFailure] = useState<{ message: string; problems: Problem[] } | null>(null);

  const parsed = useMemo(() => (text.trim() ? parseDefinitionsJson(text) : null), [text]);
  const definitions = parsed && "definitions" in parsed ? parsed.definitions : [];
  const codes = definitions.map((d) => (typeof d.code === "string" ? d.code : ""));
  const known = new Map(library.map((c) => [c.code ?? "", c]));
  const creating = codes.filter((c) => c && !known.has(c));
  const updating = codes.filter((c) => known.has(c));
  const takingOver = updating.filter((c) => known.get(c)?.source === "ADMIN");
  // Only from definitions that parsed: an unreadable file must not look like "remove everything".
  const removing = prune && definitions.length ? library.filter((c) => c.source === "CODE" && !codes.includes(c.code ?? "")) : [];

  const reset = () => {
    setText("");
    setFileName(null);
    setPrune(false);
    setResult(null);
    setFailure(null);
  };

  const submit = async () => {
    setPending(true);
    setFailure(null);
    try {
      const payload = unwrap((await request(ComponentsSync, { definitions, prune })).componentsSync);
      const outcome = { created: payload.created ?? [], updated: payload.updated ?? [], unchanged: payload.unchanged ?? [], removed: payload.removed ?? [] };
      setResult(outcome);
      toast.success(`Deployed ${definitions.length} definition${definitions.length === 1 ? "" : "s"}`);
      await invalidateMatching(queryClient, /component|library/i);
    } catch (error) {
      const problems = error instanceof MutationError ? error.fieldErrors.map((f) => ({ where: describeSyncPath(f.path, definitions), message: f.message })) : [];
      setFailure({ message: error instanceof Error ? error.message : "The import failed", problems });
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent wide aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{result ? "Import finished" : "Import component definitions"}</DialogTitle>
          {result ? null : (
            <DialogDescription>
              Paste or upload JSON as <InlineCode>pnpm components pull</InlineCode> writes it: an array of definitions, or <InlineCode>{'{ "components": [...] }'}</InlineCode>. Components are matched by code.
            </DialogDescription>
          )}
        </DialogHeader>

        {result ? (
          <>
            <div className="grid gap-2 sm:grid-cols-2">
              <ResultTile label="Created" codes={result.created} tone="text-success" />
              <ResultTile label="Updated" codes={result.updated} tone="text-info" />
              <ResultTile label="Unchanged" codes={result.unchanged} tone="text-foreground" />
              <ResultTile label="Removed" codes={result.removed} tone="text-destructive" />
            </div>
            <p className="text-[13px] text-muted-foreground">Imported components are marked as managed in code: the next push from a storefront's code overwrites them.</p>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={reset}>
                Import another file
              </Button>
              <Button type="button" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="import-json" className="text-[13px]">
                  Definitions JSON
                </Label>
                <div className="flex items-center gap-2">
                  {fileName ? <span className="max-w-48 truncate text-xs text-muted-foreground">{fileName}</span> : null}
                  <input
                    ref={fileInput}
                    type="file"
                    accept=".json,application/json"
                    className="hidden"
                    onChange={async (event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (!file) return;
                      setText(await file.text());
                      setFileName(file.name);
                      setFailure(null);
                    }}
                  />
                  <Button type="button" variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
                    <FileUp />
                    Upload file
                  </Button>
                </div>
              </div>
              <Textarea
                id="import-json"
                rows={11}
                spellCheck={false}
                className="font-mono text-xs leading-relaxed"
                value={text}
                aria-invalid={!!parsed && "error" in parsed}
                onChange={(e) => {
                  setText(e.target.value);
                  setFileName(null);
                  setFailure(null);
                }}
                placeholder={'[\n  {\n    "code": "hero",\n    "kind": "component",\n    "name": "Hero",\n    "fields": [{ "key": "title", "type": "text", "label": "Title", "localized": true }],\n    "variations": []\n  }\n]'}
              />
              {parsed && "error" in parsed ? (
                <p className="text-xs text-destructive">{parsed.error}</p>
              ) : definitions.length ? (
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <span>
                    {definitions.length} definition{definitions.length === 1 ? "" : "s"}:
                  </span>
                  <Badge variant="success">{creating.length} new</Badge>
                  <Badge variant="info">{updating.length} existing</Badge>
                  {codes.some((c) => !c) ? <Badge variant="destructive">{codes.filter((c) => !c).length} without a code</Badge> : null}
                </div>
              ) : null}
            </div>

            {takingOver.length ? (
              <Alert variant="info" title={`${takingOver.length} component${takingOver.length === 1 ? " was" : "s were"} last edited in the admin`}>
                {takingOver.join(", ")} will be replaced by the file and marked as managed in code.
              </Alert>
            ) : null}

            <Label className="items-start gap-3 rounded-lg border p-3 font-normal">
              <Checkbox checked={prune} onCheckedChange={(v) => setPrune(v === true)} className="mt-0.5" />
              <span className="flex flex-col gap-1">
                <span className="text-sm font-medium">Remove code-managed components missing from the file</span>
                <span className="text-xs text-muted-foreground">
                  Like <InlineCode>--prune</InlineCode>: deletes components marked Code that this file no longer defines. Refused, with nothing changed, while pages still use one. Components created in the admin are never removed.
                </span>
                {prune && definitions.length ? (
                  <span className={cn("text-xs", removing.length ? "text-destructive" : "text-muted-foreground")}>
                    {removing.length ? `Would remove ${removing.map((c) => c.code).join(", ")}.` : "Nothing would be removed."}
                  </span>
                ) : null}
              </span>
            </Label>

            {failure ? (
              <Alert variant="destructive" title={failure.problems.length ? `${failure.message} (${failure.problems.length} problem${failure.problems.length === 1 ? "" : "s"})` : failure.message}>
                {failure.problems.length ? (
                  <ul className="mt-1 max-h-48 space-y-1 overflow-y-auto">
                    {failure.problems.map((p, i) => (
                      <li key={i}>
                        <span className="font-mono text-[12px]">{p.where}</span>: {p.message}
                      </li>
                    ))}
                  </ul>
                ) : (
                  "Nothing was changed."
                )}
              </Alert>
            ) : null}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="button" loading={pending} disabled={!definitions.length} onClick={() => void submit()}>
                Import {definitions.length || ""} definition{definitions.length === 1 ? "" : "s"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};

const Step = ({ n, title, children, last }: { n: number; title: ReactNode; children: ReactNode; last?: boolean }) => (
  <li className={cn("relative flex gap-3", !last && "pb-6")}>
    {last ? null : <span className="absolute top-7 bottom-0 left-3 w-px bg-border" />}
    <span className="z-10 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{n}</span>
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <p className="text-sm font-medium">{title}</p>
      {children}
    </div>
  </li>
);

export const DeployFromCodePanel = ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) => {
  const { can } = useAuth();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:w-[40rem] sm:max-w-[40rem]" aria-describedby={undefined}>
        <div className="flex items-start gap-3 pr-6">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Terminal className="size-[18px]" />
          </span>
          <div>
            <h2 className="text-base font-semibold">Deploy components from code</h2>
            <p className="mt-1 text-[13px] text-muted-foreground">
              Keep definitions next to the storefront components that render them, review them in pull requests and deploy them with the components CLI.
            </p>
          </div>
        </div>

        <ol className="mt-2 flex flex-col">
          <Step n={1} title="Create an API key">
            <p className="text-[13px] text-muted-foreground">
              An admin API key with <InlineCode>content:read</InlineCode> to pull, and <InlineCode>content:write</InlineCode> to push.
            </p>
            {can("integrations:read") ? (
              <Button asChild variant="outline" size="sm" className="self-start">
                <Link to="/system/api-keys">
                  <KeyRound />
                  Open API keys
                </Link>
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">Ask an administrator for one (System › API keys).</p>
            )}
          </Step>
          <Step n={2} title="Pull the library into a file">
            <CodeBlock code="pnpm components pull --out components.json --url http://localhost:4000 --key <API key with content:read>" />
          </Step>
          <Step n={3} title="Edit the file and deploy it">
            <CodeBlock code="pnpm components push components.json --url http://localhost:4000 --key <API key with content:write>" />
            <p className="text-[13px] text-muted-foreground">
              Upserts by code and marks the components as managed in code. Add <InlineCode>--prune</InlineCode> to delete code-managed components the file no longer defines; that is refused while pages use them. All or nothing.
            </p>
          </Step>
          <Step n={4} last title="Generate TypeScript types for the storefront">
            <CodeBlock code="pnpm components types --from components.json --out ecom-components.ts" />
            <p className="text-[13px] text-muted-foreground">
              Types for content as the storefront API delivers it. Without <InlineCode>--from</InlineCode> it reads the library from the API (needs <InlineCode>--key</InlineCode>).
            </p>
          </Step>
        </ol>

        <div className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-4 text-[13px]">
          <p className="font-medium">Options</p>
          <ul className="flex flex-col gap-1.5 text-muted-foreground">
            <li>
              <InlineCode>--url</InlineCode> or <InlineCode>SPINDLE_API_URL</InlineCode>: the API, default <InlineCode>http://localhost:4000</InlineCode>.
            </li>
            <li>
              <InlineCode>--key</InlineCode> or <InlineCode>SPINDLE_API_KEY</InlineCode>: the admin API key. Put both in <InlineCode>.env</InlineCode> to drop the flags.
            </li>
            <li>
              <InlineCode>pnpm components</InlineCode> runs <InlineCode>node --env-file-if-exists=.env scripts/components.ts</InlineCode>.
            </li>
          </ul>
        </div>

        <Alert variant="warning" title="Code wins">
          Components deployed from code show a <strong>Code</strong> badge. Edits made here are overwritten by the next <InlineCode>pnpm components push</InlineCode>; change the file instead, or pull after editing here.
        </Alert>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CircleCheck className="size-3.5" />
          Import JSON on this screen runs the same deploy from a file in the browser.
        </p>
      </SheetContent>
    </Sheet>
  );
};

export const CodeManagedAlert = ({ className }: { className?: string }) => (
  <Alert variant="warning" title="Managed in code" className={className}>
    This component was deployed from a storefront's code. The next <InlineCode>pnpm components push</InlineCode> overwrites edits made here, so change the definition in the code too, or pull it after saving.
  </Alert>
);
