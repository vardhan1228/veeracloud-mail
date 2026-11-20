import { AppError } from "../errors";
import type { Environment } from "../env";

const TURNSTILE_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export function createTurnstileVerifier(
  secret: string | undefined,
  environment: Environment,
  fetcher: typeof fetch = fetch,
) {
  return async (token: string | undefined, ip: string | null): Promise<void> => {
    if (!secret) {
      if (environment === "development") return;
      throw new AppError(503, "turnstile_not_configured", "Bot protection is not configured");
    }
    if (!token) throw new AppError(400, "turnstile_required", "Complete the security check");
    const form = new FormData();
    form.set("secret", secret);
    form.set("response", token);
    if (ip) form.set("remoteip", ip);
    const res = await fetcher(TURNSTILE_URL, { method: "POST", body: form });
    const body = (await res.json().catch(() => ({ success: false }))) as { success?: boolean };
    if (!res.ok || body.success !== true) {
      throw new AppError(400, "turnstile_failed", "The security check failed, please try again");
    }
  };
}
