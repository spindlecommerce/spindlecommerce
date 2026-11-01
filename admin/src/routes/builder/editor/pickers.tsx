import { useQuery } from "@tanstack/react-query";
import { Check, FileText, Package, Search, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Combobox } from "@/components/ui/combobox";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlay";
import { request } from "@/lib/api";
import { useDebounced } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { useCategoryOptions } from "@/routes/catalog/shared";
import { PageSearchQuery, ProductSearchQuery, useReferenceNames } from "./api";

const triggerClass =
  "flex h-9 w-full min-w-0 items-center gap-2 rounded-md border border-input bg-transparent px-2.5 text-left text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 aria-invalid:border-destructive dark:bg-input/30";

export const Thumb = ({ src, className, fallback }: { src?: string | null; className?: string; fallback?: ReactNode }) => (
  <span className={cn("flex size-7 shrink-0 items-center justify-center overflow-hidden rounded border bg-muted text-muted-foreground", className)}>
    {src ? <img src={src} alt="" className="size-full object-cover" loading="lazy" /> : (fallback ?? <Package className="size-3.5" />)}
  </span>
);

const useProductSearch = (open: boolean, query: string) => {
  const q = useDebounced(query.trim(), 200);
  const search = useQuery({ queryKey: ["builder-product-search", q], queryFn: () => request(ProductSearchQuery, { query: q || null }), enabled: open, staleTime: 30_000 });
  return {
    loading: search.isFetching,
    results: (search.data?.products?.edges ?? []).flatMap((e) => (e?.node ? [{ id: e.node.id, name: e.node.name ?? "Untitled product", status: e.node.status, image: (e.node.media ?? []).find((m) => m.kind !== "VIDEO")?.url ?? null }] : [])),
  };
};

export const ProductSearchPopover = ({ children, selected = [], onPick, closeOnPick = true, disabled }: { children: ReactNode; selected?: readonly string[]; onPick: (id: string) => void; closeOnPick?: boolean; disabled?: boolean }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { results, loading } = useProductSearch(open, query);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        {children}
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search products by name or SKU…" value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>{loading ? "Searching…" : "No products found."}</CommandEmpty>
            <CommandGroup>
              {results.map((p) => (
                <CommandItem
                  key={p.id}
                  value={p.id}
                  onSelect={() => {
                    onPick(p.id);
                    if (closeOnPick) setOpen(false);
                  }}
                >
                  <Thumb src={p.image} />
                  <span className="flex-1 truncate">{p.name}</span>
                  {p.status && p.status !== "ACTIVE" ? <span className="text-[11px] text-muted-foreground lowercase">{p.status}</span> : null}
                  <Check className={cn("size-4", selected.includes(p.id) ? "opacity-100" : "opacity-0")} />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};

export const ProductPicker = ({ value, onChange, invalid, id }: { value: string | null; onChange: (id: string | null) => void; invalid?: boolean; id?: string }) => {
  const { names } = useReferenceNames(value ? [value] : []);
  const current = value ? names.get(value) : undefined;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <ProductSearchPopover selected={value ? [value] : []} onPick={(picked) => onChange(picked)}>
        <button type="button" id={id} className={triggerClass} aria-invalid={invalid || undefined}>
          {value ? <Thumb src={current?.image} className="size-6" /> : <Search className="size-4 text-muted-foreground" />}
          <span className={cn("flex-1 truncate", !value && "text-muted-foreground", current?.missing && "text-destructive")}>{value ? (current?.label ?? "Loading…") : "Choose a product"}</span>
        </button>
      </ProductSearchPopover>
      {value ? <ClearButton onClick={() => onChange(null)} label="Clear product" /> : null}
    </div>
  );
};

export const ClearButton = ({ onClick, label }: { onClick: () => void; label: string }) => (
  <button type="button" onClick={onClick} aria-label={label} title={label} className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
    <X className="size-4" />
  </button>
);

export const PagePicker = ({ value, onChange, invalid, id, excludeId }: { value: string | null; onChange: (id: string | null) => void; invalid?: boolean; id?: string; excludeId?: string }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim(), 200);
  const search = useQuery({ queryKey: ["builder-page-search", q], queryFn: () => request(PageSearchQuery, { query: q || null }), enabled: open, staleTime: 30_000 });
  const { names } = useReferenceNames(value ? [value] : []);
  const current = value ? names.get(value) : undefined;
  // Only pages with a path can be linked to (not the header or footer).
  const results = (search.data?.pages?.edges ?? []).flatMap((e) => (e?.node && e.node.path && e.node.id !== excludeId ? [e.node] : []));
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" id={id} className={triggerClass} aria-invalid={invalid || undefined}>
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            <span className={cn("flex-1 truncate", !value && "text-muted-foreground", current?.missing && "text-destructive")}>{value ? (current?.label ?? "Loading…") : "Choose a page"}</span>
            {current?.hint ? <span className="truncate font-mono text-[11px] text-muted-foreground">{current.hint}</span> : null}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput placeholder="Search pages by title or path…" value={query} onValueChange={setQuery} />
            <CommandList>
              <CommandEmpty>{search.isFetching ? "Searching…" : "No pages found."}</CommandEmpty>
              <CommandGroup>
                {results.map((p) => (
                  <CommandItem
                    key={p.id}
                    value={p.id}
                    onSelect={() => {
                      onChange(p.id);
                      setOpen(false);
                    }}
                  >
                    <FileText />
                    <span className="flex-1 truncate">{p.title || "Untitled"}</span>
                    <span className="truncate font-mono text-[11px] text-muted-foreground">{p.path}</span>
                    <Check className={cn("size-4", p.id === value ? "opacity-100" : "opacity-0")} />
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {value ? <ClearButton onClick={() => onChange(null)} label="Clear page" /> : null}
    </div>
  );
};

/** One category, labelled with its breadcrumb. */
export const CategoryPicker = ({ value, onChange, className, placeholder = "Choose a category" }: { value: string | null; onChange: (id: string | null) => void; className?: string; placeholder?: string }) => {
  const { options, isLoading } = useCategoryOptions();
  return (
    <Combobox
      options={options}
      // Until the names load, a placeholder rather than the raw id.
      value={isLoading ? "" : (value ?? "")}
      onChange={(v) => onChange(v || null)}
      placeholder={isLoading ? "Loading categories…" : placeholder}
      clearable
      className={cn("min-w-0 flex-1", className)}
    />
  );
};
