import {
  Building,
  FileIcon,
  Frame,
  LayoutPanelTop,
  MessageSquareQuote,
  Minus,
  SquareMousePointer,
  TriangleAlert,
  Accessibility,
  AlignCenter,
  AlignLeft,
  Aperture,
  AppWindow,
  ArrowRight,
  AtSign,
  Award,
  BadgeCheck,
  BadgePercent,
  Banknote,
  Bell,
  Blocks,
  Book,
  BookOpen,
  Bookmark,
  Box,
  Boxes,
  Braces,
  Calendar,
  CalendarDays,
  Camera,
  ChartColumn,
  ChartLine,
  ChartPie,
  Check,
  ChevronsUpDown,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CirclePlay,
  Clock,
  Code,
  Coins,
  Columns2,
  Columns3,
  Columns4,
  Compass,
  Component,
  Contact,
  Cookie,
  CreditCard,
  Crown,
  Download,
  Eye,
  FileText,
  Film,
  Filter,
  Flag,
  Flame,
  Folder,
  Footprints,
  GalleryVertical,
  GalleryHorizontal,
  GalleryThumbnails,
  Gem,
  Gift,
  Globe,
  Grid2x2,
  Grid3x3,
  Hand,
  Handshake,
  Hash,
  Heading,
  Heading1,
  Heading2,
  Heart,
  House,
  Image as ImageIcon,
  Images,
  Info,
  Layers,
  LayoutDashboard,
  LayoutGrid,
  LayoutList,
  LayoutTemplate,
  Leaf,
  Link,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Lock,
  Mail,
  Map as MapIcon,
  MapPin,
  Megaphone,
  Menu,
  MessageCircle,
  MessageSquare,
  MessagesSquare,
  Monitor,
  MonitorSmartphone,
  Moon,
  Mountain,
  MousePointerClick,
  Music,
  Navigation,
  Newspaper,
  Package,
  Palette,
  PanelBottom,
  PanelLeft,
  PanelRight,
  PanelTop,
  Percent,
  Phone,
  Pilcrow,
  Play,
  Puzzle,
  QrCode,
  Quote,
  Receipt,
  RectangleHorizontal,
  RectangleVertical,
  Recycle,
  RefreshCw,
  Rocket,
  Rows2,
  Rows3,
  Rss,
  Ruler,
  Search,
  Send,
  SeparatorHorizontal,
  Settings,
  Share2,
  Shield,
  ShieldCheck,
  Shirt,
  ShoppingBag,
  ShoppingBasket,
  ShoppingCart,
  SlidersHorizontal,
  Smartphone,
  Smile,
  Sparkles,
  Square,
  SquareCheck,
  SquareSplitHorizontal,
  SquareSplitVertical,
  Star,
  Store,
  Sun,
  Table,
  Tag,
  Tags,
  Target,
  Text as TextIcon,
  TextQuote,
  ThumbsUp,
  Ticket,
  Timer,
  ToggleRight,
  Trophy,
  Truck,
  Type,
  Umbrella,
  User,
  Users,
  Video,
  Wallet,
  Watch,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger, Tooltip } from "@/components/ui/overlay";
import { cn } from "@/lib/utils";
import type { ComponentKind } from "../model";

/**
 * Icons by Lucide name. A curated static map, as Lucide's dynamic loader adds a chunk per icon.
 * Other names show a generic glyph but are still saved, for frontends with their own map.
 */
