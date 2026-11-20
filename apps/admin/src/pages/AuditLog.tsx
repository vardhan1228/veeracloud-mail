import { useState } from "react";
import { ScrollText } from "lucide-react";
import { Badge, Button, Card, EmptyState, Spinner, formatDateTime, useApi } from "@havins/ui";
import { ErrorBlock, PageHeader, tableClass, tdClass, thClass } from "../shared";

interface AuditRow {
  id: string;
  actorType: "admin" | "mail" | "system";
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: string | null;
  ip: string | null;
  createdAt: number;
}

const PAGE = 50;

function describe(metadata: string | null): string {
  if (!metadata) return "";
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    return Object.entries(parsed)
      .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
      .join(" · ");
  } catch {
    return metadata;
  }
}

export function AuditLog() {
  const [offset, setOffset] = useState(0);
  const log = useApi<{ auditLogs: AuditRow[] }>(`/admin/audit-logs?limit=${PAGE}&offset=${offset}`);
  const rows = log.data?.auditLogs ?? [];

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every sign-in and change, newest first. Message content is never logged."
      />
      <Card>
        {log.loading && !log.data ? (
          <Spinner />
        ) : log.error ? (
          <div className="p-5">
            <ErrorBlock error={log.error} onRetry={log.reload} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<ScrollText className="size-5" />}
            title={offset ? "No older entries" : "Nothing logged yet"}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th className={thClass}>When</th>
                  <th className={thClass}>Action</th>
                  <th className={thClass}>Details</th>
                  <th className={`${thClass} hidden lg:table-cell`}>IP</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className={`${tdClass} whitespace-nowrap text-xs`}>{formatDateTime(r.createdAt)}</td>
                    <td className={tdClass}>
                      <div className="flex items-center gap-2">
                        <Badge
                          tone={
                            r.action.includes("failed")
                              ? "danger"
                              : r.actorType === "admin"
                                ? "info"
                                : "neutral"
                          }
                        >
                          {r.actorType}
                        </Badge>
                        <span className="font-mono text-xs">{r.action}</span>
                      </div>
                    </td>
                    <td
                      className={`${tdClass} max-w-md text-xs break-words text-navy-600 dark:text-navy-300`}
                    >
                      {describe(r.metadata)}
                    </td>
                    <td className={`${tdClass} hidden font-mono text-xs lg:table-cell`}>{r.ip ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex items-center justify-between p-3">
          <Button
            size="sm"
            variant="secondary"
            disabled={offset === 0}
            onClick={() => setOffset((o) => Math.max(0, o - PAGE))}
          >
            Newer
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={rows.length < PAGE}
            onClick={() => setOffset((o) => o + PAGE)}
          >
            Older
          </Button>
        </div>
      </Card>
    </>
  );
}
