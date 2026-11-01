import { Link, Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { ChevronsUpDown, LogOut, Menu, Monitor, Moon, Search, Sun, User } from "lucide-react";
import { useEffect, useState } from "react";
import { BrandLogo } from "@/components/brand-logo";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/feedback";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, Select } from "@/components/ui/menu";
import { Sheet, SheetContent } from "@/components/ui/overlay";
import { useAuth } from "@/lib/auth";
import { useAdminCurrency } from "@/lib/hooks";
import { useRecordVisits } from "@/lib/nav-history";
import { setTheme, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { CommandPalette } from "./command-palette";
import { useNav } from "./nav";

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

const isActive = (pathname: string, to: string) => (to === "/" ? pathname === "/" : pathname === to || pathname.startsWith(`${to}/`));

const Sidebar = ({ onNavigate }: { onNavigate?: () => void }) => {
  const { can } = useAuth();
  const nav = useNav();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav className="flex flex-1 flex-col gap-5 overflow-y-auto px-3 pb-6">
      {nav.map((group) => {
        const items = group.items.filter((item) => can(item.permission));
        if (!items.length) return null;
        return (
          <div key={group.label || "home"} className="flex flex-col gap-0.5">
            {group.label ? <p className="px-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{group.label}</p> : null}
            {items.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                onClick={onNavigate}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent/70",
                  isActive(pathname, item.to) && "bg-sidebar-accent text-foreground",
                )}
              >
                <item.icon className={cn("size-4 text-muted-foreground", isActive(pathname, item.to) && "text-primary")} />
                {item.label}
              </Link>
            ))}
          </div>
        );
      })}
    </nav>
  );
};

const Brand = () => (
  <Link to="/" className="flex h-14 shrink-0 items-center gap-2.5 px-5" aria-label="SpindleCommerce admin home">
    <BrandLogo className="h-6" />
    <span className="rounded bg-background px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase ring-1 ring-border">Admin</span>
  </Link>
);

const UserMenu = () => {
  const { viewer, signOut } = useAuth();
  const theme = useTheme();
  const user = viewer?.staffUser;
  if (!user) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent" aria-label={`Account menu: ${user.name ?? user.email}`}>
          <span className="flex size-7 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary">{initials(user.name ?? user.email ?? "?")}</span>
          <span className="hidden flex-col leading-tight md:flex">
            <span className="text-[13px] font-medium">{user.name}</span>
            <span className="text-[11px] text-muted-foreground">{user.roles?.map((r) => r.name).join(", ")}</span>
          </span>
          <ChevronsUpDown className="hidden size-3.5 text-muted-foreground md:block" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        <DropdownMenuLabel className="font-normal">
          <span className="block font-medium text-foreground">{user.name}</span>
          <span className="block truncate">{user.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/account">
            <User />
            Account and security
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        {(
          [
            ["light", Sun, "Light"],
            ["dark", Moon, "Dark"],
            ["system", Monitor, "System"],
          ] as const
        ).map(([value, Icon, label]) => (
          <DropdownMenuItem key={value} onSelect={() => setTheme(value)} className={cn(theme === value && "bg-accent/60")}>
            <Icon />
            {label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** Send signed-out visitors to sign-in once, remembering where they were going. */
const useSignInRedirect = (status: ReturnType<typeof useAuth>["status"]) => {
  const router = useRouter();
  // Not <Navigate>: it fires again on each location change mid-redirect, nesting the URL in itself.
  useEffect(() => {
    const { pathname, href } = router.state.location;
    if (status === "signedOut" && pathname !== "/login") void router.navigate({ to: "/login", search: { redirect: href }, replace: true });
  }, [status, router]);
};

const Loading = () => (
  <div className="flex min-h-dvh items-center justify-center text-sm text-muted-foreground">
    <span className="mr-2 size-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    Loading…
  </div>
);

/** Signed-in layout without sidebar or header, for the visual page editor. */
export const FullScreenShell = () => {
  const { status } = useAuth();
  useSignInRedirect(status);
  if (status !== "signedIn") return <Loading />;
  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden">
      <Outlet />
    </div>
  );
};

/** The currency every page shows prices and figures in (useAdminCurrency). */
const CurrencySelect = () => {
  const admin = useAdminCurrency();
  if (admin.options.length < 2) return null;
  return <Select value={admin.key} onValueChange={admin.choose} options={admin.options} className="w-24" aria-label="Currency to show prices in" />;
};

/** Signed-in layout. Records each location it shows, so back links return to lists as left. */
export const AppShell = () => {
  const { status } = useAuth();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  useRecordVisits();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useSignInRedirect(status);
  if (status !== "signedIn") return <Loading />;

  return (
    <div className="flex min-h-dvh">
      <aside className="no-print sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r bg-sidebar lg:flex">
        <Brand />
        <Sidebar />
      </aside>
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent className="w-72 max-w-[80vw] gap-0 p-0 sm:w-72" aria-describedby={undefined}>
          <Brand />
          <Sidebar onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background/85 px-4 backdrop-blur sm:px-6">
          <Button variant="ghost" size="icon-sm" className="lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
            <Menu />
          </Button>
          <button
            onClick={() => setPaletteOpen(true)}
            className="flex h-9 w-full min-w-0 max-w-md items-center gap-2 rounded-md border bg-muted/40 px-3 text-[13px] text-muted-foreground transition-colors hover:bg-muted"
          >
            <Search className="size-4 shrink-0" />
            <span className="flex-1 truncate text-left">Search or jump to…</span>
            <Kbd className="hidden sm:inline-flex">⌘K</Kbd>
          </button>
          <div className="ml-auto flex items-center gap-2">
            <CurrencySelect />
            <UserMenu />
          </div>
        </header>
        <main className="flex-1">
          <Outlet />
        </main>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
};
