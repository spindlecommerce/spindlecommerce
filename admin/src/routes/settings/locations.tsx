import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, MapPin, Plus, X } from "lucide-react";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { Field, reportError } from "@/components/form";
import { Page, PageHeader } from "@/components/layout/page";
import { BooleanBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Switch } from "@/components/ui/controls";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Input, Label, NativeSelect } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/overlay";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErrorFields, graphql, type ResultOf } from "@/graphql/graphql";
import { request, unwrap } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { COUNTRY_CODES, countryName } from "@/lib/format";
import { useAction } from "@/lib/hooks";
import { RowActions, SettingsCard } from "./shared";

const LocationsQuery = graphql(`
  query SettingsLocations {
    stockLocations {
      id
      code
      name
      city
      postalCode
      countryCode
      isActive
    }
    stocks {
      id
      code
      name
      locations {
        id
        name
      }
    }
  }
`);

const ChannelStocksQuery = graphql(`
  query LocationChannels {
    channels {
      id
      name
      stock {
        id
      }
    }
  }
`);

type Data = ResultOf<typeof LocationsQuery>;
type Location = NonNullable<Data["stockLocations"]>[number];
type Stock = NonNullable<Data["stocks"]>[number];

const LocationCreate = graphql(`mutation LocationCreate($input: StockLocationInput!) { stockLocationCreate(input: $input) { __typename ...ErrorFields } }`, [ErrorFields]);
const LocationUpdate = graphql(`mutation LocationUpdate($id: ID!, $input: StockLocationUpdateInput!) { stockLocationUpdate(id: $id, input: $input) { __typename ...ErrorFields } }`, [ErrorFields]);
const StockCreate = graphql(`mutation StockCreate($input: StockInput!) { stockCreate(input: $input) { __typename ...ErrorFields } }`, [ErrorFields]);
const StockUpdate = graphql(`mutation StockUpdate($id: ID!, $input: StockUpdateInput!) { stockUpdate(id: $id, input: $input) { __typename ...ErrorFields } }`, [ErrorFields]);

const COUNTRY_OPTIONS = COUNTRY_CODES.map((code) => ({ value: code, label: countryName(code), hint: code })).sort((a, b) => a.label.localeCompare(b.label));
const INVALIDATE = [["settings-locations"], ["reference"], ["location-channels"], ["channel-stocks"]];

