import { AtSign, Globe, MonitorSmartphone, Server, UserX, Users } from "lucide-react";
import { Alert, Badge, Card, CardHeader, Spinner, useApi } from "@havins/ui";
import { ErrorBlock, PageHeader, SetupRequired } from "../shared";

interface Stats {
  domains: number;
  activeMailboxes: number;
  disabledMailboxes: number;
  aliases: number;
  webmailSessions: number;
}

type ServerStatus =
  | { configured: false; ok: false; detail: string }
  | { configured: true; ok: boolean; provider: string; isMock: boolean; latencyMs: number; detail?: string };

export function Overview() {
  const stats = useApi<Stats>("/admin/stats");
  const server = useApi<ServerStatus>("/admin/server");

  const tiles = stats.data
    ? [
        { label: "Active mailboxes", value: stats.data.activeMailboxes, icon: Users, href: "#/mailboxes" },
        {
          label: "Disabled mailboxes",
          value: stats.data.disabledMailboxes,
          icon: UserX,
          href: "#/mailboxes",
        },
        { label: "Aliases", value: stats.data.aliases, icon: AtSign, href: "#/aliases" },
        { label: "Domains", value: stats.data.domains, icon: Globe, href: "#/domains" },
        { label: "Webmail sessions", value: stats.data.webmailSessions, icon: MonitorSmartphone },
      ]
    : [];

  return (
    <>
      <PageHeader title="Overview" description="Company mail at a glance." />

      {stats.loading && !stats.data ? (
        <Spinner />
      ) : stats.error ? (
        <ErrorBlock error={stats.error} onRetry={stats.reload} />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
          {tiles.map(({ label, value, icon: Icon, href }) => {
            const body = (
              <Card className="h-full p-4 transition hover:shadow-lift">
                <Icon className="size-4 text-brand-600 dark:text-brand-300" aria-hidden="true" />
                <p className="mt-3 font-display text-2xl font-extrabold tabular-nums">{value}</p>
                <p className="text-xs text-navy-500 dark:text-navy-400">{label}</p>
              </Card>
            );
            return href ? (
              <a key={label} href={href}>
                {body}
              </a>
            ) : (
              <div key={label}>{body}</div>
            );
          })}
        </div>
      )}

      {stats.data && stats.data.domains === 0 && (
        <div className="mt-4">
          <Alert tone="info" title="Start here">
            Add your company domain under{" "}
            <a className="font-semibold underline" href="#/domains">
              Domains
            </a>
            , publish the DNS records it shows, then create a mailbox for each employee.
          </Alert>
        </div>
      )}

      <Card className="mt-6">
        <CardHeader
          title="Mail server"
          description="Health of the Stalwart server the API talks to."
          action={<Server className="size-5 text-navy-400" />}
        />
        <div className="p-5">
          {server.loading && !server.data ? (
            <Spinner label="Checking" />
          ) : server.error ? (
            <ErrorBlock error={server.error} onRetry={server.reload} />
          ) : !server.data?.configured ? (
            <SetupRequired detail={server.data?.detail} />
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={server.data.ok ? "success" : "danger"}>
                  {server.data.ok ? "Reachable" : "Unreachable"}
                </Badge>
                <span className="text-sm text-navy-600 dark:text-navy-300">
                  {server.data.provider} · {server.data.latencyMs} ms
                </span>
              </div>
              {server.data.isMock && (
                <Alert tone="warning" title="Development mail server">
                  This is the built-in mock. It delivers only between local mailboxes and never sends to the
                  internet.
                </Alert>
              )}
              {!server.data.ok && server.data.detail && <Alert tone="danger">{server.data.detail}</Alert>}
            </div>
          )}
        </div>
      </Card>
    </>
  );
}
