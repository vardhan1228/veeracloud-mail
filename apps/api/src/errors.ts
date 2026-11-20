import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

/** Error with a stable machine-readable code that the frontends switch on. */
export class AppError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (what = "Resource") => new AppError(404, "not_found", `${what} not found`);
export const forbidden = (message = "You do not have permission to do this") =>
  new AppError(403, "forbidden", message);
export const unauthorized = () => new AppError(401, "unauthenticated", "Sign in to continue");
export const conflict = (code: string, message: string) => new AppError(409, code, message);

/** Validates untrusted input, turning Zod failures into a 400 with field-level issues. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError(400, "validation_failed", "Some fields are invalid", z.flattenError(result.error));
  }
  return result.data;
}
