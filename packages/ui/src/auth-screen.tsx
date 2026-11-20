import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Alert, Button, Card, Field, Input, Logo, ThemeToggle } from "./components";

declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement,
        opts: { sitekey: string; callback: (t: string) => void; "expired-callback": () => void },
      ) => string;
    };
  }
}

const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;

/** Cloudflare Turnstile, only when a site key is configured. */
export function Turnstile({ onToken }: { onToken: (t: string | undefined) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!SITE_KEY || !ref.current) return;
    const el = ref.current;
    const render = () =>
      window.turnstile?.render(el, {
        sitekey: SITE_KEY,
        callback: onToken,
        "expired-callback": () => onToken(undefined),
      });
    if (window.turnstile) {
      render();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = render;
    document.head.appendChild(script);
  }, [onToken]);
  return SITE_KEY ? <div ref={ref} className="min-h-[65px]" /> : null;
}

export const turnstileEnabled = Boolean(SITE_KEY);

/**
 * Split-screen sign-in used by both apps. `onSubmit` performs the actual sign-in;
 * `onReset` (optional) sends a password reset for `email`.
 */
export function AuthScreen({
  heading,
  subheading,
  emailLabel = "Email",
  aside,
  onSubmit,
  onReset,
  footer,
}: {
  heading: string;
  subheading: string;
  emailLabel?: string;
  aside?: ReactNode;
  onSubmit: (email: string, password: string, turnstileToken: string | undefined) => Promise<void>;
  onReset?: (email: string) => Promise<void>;
  footer?: ReactNode;
}) {
  const [mode, setMode] = useState<"signin" | "reset">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "reset" && onReset) {
        await onReset(email.trim());
        setNotice("If an account exists for that email, a reset link is on its way.");
      } else {
        if (SITE_KEY && !token) throw new Error("Complete the security check first.");
        await onSubmit(email.trim(), password, token);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <div className="relative hidden overflow-hidden bg-navy-950 p-12 text-white lg:flex lg:flex-col">
        <div className="absolute inset-0 bg-[radial-gradient(800px_400px_at_20%_10%,rgb(47_107_255/0.35),transparent_60%),radial-gradient(600px_400px_at_90%_90%,rgb(91_139_255/0.18),transparent_60%)]" />
        <div className="relative [&_span]:!text-white">
          <Logo />
        </div>
        <div className="relative mt-auto max-w-md">{aside}</div>
      </div>

      <div className="flex flex-col px-4 py-6 sm:px-8">
        <div className="flex items-center justify-between lg:justify-end">
          <span className="lg:hidden">
            <Logo />
          </span>
          <ThemeToggle />
        </div>
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-10">
          <h1 className="text-2xl font-extrabold text-navy-900 dark:text-white">
            {mode === "reset" ? "Reset your password" : heading}
          </h1>
          <p className="mt-1.5 text-sm text-navy-500 dark:text-navy-300">
            {mode === "reset" ? "We'll email you a reset link." : subheading}
          </p>

          <Card className="mt-6 p-5">
            <form onSubmit={submit} className="space-y-4" noValidate>
              <Field label={emailLabel}>
                {(p) => (
                  <Input
                    {...p}
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="username"
                    required
                  />
                )}
              </Field>
              {mode === "signin" && (
                <Field label="Password">
                  {(p) => (
                    <Input
                      {...p}
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="current-password"
                      required
                    />
                  )}
                </Field>
              )}
              {mode === "signin" && <Turnstile onToken={setToken} />}
              {error && <Alert tone="danger">{error}</Alert>}
              {notice && <Alert tone="success">{notice}</Alert>}
              <Button type="submit" loading={busy} className="w-full">
                {mode === "reset" ? "Send reset link" : "Sign in"}
              </Button>
            </form>
          </Card>

          <div className="mt-4 text-sm">
            {onReset &&
              (mode === "signin" ? (
                <button
                  className="text-navy-500 hover:text-brand-600 dark:text-navy-300"
                  onClick={() => setMode("reset")}
                >
                  Forgot password?
                </button>
              ) : (
                <button
                  className="font-medium text-brand-600 dark:text-brand-300"
                  onClick={() => setMode("signin")}
                >
                  ← Back to sign in
                </button>
              ))}
            {footer}
          </div>
        </div>
      </div>
    </div>
  );
}