const ICONS: [name: string, icon: LucideIcon, keywords?: string][] = [
  ["layout-template", LayoutTemplate, "page landing template"],
  ["layout-grid", LayoutGrid, "grid tiles cards"],
  ["layout-list", LayoutList, "list rows"],
  ["layout-dashboard", LayoutDashboard, "dashboard"],
  ["app-window", AppWindow, "window browser"],
  ["panel-top", PanelTop, "header top bar navigation"],
  ["panel-bottom", PanelBottom, "footer bottom"],
  ["panel-left", PanelLeft, "sidebar"],
  ["panel-right", PanelRight, "sidebar aside"],
  ["columns-2", Columns2, "two columns split"],
  ["columns-3", Columns3, "three columns"],
  ["columns-4", Columns4, "four columns"],
  ["rows-2", Rows2, "rows stack"],
  ["rows-3", Rows3, "rows stack list"],
  ["grid-2x2", Grid2x2, "grid"],
  ["grid-3x3", Grid3x3, "grid"],
  ["square", Square, "box block"],
  ["rectangle-horizontal", RectangleHorizontal, "banner block"],
  ["rectangle-vertical", RectangleVertical, "column block"],
  ["square-split-horizontal", SquareSplitHorizontal, "image text split"],
  ["square-split-vertical", SquareSplitVertical, "split"],
  ["separator-horizontal", SeparatorHorizontal, "divider spacer line"],
  ["ruler", Ruler, "spacing size"],
  ["layers", Layers, "stack"],
  ["blocks", Blocks, "blocks components"],
  ["component", Component, "component"],
  ["puzzle", Puzzle, "plugin widget"],
  ["box", Box, "box container"],
  ["type", Type, "text font"],
  ["text", TextIcon, "text paragraph"],
  ["heading", Heading, "title"],
  ["heading-1", Heading1, "title h1"],
  ["heading-2", Heading2, "title h2"],
  ["pilcrow", Pilcrow, "paragraph rich text"],
  ["text-quote", TextQuote, "quote blockquote"],
  ["quote", Quote, "testimonial review"],
  ["align-left", AlignLeft, "text"],
  ["align-center", AlignCenter, "text centered"],
  ["list", List, "list bullets"],
  ["list-ordered", ListOrdered, "steps numbered"],
  ["list-checks", ListChecks, "features benefits checklist"],
  ["table", Table, "table comparison specs"],
  ["image", ImageIcon, "photo picture"],
  ["images", Images, "gallery photos"],
  ["gallery-vertical", GalleryVertical, "gallery carousel"],
  ["gallery-horizontal", GalleryHorizontal, "carousel slider"],
  ["gallery-thumbnails", GalleryThumbnails, "gallery thumbnails"],
  ["camera", Camera, "photo"],
  ["aperture", Aperture, "lens photo"],
  ["film", Film, "movie video"],
  ["video", Video, "video camera"],
  ["play", Play, "video player"],
  ["circle-play", CirclePlay, "video player"],
  ["music", Music, "audio"],
  ["shopping-bag", ShoppingBag, "products commerce shop"],
  ["shopping-cart", ShoppingCart, "cart checkout"],
  ["shopping-basket", ShoppingBasket, "basket"],
  ["store", Store, "shop retail location"],
  ["package", Package, "product box"],
  ["boxes", Boxes, "products inventory"],
  ["tag", Tag, "price label"],
  ["tags", Tags, "labels categories"],
  ["badge-percent", BadgePercent, "sale discount offer"],
  ["percent", Percent, "discount sale"],
  ["receipt", Receipt, "order invoice"],
  ["credit-card", CreditCard, "payment"],
  ["wallet", Wallet, "payment"],
  ["coins", Coins, "money price"],
  ["banknote", Banknote, "money cash"],
  ["truck", Truck, "shipping delivery"],
  ["gift", Gift, "gift card present"],
  ["ticket", Ticket, "coupon voucher event"],
  ["award", Award, "badge prize"],
  ["trophy", Trophy, "winner best"],
  ["crown", Crown, "premium vip"],
  ["gem", Gem, "premium luxury"],
  ["star", Star, "rating favorite review"],
  ["sparkles", Sparkles, "new highlight magic"],
  ["flame", Flame, "hot trending"],
  ["zap", Zap, "fast flash"],
  ["rocket", Rocket, "launch new"],
  ["badge-check", BadgeCheck, "verified trust logos"],
  ["shield-check", ShieldCheck, "secure guarantee trust"],
  ["shield", Shield, "security"],
  ["lock", Lock, "secure private"],
  ["megaphone", Megaphone, "announcement promo banner"],
  ["bell", Bell, "notification alert"],
  ["mail", Mail, "newsletter email"],
  ["send", Send, "submit newsletter"],
  ["at-sign", AtSign, "email contact"],
  ["newspaper", Newspaper, "blog news articles"],
  ["rss", Rss, "feed blog"],
  ["message-square", MessageSquare, "comment chat"],
  ["message-circle", MessageCircle, "chat"],
  ["messages-square", MessagesSquare, "conversation faq"],
  ["circle-help", CircleHelp, "faq question help"],
  ["info", Info, "information notice"],
  ["circle-alert", CircleAlert, "warning notice"],
  ["circle-check", CircleCheck, "success done"],
  ["square-check", SquareCheck, "checkbox"],
  ["check", Check, "done"],
  ["mouse-pointer-click", MousePointerClick, "button cta click"],
  ["link", Link, "url"],
  ["link-2", Link2, "url"],
  ["arrow-right", ArrowRight, "next cta"],
  ["menu", Menu, "navigation hamburger"],
  ["navigation", Navigation, "direction"],
  ["compass", Compass, "explore"],
  ["map", MapIcon, "location"],
  ["map-pin", MapPin, "location store address"],
  ["globe", Globe, "world international language"],
  ["house", House, "home"],
  ["search", Search, "find"],
  ["filter", Filter, "facets"],
  ["sliders-horizontal", SlidersHorizontal, "settings filters"],
  ["settings", Settings, "configuration"],
  ["toggle-right", ToggleRight, "switch"],
  ["eye", Eye, "view preview"],
  ["user", User, "person account"],
  ["users", Users, "team people"],
  ["contact", Contact, "contact card"],
  ["smile", Smile, "happy"],
  ["heart", Heart, "love favorite wishlist"],
  ["thumbs-up", ThumbsUp, "like"],
  ["hand", Hand, "wave"],
  ["handshake", Handshake, "partners deal"],
  ["accessibility", Accessibility, "a11y"],
  ["calendar", Calendar, "date event"],
  ["calendar-days", CalendarDays, "date schedule"],
  ["clock", Clock, "time hours"],
  ["timer", Timer, "countdown"],
  ["hash", Hash, "number"],
  ["chart-column", ChartColumn, "stats bar chart"],
  ["chart-line", ChartLine, "stats graph"],
  ["chart-pie", ChartPie, "stats"],
  ["target", Target, "goal"],
  ["flag", Flag, "milestone"],
  ["file-text", FileText, "document page"],
  ["folder", Folder, "category"],
  ["book", Book, "guide"],
  ["book-open", BookOpen, "guide read"],
  ["bookmark", Bookmark, "save"],
  ["download", Download, "file"],
  ["share-2", Share2, "social share"],
  ["qr-code", QrCode, "scan"],
  ["phone", Phone, "call contact"],
  ["smartphone", Smartphone, "mobile app"],
  ["monitor", Monitor, "desktop screen"],
  ["monitor-smartphone", MonitorSmartphone, "responsive devices"],
  ["code", Code, "embed html"],
  ["braces", Braces, "json code"],
  ["palette", Palette, "color theme"],
  ["shirt", Shirt, "apparel clothing"],
  ["footprints", Footprints, "shoes"],
  ["watch", Watch, "accessories"],
  ["leaf", Leaf, "eco sustainable organic"],
  ["recycle", Recycle, "sustainable"],
  ["refresh-cw", RefreshCw, "returns exchange"],
  ["mountain", Mountain, "outdoor nature"],
  ["sun", Sun, "summer"],
  ["moon", Moon, "night dark"],
  ["umbrella", Umbrella, "weather protection"],
  ["cookie", Cookie, "consent"],
  ["building", Building, ""],
  ["circle-question-mark", CircleHelp, ""],
  ["file", FileIcon, ""],
  ["frame", Frame, ""],
  ["layout-panel-top", LayoutPanelTop, ""],
  ["message-square-quote", MessageSquareQuote, ""],
  ["minus", Minus, ""],
  ["square-mouse-pointer", SquareMousePointer, ""],
  ["triangle-alert", TriangleAlert, ""],
];

