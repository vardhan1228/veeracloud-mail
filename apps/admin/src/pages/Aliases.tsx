import { useState, type FormEvent } from "react";
import { AtSign, Plus, Trash2 } from "lucide-react";
import {
  Alert,
  ApiError,
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  Input,
  Select,
  Spinner,
  api,
  fieldError,
  useApi,
} from "@havins/ui";
import {
  ErrorBlock,
  PageHeader,
  tableClass,
  tdClass,
  thClass,
  type AliasRow,
  type Domain,
  type Mailbox,
} from "../shared";

export function Aliases() {
  const list = useApi<{ aliases: AliasRow[] }>("/admin/aliases");
  const mailboxes = useApi<{ mailboxes: Mailbox[] }>("/admin/mailboxes");
  const domains = useApi<{ domains: Domain[] }>("/admin/domains");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function remove(a: AliasRow) {
    if (!confirm(`Delete ${a.address}? Mail sent to it will bounce.`)) return;
    setBusyId(a.id);
    setError(null);
    try {
      await api(`/admin/aliases/${a.id}`, { method: "DELETE" });
      list.reload();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Aliases"
        description="Extra addresses, such as sales@ or info@, that deliver into an employee's mailbox."
        action={
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" /> New alias
          </Button>
        }
      />
      {error && (
        <div className="mb-4">
          <ErrorBlock error={error} />
        </div>
      )}
      <Card>
        {list.loading && !list.data ? (
          <Spinner />
        ) : list.error ? (
          <div className="p-5">
            <ErrorBlock error={list.error} onRetry={list.reload} />
          </div>
        ) : list.data!.aliases.length === 0 ? (
          <EmptyState icon={<AtSign className="size-5" />} title="No aliases yet">
            Point a shared address such as info@ at the person who handles it.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th className={thClass}>Alias</th>
                  <th className={thClass}>Delivers to</th>
                  <th className={thClass}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.data!.aliases.map((a) => (
                  <tr key={a.id}>
                    <td className={`${tdClass} font-medium`}>{a.address}</td>
                    <td className={tdClass}>{a.destination}</td>
                    <td className={`${tdClass} text-right`}>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Delete ${a.address}`}
                        loading={busyId === a.id}
                        onClick={() => remove(a)}
                      >
                        <Trash2 className="size-4 text-red-600" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {creating && (
        <CreateAlias
          domains={(domains.data?.domains ?? []).filter((d) => d.mailReady)}
          mailboxes={(mailboxes.data?.mailboxes ?? []).filter((m) => m.status === "active")}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            list.reload();
          }}
        />
      )}
    </>
  );
}

function CreateAlias({
  domains,
  mailboxes,
  onClose,
  onCreated,
}: {
  domains: Domain[];
  mailboxes: Mailbox[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [localPart, setLocalPart] = useState("");
  const [domainId, setDomainId] = useState(domains[0]?.id ?? "");
  const [destinationMailboxId, setDestination] = useState(mailboxes[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/admin/aliases", { method: "POST", body: { localPart, domainId, destinationMailboxId } });
      onCreated();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open title="New alias" onClose={onClose}>
      {domains.length === 0 || mailboxes.length === 0 ? (
        <Alert tone="info" title="Nothing to point an alias at yet">
          You need a domain set up on the mail server and at least one active mailbox.
        </Alert>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field label="Alias address" error={fieldError(error, "localPart")}>
            {(p) => (
              <div className="flex items-center gap-2">
                <Input
                  {...p}
                  value={localPart}
                  onChange={(e) => setLocalPart(e.target.value)}
                  placeholder="sales"
                  autoFocus
                />
                <span className="text-navy-400">@</span>
                <Select value={domainId} onChange={(e) => setDomainId(e.target.value)} aria-label="Domain">
                  {domains.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </Field>
          <Field label="Deliver to" error={fieldError(error, "destinationMailboxId")}>
            {(p) => (
              <Select {...p} value={destinationMailboxId} onChange={(e) => setDestination(e.target.value)}>
                {mailboxes.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName} ({m.address})
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {error instanceof ApiError && !error.details?.fieldErrors && <ErrorBlock error={error} />}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Create alias
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
