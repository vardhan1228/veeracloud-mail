import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { CheckCircle2, Info, XCircle } from "lucide-react";
import { cx } from "./components";

type ToastTone = "success" | "error" | "info";
interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
  action?: { label: string; run: () => void };
}

const ToastContext = createContext<((t: Omit<Toast, "id">) => void) | null>(null);

/** Small transient confirmations ("Message sent", "Moved to Archive · Undo"). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setToasts((all) => [...all.slice(-2), { ...t, id }]);
    setTimeout(() => setToasts((all) => all.filter((x) => x.id !== id)), t.action ? 6000 : 3500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4"
        aria-live="polite"
      >
        {toasts.map((t) => {
          const Icon = { success: CheckCircle2, error: XCircle, info: Info }[t.tone];
          return (
            <div
              key={t.id}
              role={t.tone === "error" ? "alert" : "status"}
              className="toast-in pointer-events-auto flex max-w-md items-center gap-3 rounded-xl bg-navy-900 px-4 py-2.5 text-sm text-white shadow-lift dark:bg-white dark:text-navy-900"
            >
              <Icon
                className={cx(
                  "size-4 shrink-0",
                  t.tone === "success"
                    ? "text-emerald-400 dark:text-emerald-600"
                    : t.tone === "error"
                      ? "text-red-400 dark:text-red-600"
                      : "text-brand-300 dark:text-brand-600",
                )}
                aria-hidden="true"
              />
              <span className="flex-1">{t.message}</span>
              {t.action && (
                <button
                  className="font-semibold text-brand-300 hover:underline dark:text-brand-600"
                  onClick={() => {
                    t.action!.run();
                    setToasts((all) => all.filter((x) => x.id !== t.id));
                  }}
                >
                  {t.action.label}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const push = useContext(ToastContext);
  return useMemo(
    () => ({
      success: (message: string, action?: Toast["action"]) => push?.({ tone: "success", message, action }),
      error: (message: string) => push?.({ tone: "error", message }),
      info: (message: string, action?: Toast["action"]) => push?.({ tone: "info", message, action }),
    }),
    [push],
  );
}

const AVATAR_COLORS = [
  "bg-brand-500",
  "bg-emerald-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-violet-500",
  "bg-cyan-600",
  "bg-orange-500",
  "bg-teal-600",
];

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Initials in a colour derived from the address, so each person is recognisable at a glance. */
export function Avatar({
  name,
  email,
  size = "md",
}: {
  name?: string | null;
  email: string;
  size?: "sm" | "md" | "lg";
}) {
  const label = (name || email.split("@")[0] || "?").trim();
  const parts = label.split(/[\s._-]+/).filter(Boolean);
  const initials = (
    (parts[0]?.[0] ?? "?") + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "")
  ).toUpperCase();
  return (
    <span
      aria-hidden="true"
      className={cx(
        "inline-grid shrink-0 place-items-center rounded-full font-semibold text-white",
        AVATAR_COLORS[hash(email.toLowerCase()) % AVATAR_COLORS.length],
        size === "sm" ? "size-7 text-[11px]" : size === "md" ? "size-9 text-xs" : "size-11 text-sm",
      )}
    >
      {initials}
    </span>
  );
}

/** Placeholder rows shown while a list loads. */
export function SkeletonRows({ rows = 6 }: { rows?: number }) {
  return (
    <div className="animate-pulse" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex gap-3 border-b border-navy-100/70 px-4 py-3.5 dark:border-white/5">
          <div className="size-9 rounded-full bg-navy-200/70 dark:bg-white/10" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-1/3 rounded bg-navy-200/70 dark:bg-white/10" />
            <div className="h-3 w-3/4 rounded bg-navy-200/60 dark:bg-white/10" />
            <div className="h-2.5 w-2/3 rounded bg-navy-100 dark:bg-white/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Keyboard shortcut chip, e.g. <Kbd>c</Kbd>. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-grid min-w-5 place-items-center rounded-md border border-navy-200 bg-white px-1.5 font-mono text-[11px] text-navy-600 shadow-[0_1px_0_rgb(0_0_0/0.08)] dark:border-white/15 dark:bg-white/5 dark:text-navy-200">
      {children}
    </kbd>
  );
}
