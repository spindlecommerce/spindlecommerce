import { setting, type PluginContext } from "../../src/plugins/sdk.ts";

/**
 * None are required, since the default `log` transport needs nothing. A provider's key and sender
 * are checked when sending and by "Test connection".
 */
export const settings = {
  transport: setting.select({
    label: "Transport",
    description: "Log only records emails in the message log without sending them, for development and previews.",
    options: [
      { value: "log", label: "Log only (send nothing)" },
      { value: "resend", label: "Resend" },
      { value: "postmark", label: "Postmark" },
    ],
    default: "log",
  }),
  resendApiKey: setting.secret({ label: "Resend API key", description: "For the Resend transport (re_…).", env: "RESEND_API_KEY" }),
  postmarkServerToken: setting.secret({ label: "Postmark server token", description: "For the Postmark transport (Servers › API Tokens).", env: "POSTMARK_SERVER_TOKEN" }),
  from: setting.string({
    label: "From",
    placeholder: "Shop <orders@example.com>",
    description: "Sender name and address, on a domain verified with your provider. Required to send.",
  }),
  replyTo: setting.string({ label: "Reply-to", placeholder: "help@example.com", description: "Where replies go. Order emails invite customers to reply when it is set." }),
  storeName: setting.string({ label: "Store name", description: "Shown in emails. Defaults to the channel's name." }),
  logoUrl: setting.string({ label: "Logo URL", placeholder: "https://example.com/logo.png", description: "An https image shown 40 px high above each email." }),
  accentColor: setting.string({ label: "Accent color", placeholder: "#111827", description: "Hex color of buttons and the header rule." }),
  customerResetUrl: setting.string({
    label: "Customer password reset link",
    placeholder: "https://shop.example.com/account/reset-password?token={token}",
    description: "{token} and {email} are filled in. Defaults to the storefront URL of the default channel + /account/reset-password?token={token}.",
  }),
  staffOrderNotifications: setting.string({
    label: "New order notifications",
    placeholder: "orders@example.com, ops@example.com",
    description: "Comma-separated staff addresses told about every new order.",
  }),
  lowStockThreshold: setting.number({
    label: "Low stock threshold",
    min: 0,
    integer: true,
    description: "Alert when the on-hand quantity of a variant at a location drops to this or below after a stock change.",
  }),
  lowStockRecipients: setting.string({ label: "Low stock recipients", placeholder: "purchasing@example.com", description: "Comma-separated addresses for low stock alerts." }),
};

export type EmailSettings = typeof settings;
export type EmailContext = PluginContext<EmailSettings>;

/** Settings arrive as typed; empty strings mean unset. */
export const value = (input: string | null | undefined): string | null => (input?.trim() ? input.trim() : null);

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/** Addresses separated by commas, semicolons or spaces, deduplicated; invalid ones are dropped. */
export const parseAddresses = (input: string | null | undefined): string[] => [
  ...new Set(
    (input ?? "")
      .split(/[\s,;]+/)
      .map((a) => a.trim().toLowerCase())
      .filter((a) => EMAIL.test(a)),
  ),
];

/** The bare address of `Name <address>` or `address`. */
export const addressOf = (mailbox: string): string | null => {
  const address = (/<([^<>]+)>\s*$/.exec(mailbox)?.[1] ?? mailbox).trim();
  return EMAIL.test(address) ? address : null;
};
