import {
  useEffect,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { AlertTriangle, Check, CheckCircle2, Copy, Info, Loader2, Moon, Sun, XCircle } from "lucide-react";

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

export function Logo({ className, withWordmark = true }: { className?: string; withWordmark?: boolean }) {
  const id = useId();
  return (
    <span className={cx("inline-flex items-center gap-2.5", className)}>
      <svg viewBox="0 0 32 32" className="size-8 shrink-0" aria-hidden="true">
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#0b1b46" />
            <stop offset="1" stopColor="#2f6bff" />
          </linearGradient>
        </defs>
        <rect width="32" height="32" rx="8" fill={`url(#${id})`} />
        <path
          d="M9 9v14M23 9v14M9 13l7 5 7-5"
          fill="none"
          stroke="#fff"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {withWordmark && (
        <span className="leading-none">
          <span className="block font-display text-[15px] font-extrabold tracking-[0.08em] text-navy-900 dark:text-white">
            HAVINS
          </span>
          <span className="block text-[10px] font-semibold tracking-[0.22em] text-navy-500 dark:text-navy-300">
            TECHNOLOGIES
          </span>
        </span>
      )}
    </span>
  );
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  variant = "primary",
  loading = false,
  size = "md",
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  loading?: boolean;
  size?: "sm" | "md";
}) {
  const styles: Record<ButtonVariant, string> = {
    primary:
      "bg-gradient-to-b from-brand-500 to-brand-600 text-white shadow-soft hover:from-brand-400 hover:to-brand-500 disabled:from-navy-300 disabled:to-navy-300 dark:disabled:from-navy-700 dark:disabled:to-navy-700",
    secondary:
      "border border-navy-200 bg-white/80 text-navy-800 hover:bg-white dark:border-white/15 dark:bg-white/5 dark:text-navy-100 dark:hover:bg-white/10",
    ghost: "text-navy-600 hover:bg-navy-100/70 dark:text-navy-200 dark:hover:bg-white/10",
    danger:
      "border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-400/30 dark:bg-red-500/10 dark:text-red-300",
  };
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-xl font-medium transition duration-150 disabled:cursor-not-allowed",
        size === "md" ? "h-10 px-4 text-sm" : "h-8 px-3 text-[13px]",
        styles[variant],
        className,
      )}
    >
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
      {children}
    </button>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("glass rounded-2xl", className)}>{children}</div>;
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-navy-100/80 px-5 py-4 dark:border-white/10">
      <div>
        <h2 className="text-base font-bold text-navy-900 dark:text-white">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-navy-500 dark:text-navy-300">{description}</p>}
      </div>
      {action}
    </div>
  );
}

const fieldBase =
  "h-10 w-full rounded-xl border border-navy-200 bg-white/90 px-3 text-sm text-navy-900 placeholder:text-navy-400 transition focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-500/15 dark:border-white/15 dark:bg-navy-950/60 dark:text-white aria-[invalid=true]:border-red-400";

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: (props: { id: string; "aria-invalid": boolean; "aria-describedby"?: string }) => ReactNode;
}) {
  const id = useId();
  const describedBy = error ? `${id}-err` : hint ? `${id}-hint` : undefined;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-navy-700 dark:text-navy-100">
        {label}
      </label>
      {children({ id, "aria-invalid": Boolean(error), "aria-describedby": describedBy })}
      {error ? (
        <p id={`${id}-err`} className="text-[13px] text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-[13px] text-navy-500 dark:text-navy-400">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cx(fieldBase, className)} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cx(fieldBase, "appearance-auto", className)}>
      {children}
    </select>
  );
}

type Tone = "neutral" | "success" | "warning" | "danger" | "info";

const toneStyles: Record<Tone, string> = {
  neutral: "bg-navy-100 text-navy-700 dark:bg-white/10 dark:text-navy-200",
  success: "bg-emerald-100 text-emerald-800 dark:bg-emerald-400/15 dark:text-emerald-300",
  warning: "bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300",
  danger: "bg-red-100 text-red-700 dark:bg-red-400/15 dark:text-red-300",
  info: "bg-brand-100 text-brand-700 dark:bg-brand-400/15 dark:text-brand-200",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold",
        toneStyles[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Alert({
  tone = "info",
  title,
  children,
}: {
  tone?: Exclude<Tone, "neutral">;
  title?: string;
  children?: ReactNode;
}) {
  const Icon = { success: CheckCircle2, warning: AlertTriangle, danger: XCircle, info: Info }[tone];
  const border = {
    success: "border-emerald-200 dark:border-emerald-400/25",
    warning: "border-amber-200 dark:border-amber-400/25",
    danger: "border-red-200 dark:border-red-400/25",
    info: "border-brand-200 dark:border-brand-400/25",
  }[tone];
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cx("flex gap-3 rounded-xl border p-3.5 text-sm", toneStyles[tone], border)}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="space-y-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className="opacity-90">{children}</div>}
      </div>
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div
      className="flex items-center justify-center gap-2 py-10 text-sm text-navy-500 dark:text-navy-300"
      role="status"
    >
      <Loader2 className="size-5 animate-spin" aria-hidden="true" />
      {label}…
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <div className="mb-3 grid size-12 place-items-center rounded-2xl bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-300">
        {icon}
      </div>
      <p className="font-display font-bold text-navy-900 dark:text-white">{title}</p>
      {children && <div className="mt-1 max-w-sm text-sm text-navy-500 dark:text-navy-300">{children}</div>}
    </div>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      aria-label={`${label}: ${value}`}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? "Copied" : label}
    </Button>
  );
}

const THEME_KEY = "havins-theme";

function applyTheme(theme: "light" | "dark" | "system") {
  const dark =
    theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function initTheme() {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(THEME_KEY);
  } catch {
    // storage unavailable: follow the system
  }
  applyTheme(stored === "light" || stored === "dark" ? stored : "system");
}

export function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    applyTheme(dark ? "dark" : "light");
  }, [dark]);
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={() => {
        const next = !dark;
        setDark(next);
        try {
          localStorage.setItem(THEME_KEY, next ? "dark" : "light");
        } catch {
          // ignore
        }
      }}
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}

export function formatDate(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(new Date(ms));
}

export function formatDateTime(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(ms));
}

/** Modal dialog built on <dialog>: focus trapping, Esc to close and backdrop come from the browser. */
export function Dialog({
  open,
  title,
  onClose,
  children,
  wide = false,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const [el, setEl] = useState<HTMLDialogElement | null>(null);
  useEffect(() => {
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [el, open]);
  return (
    <dialog
      ref={setEl}
      onClose={onClose}
      onClick={(e) => e.target === el && onClose()}
      className={cx(
        "m-auto w-[calc(100%-2rem)] rounded-2xl border border-navy-100 bg-white p-0 text-navy-900 shadow-lift backdrop:bg-navy-950/50 backdrop:backdrop-blur-sm dark:border-white/10 dark:bg-navy-900 dark:text-white",
        wide ? "max-w-2xl" : "max-w-md",
      )}
    >
      {open && (
        <div>
          <div className="flex items-center justify-between border-b border-navy-100 px-5 py-3.5 dark:border-white/10">
            <h2 className="text-base font-bold">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1 text-navy-500 hover:bg-navy-100 dark:text-navy-300 dark:hover:bg-white/10"
              aria-label="Close"
            >
              <XCircle className="size-5" aria-hidden="true" />
            </button>
          </div>
          <div className="p-5">{children}</div>
        </div>
      )}
    </dialog>
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
