import { z } from "zod";

export const addressSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  company: z.string().trim().max(200).optional().nullable(),
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional().nullable(),
  city: z.string().trim().min(1).max(100),
  region: z.string().trim().max(100).optional().nullable(),
  regionCode: z.string().trim().max(10).optional().nullable(),
  postalCode: z.string().trim().min(1).max(20),
  countryCode: z.string().trim().regex(/^[A-Z]{2}$/, "Use an ISO 3166-1 alpha-2 code"),
  phone: z.string().trim().max(40).optional().nullable(),
});

export type Address = z.infer<typeof addressSchema>;

/** A partly filled-in address: the country, and any of the other fields. */
export type AddressDraft = { [K in Exclude<keyof Address, "countryCode">]?: Address[K] | null } & Pick<Address, "countryCode">;

/** Required, besides the country, before an order can ship to the address. */
export const REQUIRED_ADDRESS_FIELDS = ["firstName", "lastName", "line1", "city", "postalCode"] as const;

const draftText = (max: number) => z.string().trim().max(max).nullish();

/** A cart's address as the shopper types it, within addressSchema's limits. Blank fields are dropped. */
export const addressDraftSchema = z
  .object({
    firstName: draftText(100),
    lastName: draftText(100),
    company: draftText(200),
    line1: draftText(200),
    line2: draftText(200),
    city: draftText(100),
    region: draftText(100),
    regionCode: draftText(10),
    postalCode: draftText(20),
    countryCode: addressSchema.shape.countryCode,
    phone: draftText(40),
  })
  .transform((draft) => Object.fromEntries(Object.entries(draft).filter(([, value]) => value !== null && value !== undefined && value !== "")) as AddressDraft);

/** The address if it is complete, else null. */
export const completeAddress = (draft: AddressDraft | null | undefined): Address | null => {
  const parsed = addressSchema.safeParse(draft);
  return parsed.success ? parsed.data : null;
};

export const missingAddressFields = (draft: AddressDraft | null | undefined) => REQUIRED_ADDRESS_FIELDS.filter((field) => !draft?.[field]);
