import type { ReactNode } from "react";
import { Alert, ApiError, Button } from "@havins/ui";

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-extrabold">{title}</h1>
        {description && <p className="mt-1 text-sm text-navy-500 dark:text-navy-300">{description}</p>}
      </div>
      {action}
    </div>
  );
}

/** Shown wherever the API answers 503 provider_not_configured. */
export function SetupRequired({ detail }: { detail?: string }) {
  return (
    <Alert tone="warning" title="Mail server setup required">
      The API is not connected to a mail server, so mailboxes, aliases and domains cannot be created yet. Set{" "}
      <code>MAIL_PROVIDER=stalwart</code>, <code>STALWART_URL</code> and the Stalwart admin secrets (see the
      deployment guide).
      {detail && <span className="mt-1 block text-xs opacity-80">{detail}</span>}
    </Alert>
  );
}

/** Error state for a failed load or action, with the API's own message. */
export function ErrorBlock({ error, onRetry }: { error: ApiError | Error; onRetry?: () => void }) {
  if (error instanceof ApiError && error.code === "provider_not_configured") return <SetupRequired />;
  if (error instanceof ApiError && error.code === "mfa_required") {
    return (
      <Alert tone="warning" title="Second factor required">
        {error.message}. Enrol a second factor for this account in Firebase Authentication, then sign out and
        back in.
      </Alert>
    );
  }
  return (
    <div className="space-y-3">
      <Alert tone="danger" title="Something went wrong">
        {error.message}
      </Alert>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export interface Domain {
  id: string;
  name: string;
  status: "active" | "provider_error";
  mailReady: boolean;
  records: DnsRecord[] | null;
  createdAt: number;
}

export interface DnsRecord {
  type: string;
  host: string;
  value: string;
  priority?: number;
  purpose: string;
}

export interface Mailbox {
  id: string;
  address: string;
  displayName: string;
  domainId: string;
  quotaMb: number | null;
  status: "provisioning" | "active" | "disabled" | "failed";
  lastError: string | null;
  lastLoginAt: number | null;
  createdAt: number;
}

export interface AliasRow {
  id: string;
  address: string;
  destinationMailboxId: string;
  destination: string;
}

export const tableClass = "w-full text-left text-sm";
export const thClass =
  "border-b border-navy-100 px-5 py-2.5 text-xs font-semibold uppercase tracking-wide text-navy-500 dark:border-white/10 dark:text-navy-400";
export const tdClass = "border-b border-navy-100/70 px-5 py-3 align-middle dark:border-white/5";
