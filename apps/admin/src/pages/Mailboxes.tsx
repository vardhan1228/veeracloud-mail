import { useMemo, useState, type FormEvent } from "react";
import { KeyRound, Pencil, Plus, Power, Search, Trash2, Users, Wand2 } from "lucide-react";
import {
  Alert,
  ApiError,
  Badge,
  Button,
  Card,
  CopyButton,
  Dialog,
  EmptyState,
  Field,
  Input,
  Select,
  Spinner,
  api,
  fieldError,
  formatDateTime,
  useApi,
} from "@havins/ui";
import { ErrorBlock, PageHeader, tableClass, tdClass, thClass, type Domain, type Mailbox } from "../shared";

/** 16 characters from an unambiguous alphabet, generated in the browser and shown once. */
function generatePassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

const STATUS_TONE = {
  active: "success",
  disabled: "neutral",
  provisioning: "info",
  failed: "danger",
} as const;

export function Mailboxes() {
  const list = useApi<{ mailboxes: Mailbox[] }>("/admin/mailboxes");
  const domains = useApi<{ domains: Domain[] }>("/admin/domains");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Mailbox | null>(null);
  const [resetting, setResetting] = useState<Mailbox | null>(null);
  const [credentials, setCredentials] = useState<{ address: string; password: string } | null>(null);
  const [rowError, setRowError] = useState<ApiError | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = list.data?.mailboxes ?? [];
    return q ? all.filter((m) => m.address.includes(q) || m.displayName.toLowerCase().includes(q)) : all;
  }, [list.data, query]);
  const readyDomains = (domains.data?.domains ?? []).filter((d) => d.mailReady);

  async function rowAction(m: Mailbox, kind: "toggle" | "delete") {
    if (
      kind === "delete" &&
      !confirm(`Delete ${m.address}? All of its mail is permanently deleted from the server.`)
    )
      return;
    if (
      kind === "toggle" &&
      m.status === "active" &&
      !confirm(`Disable ${m.address}? The employee is signed out everywhere.`)
    )
      return;
    setBusyId(m.id);
    setRowError(null);
    try {
      if (kind === "delete") await api(`/admin/mailboxes/${m.id}`, { method: "DELETE" });
      else
        await api(`/admin/mailboxes/${m.id}`, { method: "PATCH", body: { enabled: m.status !== "active" } });
      list.reload();
    } catch (err) {
      setRowError(err as ApiError);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Employees"
        description="One mailbox per employee. They sign in to webmail with the address and password you set."
        action={
          <Button onClick={() => setCreating(true)} disabled={domains.loading}>
            <Plus className="size-4" /> New mailbox
          </Button>
        }
      />

      {credentials && (
        <div className="mb-4">
          <Alert tone="success" title={`Password set for ${credentials.address}`}>
            <p>Give these details to the employee privately. The password is not shown again.</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <code className="rounded-lg bg-white/70 px-2 py-1 font-mono dark:bg-black/30">
                {credentials.password}
              </code>
              <CopyButton value={credentials.password} label="Copy password" />
              <Button size="sm" variant="ghost" onClick={() => setCredentials(null)}>
                Dismiss
              </Button>
            </div>
          </Alert>
        </div>
      )}
      {rowError && (
        <div className="mb-4">
          <ErrorBlock error={rowError} />
        </div>
      )}

      <Card>
        <div className="border-b border-navy-100 p-3 dark:border-white/10">
          <label className="relative block max-w-sm">
            <span className="sr-only">Search mailboxes</span>
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-navy-400" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or address"
              className="pl-9"
            />
          </label>
        </div>

        {list.loading && !list.data ? (
          <Spinner />
        ) : list.error ? (
          <div className="p-5">
            <ErrorBlock error={list.error} onRetry={list.reload} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={<Users className="size-5" />} title={query ? "No matches" : "No mailboxes yet"}>
            {query ? "Try a different search." : "Create a mailbox for each employee or shared inbox."}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th className={thClass}>Employee</th>
                  <th className={thClass}>Status</th>
                  <th className={`${thClass} hidden md:table-cell`}>Quota</th>
                  <th className={`${thClass} hidden md:table-cell`}>Last webmail sign-in</th>
                  <th className={thClass}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.id}>
                    <td className={tdClass}>
                      <p className="font-medium">{m.displayName}</p>
                      <p className="text-xs text-navy-500 dark:text-navy-400">{m.address}</p>
                      {m.lastError && (
                        <p className="mt-1 text-xs text-red-600 dark:text-red-400">{m.lastError}</p>
                      )}
                    </td>
                    <td className={tdClass}>
                      <Badge tone={STATUS_TONE[m.status]}>{m.status}</Badge>
                    </td>
                    <td className={`${tdClass} hidden md:table-cell`}>
                      {m.quotaMb ? `${(m.quotaMb / 1024).toFixed(1)} GB` : "Unlimited"}
                    </td>
                    <td className={`${tdClass} hidden md:table-cell`}>{formatDateTime(m.lastLoginAt)}</td>
                    <td className={`${tdClass} text-right`}>
                      <div className="flex justify-end gap-1">
                        {m.status !== "failed" && (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={`Edit ${m.address}`}
                              onClick={() => setEditing(m)}
                            >
                              <Pencil className="size-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={`Reset password for ${m.address}`}
                              onClick={() => setResetting(m)}
                            >
                              <KeyRound className="size-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={
                                m.status === "active" ? `Disable ${m.address}` : `Enable ${m.address}`
                              }
                              loading={busyId === m.id}
                              onClick={() => rowAction(m, "toggle")}
                            >
                              <Power
                                className={m.status === "active" ? "size-4" : "size-4 text-emerald-600"}
                              />
                            </Button>
                          </>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Delete ${m.address}`}
                          onClick={() => rowAction(m, "delete")}
                        >
                          <Trash2 className="size-4 text-red-600" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <CreateDialog
        open={creating}
        domains={readyDomains}
        onClose={() => setCreating(false)}
        onCreated={(address, password) => {
          setCreating(false);
          setCredentials({ address, password });
          list.reload();
        }}
      />
      {editing && (
        <EditDialog
          mailbox={editing}
          onClose={() => setEditing(null)}
          onSaved={() => (setEditing(null), list.reload())}
        />
      )}
      {resetting && (
        <ResetDialog
          mailbox={resetting}
          onClose={() => setResetting(null)}
          onReset={(password) => {
            setCredentials({ address: resetting.address, password });
            setResetting(null);
          }}
        />
      )}
    </>
  );
}

function PasswordField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  error: string | null;
}) {
  return (
    <Field
      label="Password"
      hint="At least 12 characters. Generate one and share it with the employee privately."
      error={error}
    >
      {(p) => (
        <div className="flex gap-2">
          <Input
            {...p}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            autoComplete="new-password"
            className="font-mono"
          />
          <Button
            type="button"
            variant="secondary"
            onClick={() => onChange(generatePassword())}
            aria-label="Generate password"
          >
            <Wand2 className="size-4" />
          </Button>
        </div>
      )}
    </Field>
  );
}

function quotaToMb(gb: string): number | null {
  const n = Number(gb);
  return gb.trim() === "" || !Number.isFinite(n) || n <= 0 ? null : Math.round(n * 1024);
}

function CreateDialog({
  open,
  domains,
  onClose,
  onCreated,
}: {
  open: boolean;
  domains: Domain[];
  onClose: () => void;
  onCreated: (address: string, password: string) => void;
}) {
  const [form, setForm] = useState({
    displayName: "",
    localPart: "",
    domainId: "",
    quotaGb: "",
    password: generatePassword(),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const domainId = form.domainId || domains[0]?.id || "";
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { mailbox } = await api<{ mailbox: Mailbox }>("/admin/mailboxes", {
        method: "POST",
        body: {
          displayName: form.displayName,
          localPart: form.localPart,
          domainId,
          quotaMb: quotaToMb(form.quotaGb),
          password: form.password,
        },
      });
      onCreated(mailbox.address, form.password);
      setForm({ displayName: "", localPart: "", domainId: "", quotaGb: "", password: generatePassword() });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const fieldErr = (f: string) => fieldError(error, f);
  const generalError = error instanceof ApiError && !error.details?.fieldErrors ? error : null;

  return (
    <Dialog open={open} title="New mailbox" onClose={onClose}>
      {domains.length === 0 ? (
        <Alert tone="info" title="Add a domain first">
          Mailboxes need a domain that is set up on the mail server.{" "}
          <a className="font-semibold underline" href="#/domains">
            Go to Domains
          </a>
          .
        </Alert>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field label="Full name" error={fieldErr("displayName")}>
            {(p) => (
              <Input
                {...p}
                value={form.displayName}
                onChange={(e) => set("displayName")(e.target.value)}
                autoFocus
              />
            )}
          </Field>
          <Field label="Email address" error={fieldErr("localPart")}>
            {(p) => (
              <div className="flex items-center gap-2">
                <Input
                  {...p}
                  value={form.localPart}
                  onChange={(e) => set("localPart")(e.target.value)}
                  placeholder="priya"
                />
                <span className="text-navy-400">@</span>
                <Select
                  value={domainId}
                  onChange={(e) => set("domainId")(e.target.value)}
                  aria-label="Domain"
                >
                  {domains.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </Field>
          <Field label="Storage quota (GB)" hint="Leave empty for unlimited." error={fieldErr("quotaMb")}>
            {(p) => (
              <Input
                {...p}
                inputMode="decimal"
                value={form.quotaGb}
                onChange={(e) => set("quotaGb")(e.target.value)}
                placeholder="Unlimited"
              />
            )}
          </Field>
          <PasswordField value={form.password} onChange={set("password")} error={fieldErr("password")} />
          {generalError && <ErrorBlock error={generalError} />}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Create mailbox
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function EditDialog({
  mailbox,
  onClose,
  onSaved,
}: {
  mailbox: Mailbox;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [displayName, setDisplayName] = useState(mailbox.displayName);
  const [quotaGb, setQuotaGb] = useState(mailbox.quotaMb ? String(mailbox.quotaMb / 1024) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/mailboxes/${mailbox.id}`, {
        method: "PATCH",
        body: { displayName, quotaMb: quotaToMb(quotaGb) },
      });
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open title={`Edit ${mailbox.address}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Full name" error={fieldError(error, "displayName")}>
          {(p) => <Input {...p} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />}
        </Field>
        <Field
          label="Storage quota (GB)"
          hint="Leave empty for unlimited."
          error={fieldError(error, "quotaMb")}
        >
          {(p) => (
            <Input
              {...p}
              inputMode="decimal"
              value={quotaGb}
              onChange={(e) => setQuotaGb(e.target.value)}
              placeholder="Unlimited"
            />
          )}
        </Field>
        {error instanceof ApiError && !error.details?.fieldErrors && <ErrorBlock error={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ResetDialog({
  mailbox,
  onClose,
  onReset,
}: {
  mailbox: Mailbox;
  onClose: () => void;
  onReset: (password: string) => void;
}) {
  const [password, setPassword] = useState(generatePassword);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/mailboxes/${mailbox.id}/password`, { method: "POST", body: { password } });
      onReset(password);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open title={`Reset password for ${mailbox.address}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <p className="text-sm text-navy-600 dark:text-navy-300">
          The employee is signed out of webmail on every device.
        </p>
        <PasswordField value={password} onChange={setPassword} error={fieldError(error, "password")} />
        {error instanceof ApiError && !error.details?.fieldErrors && <ErrorBlock error={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Reset password
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
