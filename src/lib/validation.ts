import { z } from "zod";
import { ValidationError } from "./errors.ts";

/**
 * A schema for partial updates. Zod 4's `.partial()` still applies `.default()` values, so this
 * strips them: omitted means unchanged.
 */
export const patchSchema = <S extends z.ZodObject>(schema: S) =>
  z.object(
    Object.fromEntries(
      Object.entries(schema.shape).map(([key, field]) => {
        let inner = field as z.ZodType;
        while (inner instanceof z.ZodDefault) inner = inner.unwrap() as z.ZodType;
        return [key, inner.optional()];
      }),
    ),
  ) as unknown as z.ZodType<Partial<z.output<S>>, Partial<z.input<S>>>;

/** Throws a ValidationError with each issue's field path. */
export const parseInput = <S extends z.ZodType>(schema: S, input: unknown, basePath: string[] = ["input"]): z.output<S> => {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new ValidationError(
    "The input is invalid",
    result.error.issues.map((issue) => ({ path: [...basePath, ...issue.path.map(String)], message: issue.message })),
  );
};
