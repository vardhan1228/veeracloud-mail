import { useState, type FormEvent } from "react";
import { Globe, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
  Alert,
  ApiError,
  Badge,
  Button,
  Card,
  CardHeader,
  CopyButton,
  Dialog,
  EmptyState,
  Field,
  Input,
  Spinner,
  api,
  fieldError,
  formatDate,
  useApi,
} from "@havins/ui";
import { ErrorBlock, PageHeader, SetupRequired, type DnsRecord, type Domain } from "../shared";

interface DomainResult {
  domain: Domain;
  providerStatus: "ready" | "not_configured" | "error";
  error?: string;
}

export function Domains() {
  const list = useApi<{ domains: Domain[] }>("/admin/domains");
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<DomainResult | null>(null);

  return (
    <>
      <PageHeader
        title="Domains"
        description="Company domains the mail server accepts mail for."
        action={
          <Button onClick={() => setAdding(true)}>
            <Plus className="size-4" /> Add domain
          </Button>
        }
      />
      {notice && <ProvisionNotice result={notice} />}

      {list.loading && !list.data ? (
        <Spinner />
      ) : list.error ? (
        <ErrorBlock error={list.error} onRetry={list.reload} />
      ) : list.data!.domains.length === 0 ? (
        <Card>
          <EmptyState icon={<Globe className="size-5" />} title="No domains yet">
            Add the domain your company uses for email, for example yourcompany.com.
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-4">
          {list.data!.domains.map((d) => (
            <DomainCard key={d.id} domain={d} onChanged={list.reload} onResult={setNotice} />
          ))}
        </div>
      )}

      <AddDomainDialog
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={(r) => {
          setAdding(false);
          setNotice(r);
          list.reload();
        }}
      />
    </>
  );
}

function ProvisionNotice({ result }: { result: DomainResult }) {
  return (
    <div className="mb-4">
      {result.providerStatus === "ready" ? (
        <Alert tone="success" title={`${result.domain.name} is set up on the mail server`}>
          Publish the DNS records below at your DNS host. Mail will not arrive until the MX record is live.
        </Alert>
      ) : result.providerStatus === "not_configured" ? (
        <SetupRequired detail={`${result.domain.name} was saved but not created on a mail server.`} />
      ) : (
        <Alert tone="danger" title={`The mail server rejected ${result.domain.name}`}>
          {result.error} You can retry from the domain card.
        </Alert>
      )}
    </div>
  );
}

function DomainCard({
  domain,
  onChanged,
  onResult,
}: {
  domain: Domain;
  onChanged: () => void;
  onResult: (r: DomainResult) => void;
}) {
  const [busy, setBusy] = useState<"retry" | "delete" | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  async function run(kind: "retry" | "delete") {
    if (kind === "delete" && !confirm(`Delete ${domain.name}? Its aliases are removed too.`)) return;
    setBusy(kind);
    setError(null);
    try {
      if (kind === "retry")
        onResult(await api<DomainResult>(`/admin/domains/${domain.id}/provision`, { method: "POST" }));
      else await api(`/admin/domains/${domain.id}`, { method: "DELETE" });
      onChanged();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader
        title={domain.name}
        description={`Added ${formatDate(domain.createdAt)}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {domain.mailReady ? (
              <Badge tone="success">On mail server</Badge>
            ) : domain.status === "provider_error" ? (
              <Badge tone="danger">Mail server error</Badge>
            ) : (
              <Badge tone="warning">Not on mail server</Badge>
            )}
            {!domain.mailReady && (
              <Button size="sm" variant="secondary" loading={busy === "retry"} onClick={() => run("retry")}>
                <RefreshCw className="size-3.5" /> Set up on server
              </Button>
            )}
            <Button size="sm" variant="danger" loading={busy === "delete"} onClick={() => run("delete")}>
              <Trash2 className="size-3.5" /> Delete
            </Button>
          </div>
        }
      />
      <div className="p-5">
        {error && (
          <div className="mb-4">
            <ErrorBlock error={error} />
          </div>
        )}
        {domain.records && domain.records.length > 0 ? (
          <DnsTable records={domain.records} />
        ) : (
          <p className="text-sm text-navy-500 dark:text-navy-400">
            DNS records appear here once the domain is set up on the mail server.
          </p>
        )}
      </div>
    </Card>
  );
}

function DnsTable({ records }: { records: DnsRecord[] }) {
  return (
    <div className="space-y-3">
      <Alert tone="info" title="Publish these records at your DNS host">
        In Cloudflare, set the MX target and mail server host records to{" "}
        <strong>DNS only (grey cloud)</strong>. Proxied records break mail delivery.
      </Alert>
      <ul className="divide-y divide-navy-100 rounded-xl border border-navy-100 dark:divide-white/10 dark:border-white/10">
        {records.map((r, i) => (
          <li key={i} className="grid gap-2 p-3 text-sm sm:grid-cols-[80px_1fr_auto] sm:items-start">
            <div className="flex items-center gap-2 sm:block">
              <Badge>{r.type}</Badge>
              <span className="text-xs uppercase text-navy-500 sm:mt-1 sm:block dark:text-navy-400">
                {r.purpose}
              </span>
            </div>
            <div className="min-w-0 space-y-1">
              <p className="break-all font-mono text-xs">
                <span className="text-navy-500 dark:text-navy-400">Name </span>
                {r.host}
              </p>
              <p className="break-all font-mono text-xs">
                <span className="text-navy-500 dark:text-navy-400">Value </span>
                {r.priority !== undefined && `${r.priority} `}
                {r.value}
              </p>
            </div>
            <div className="flex gap-2">
              <CopyButton value={r.host} label="Name" />
              <CopyButton value={r.value} label="Value" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AddDomainDialog({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: (r: DomainResult) => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<DomainResult>("/admin/domains", { method: "POST", body: { name } });
      setName("");
      onAdded(result);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} title="Add domain" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field
          label="Domain"
          hint="Without www or https://, for example yourcompany.com"
          error={fieldError(error, "name")}
        >
          {(p) => (
            <Input
              {...p}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="yourcompany.com"
              autoFocus
            />
          )}
        </Field>
        {error instanceof ApiError && !fieldError(error, "name") && <ErrorBlock error={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Add domain
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