const BY_NAME = new Map(ICONS.map(([name, icon]) => [name, icon]));
/** Names Lucide renamed; definitions written against older names still get their icon. */
const ALIASES: Record<string, string> = { home: "house", "help-circle": "circle-help", "bar-chart": "chart-column", "check-circle": "circle-check", "alert-circle": "circle-alert", "play-circle": "circle-play", columns: "columns-2" };

/** "layoutTemplate", "Layout Template", "layout_template" → "layout-template". */
export const normalizeIconName = (name: string) =>
  name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();

const lookup = (name: string | null | undefined) => {
  if (!name) return undefined;
  const key = normalizeIconName(name);
  return BY_NAME.get(key) ?? BY_NAME.get(ALIASES[key] ?? "");
};

export const iconFor = (name: string | null | undefined, kind?: ComponentKind | null) => lookup(name) ?? (kind === "CONTENT_TYPE" ? LayoutTemplate : Component);

export const isKnownIcon = (name: string | null | undefined) => !!lookup(name);

export const ComponentIcon = ({ name, kind, className }: { name?: string | null; kind?: ComponentKind | null; className?: string }) => {
  const Icon = lookup(name) ?? (kind === "CONTENT_TYPE" ? LayoutTemplate : Component);
  return <Icon className={className} />;
};