export const LocationsPage = () => {
  const { can } = useAuth();
  const query = useQuery({ queryKey: ["settings-locations"], queryFn: () => request(LocationsQuery) });
  const channels = useQuery({ queryKey: ["location-channels"], queryFn: () => request(ChannelStocksQuery), enabled: can("settings:read") });
  const [location, setLocation] = useState<Location | "new" | null>(null);
  const [stock, setStock] = useState<Stock | "new" | null>(null);
  const write = can("inventory:write");
  const locations = query.data?.stockLocations ?? [];
  const stocks = query.data?.stocks ?? [];

  return (
    <Page>
      <PageHeader title="Stock locations" description="Locations hold on-hand stock. A stock groups locations in sourcing order; each channel sells from one stock and reserves against it." />
      {query.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <div className="flex flex-col gap-6">
          <SettingsCard
            title="Locations"
            description="Warehouses, stores or suppliers that ship orders."
            action={
              write ? (
                <Button size="sm" onClick={() => setLocation("new")}>
                  <Plus />
                  Add location
                </Button>
              ) : null
            }
          >
            {locations.length === 0 ? (
              <EmptyState icon={MapPin} title="No locations" description="Add a location before tracking stock." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Location</TableHead>
                    <TableHead>Address</TableHead>
                    <TableHead>In stocks</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-20" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {locations.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell>
                        <span className="font-medium">{l.name}</span>
                        <p className="font-mono text-xs text-muted-foreground">{l.code}</p>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{[l.postalCode, l.city, l.countryCode ? countryName(l.countryCode) : null].filter(Boolean).join(" ") || "—"}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {stocks
                          .filter((s) => (s.locations ?? []).some((x) => x.id === l.id))
                          .map((s) => s.name)
                          .join(", ") || "None"}
                      </TableCell>
                      <TableCell>
                        <BooleanBadge value={l.isActive} />
                      </TableCell>
                      <TableCell>{write ? <RowActions onEdit={() => setLocation(l)} /> : null}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </SettingsCard>

          <SettingsCard
            title="Stocks"
            description="Fulfillment ships from the first location in the list unless staff choose another."
            action={
              write ? (
                <Button size="sm" onClick={() => setStock("new")} disabled={locations.length === 0}>
                  <Plus />
                  Add stock
                </Button>
              ) : null
            }
          >
            {stocks.length === 0 ? (
              <EmptyState title="No stocks" description="Channels without a stock do not reserve inventory." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Stock</TableHead>
                    <TableHead>Locations (in sourcing order)</TableHead>
                    <TableHead>Used by channels</TableHead>
                    <TableHead className="w-20" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stocks.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell>
                        <span className="font-medium">{s.name}</span>
                        <p className="font-mono text-xs text-muted-foreground">{s.code}</p>
                      </TableCell>
                      <TableCell>
                        <ol className="flex flex-wrap gap-1.5 text-[13px]">
                          {(s.locations ?? []).map((l, i) => (
                            <li key={l.id} className="rounded-md bg-muted px-1.5 py-0.5">
                              <span className="text-muted-foreground">{i + 1}.</span> {l.name}
                            </li>
                          ))}
                          {(s.locations ?? []).length === 0 ? <li className="text-muted-foreground">No locations</li> : null}
                        </ol>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {channels.data
                          ? (channels.data.channels ?? [])
                              .filter((c) => c.stock?.id === s.id)
                              .map((c) => c.name)
                              .join(", ") || "None"
                          : "—"}
                      </TableCell>
                      <TableCell>{write ? <RowActions onEdit={() => setStock(s)} /> : null}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </SettingsCard>
        </div>
      )}
      {location !== null ? <LocationDialog key={location === "new" ? "new" : location.id} location={location === "new" ? null : location} onClose={() => setLocation(null)} /> : null}
      {stock !== null ? <StockDialog key={stock === "new" ? "new" : stock.id} stock={stock === "new" ? null : stock} locations={locations} onClose={() => setStock(null)} /> : null}
    </Page>
  );
};

type LocationForm = { code: string; name: string; city: string; postalCode: string; countryCode: string; isActive: boolean };

const LocationDialog = ({ location, onClose }: { location: Location | null; onClose: () => void }) => {
  const form = useForm<LocationForm>({
    defaultValues: { code: location?.code ?? "", name: location?.name ?? "", city: location?.city ?? "", postalCode: location?.postalCode ?? "", countryCode: location?.countryCode ?? "", isActive: location?.isActive ?? true },
  });
  const save = useAction(
    async (v: LocationForm) => {
      const common = { name: v.name.trim(), city: v.city.trim() || null, postalCode: v.postalCode.trim() || null, countryCode: v.countryCode || null, isActive: v.isActive };
      if (location) return unwrap((await request(LocationUpdate, { id: location.id, input: common })).stockLocationUpdate);
      return unwrap((await request(LocationCreate, { input: { ...common, code: v.code.trim() } })).stockLocationCreate);
    },
    { success: location ? "Location saved" : "Location created", invalidate: INVALIDATE, onSuccess: onClose, onError: (error) => reportError(error, form) },
  );
  const errors = form.formState.errors;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent dirty={form.formState.isDirty}>
        <DialogHeader>
          <DialogTitle>{location ? `Edit ${location.name}` : "New stock location"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-4 sm:grid-cols-2">
          <Field label="Code" required hint={location ? "Fixed once created." : "e.g. us-east"} error={errors.code?.message}>
            <Input disabled={!!location} className="font-mono" {...form.register("code", { required: !location && "Required" })} />
          </Field>
          <Field label="Name" required error={errors.name?.message}>
            <Input placeholder="Newark warehouse" {...form.register("name", { required: "Required" })} />
          </Field>
          <Field label="City">
            <Input {...form.register("city")} />
          </Field>
          <Field label="Postal code">
            <Input {...form.register("postalCode")} />
          </Field>
          <Field label="Country" className="sm:col-span-2">
            <Controller control={form.control} name="countryCode" render={({ field }) => <Combobox options={COUNTRY_OPTIONS} value={field.value} onChange={field.onChange} placeholder="Pick a country" clearable />} />
          </Field>
          <Label className="font-normal sm:col-span-2">
            <Controller control={form.control} name="isActive" render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />} />
            Active — inactive locations keep their stock but are not used for new shipments
          </Label>
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              {location ? "Save location" : "Create location"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

const StockDialog = ({ stock, locations, onClose }: { stock: Stock | null; locations: Location[]; onClose: () => void }) => {
  const [code, setCode] = useState(stock?.code ?? "");
  const [name, setName] = useState(stock?.name ?? "");
  const initial = (stock?.locations ?? []).map((l) => l.id);
  const [ordered, setOrdered] = useState<string[]>(initial);
  const [adding, setAdding] = useState("");
  const dirty = code !== (stock?.code ?? "") || name !== (stock?.name ?? "") || ordered.join() !== initial.join() || !!adding;
  const save = useAction(
    async () => {
      if (stock) return unwrap((await request(StockUpdate, { id: stock.id, input: { name: name.trim(), locationIds: ordered } })).stockUpdate);
      return unwrap((await request(StockCreate, { input: { code: code.trim(), name: name.trim(), locationIds: ordered } })).stockCreate);
    },
    { success: stock ? "Stock saved" : "Stock created", invalidate: INVALIDATE, onSuccess: onClose },
  );
  const move = (index: number, delta: number) =>
    setOrdered((list) => {
      const next = [...list];
      const [item] = next.splice(index, 1);
      next.splice(index + delta, 0, item!);
      return next;
    });
  const available = locations.filter((l) => !ordered.includes(l.id));
  const nameOf = (id: string) => locations.find((l) => l.id === id)?.name ?? id;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent dirty={dirty}>
        <DialogHeader>
          <DialogTitle>{stock ? `Edit ${stock.name}` : "New stock"}</DialogTitle>
          <DialogDescription>Locations are used in this order when an order ships without a chosen location.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(undefined);
          }}
          className="grid gap-4"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Code" required hint={stock ? "Fixed once created." : "e.g. us"}>
              <Input disabled={!!stock} className="font-mono" value={code} onChange={(e) => setCode(e.target.value)} required={!stock} />
            </Field>
            <Field label="Name" required>
              <Input value={name} onChange={(e) => setName(e.target.value)} required />
            </Field>
          </div>
          <Field label="Locations">
            <ol className="flex flex-col gap-1.5">
              {ordered.map((id, i) => (
                <li key={id} className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-[13px]">
                  <span className="w-5 text-muted-foreground">{i + 1}.</span>
                  <span className="flex-1">{nameOf(id)}</span>
                  <Button type="button" variant="ghost" size="icon-sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                    <ArrowUp />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-sm" disabled={i === ordered.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
                    <ArrowDown />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-sm" onClick={() => setOrdered(ordered.filter((x) => x !== id))} aria-label="Remove location">
                    <X />
                  </Button>
                </li>
              ))}
              {ordered.length === 0 ? <li className="text-[13px] text-muted-foreground">No locations yet.</li> : null}
            </ol>
          </Field>
          {available.length ? (
            <div className="flex gap-2">
              <NativeSelect value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="Location to add">
                <option value="">Add a location…</option>
                {available.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </NativeSelect>
              <Button
                type="button"
                variant="outline"
                disabled={!adding}
                onClick={() => {
                  setOrdered([...ordered, adding]);
                  setAdding("");
                }}
              >
                <Plus />
                Add
              </Button>
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending} disabled={!name.trim() || (!stock && !code.trim())}>
              {stock ? "Save stock" : "Create stock"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