export const IconTile = ({ name, kind, size = "md", className }: { name?: string | null; kind?: ComponentKind | null; size?: "sm" | "md" | "lg"; className?: string }) => (
  <span
    className={cn(
      "flex shrink-0 items-center justify-center rounded-lg",
      kind === "CONTENT_TYPE" ? "bg-info/12 text-info" : "bg-primary/10 text-primary",
      size === "sm" ? "size-7 [&_svg]:size-3.5" : size === "lg" ? "size-11 [&_svg]:size-5" : "size-9 [&_svg]:size-[18px]",
      className,
    )}
  >
    <ComponentIcon name={name} kind={kind} />
  </span>
);

const ICON_NAME = /^[a-z][a-z0-9-]{0,59}$/;

/** Enter picks the first match; any Lucide name can be typed. */
export const IconPicker = ({ value, onChange, disabled, invalid, id }: { value: string; onChange: (value: string) => void; disabled?: boolean; invalid?: boolean; id?: string }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const q = normalizeIconName(query);
  const results = useMemo(() => {
    if (!q) return ICONS;
    const words = q.split("-").filter(Boolean);
    return ICONS.filter(([name, , keywords]) => {
      const haystack = `${name} ${keywords ?? ""}`;
      return name.includes(q) || words.every((w) => haystack.includes(w));
    }).sort(([a], [b]) => Number(!a.startsWith(q)) - Number(!b.startsWith(q)) || a.length - b.length);
  }, [q]);
  const custom = q && ICON_NAME.test(q) && !BY_NAME.has(q) ? q : null;
  const pick = (name: string) => {
    onChange(name);
    setOpen(false);
    setQuery("");
  };
  return (
    <div className="flex items-center gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild disabled={disabled}>
          <button
            id={id}
            type="button"
            aria-invalid={invalid}
            className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-input bg-transparent pr-3 pl-1 text-left text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:opacity-50 aria-invalid:border-destructive dark:bg-input/30"
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted [&_svg]:size-4">
              <ComponentIcon name={value} />
            </span>
            <span className={cn("flex-1 truncate font-mono text-[13px]", !value && "font-sans text-muted-foreground")}>{value || "Choose an icon"}</span>
            <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[21rem] p-0">
          <div className="relative border-b p-2">
            <Search className="pointer-events-none absolute top-1/2 left-4.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                const first = results[0]?.[0] ?? custom;
                if (first) pick(first);
              }}
              placeholder="Search icons, e.g. cart, quote, video"
              aria-label="Search icons"
              className="h-8 pl-8"
            />
          </div>
          {results.length ? (
            <div className="grid max-h-72 grid-cols-8 gap-1 overflow-y-auto p-2">
              {results.map(([name, Icon]) => (
                <Tooltip key={name} content={name}>
                  <button
                    type="button"
                    aria-label={name}
                    onClick={() => pick(name)}
                    className={cn("flex aspect-square items-center justify-center rounded-md text-foreground/80 transition-colors hover:bg-accent hover:text-foreground", name === value && "bg-primary/10 text-primary ring-1 ring-primary/40")}
                  >
                    <Icon className="size-[18px]" />
                  </button>
                </Tooltip>
              ))}
            </div>
          ) : (
            <p className="px-3 pt-6 pb-2 text-center text-[13px] text-muted-foreground">No icon in the set matches “{query}”.</p>
          )}
          <div className="flex items-center justify-between gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
            {custom ? (
              <button type="button" className="truncate text-left hover:text-foreground" onClick={() => pick(custom)}>
                Use “<span className="font-mono">{custom}</span>” anyway
              </button>
            ) : (
              <span>{q ? `${results.length} match${results.length === 1 ? "" : "es"}` : `${ICONS.length} icons`}</span>
            )}
            <a href="https://lucide.dev/icons" target="_blank" rel="noreferrer" className="shrink-0 hover:text-foreground">
              lucide.dev ↗
            </a>
          </div>
        </PopoverContent>
      </Popover>
      {value && !disabled ? (
        <Button type="button" variant="ghost" size="icon-sm" onClick={() => onChange("")} aria-label="Remove icon">
          <X />
        </Button>
      ) : null}
    </div>
  );
};
