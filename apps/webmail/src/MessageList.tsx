import { useEffect, useState, type FormEvent } from "react";
import { Inbox, Paperclip, RefreshCw, Search, Star, X } from "lucide-react";
import { Alert, Avatar, Button, EmptyState, Input, SkeletonRows, cx, useApi } from "@havins/ui";
import { shortName, type Listing, type MessageSummary } from "./types";

const PAGE = 50;

function when(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat("en-IN", { timeStyle: "short" }).format(d);
  }
  const sameYear = d.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(
    "en-IN",
    sameYear ? { day: "numeric", month: "short" } : { dateStyle: "medium" },
  ).format(d);
}

const EMPTY: Record<string, string> = {
  inbox: "Your inbox is empty.",
  sent: "Mail you send appears here.",
  drafts: "Unsent drafts appear here.",
  junk: "No junk. The spam filter moves suspicious mail here.",
  trash: "Trash is empty.",
  archive: "Archived mail appears here.",
};

export function MessageList({
  folder,
  folderName,
  selectedId,
  version,
  onOpen,
  onChanged,
}: {
  folder: string;
  folderName: string;
  selectedId: string | null;
  version: number;
  onOpen: (m: MessageSummary) => void;
  onChanged: () => void;
}) {
  const [draftQuery, setDraftQuery] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const params = new URLSearchParams({ folder, limit: String(PAGE), offset: String(offset) });
  if (query) params.set("q", query);
  const list = useApi<Listing>(`/mail/messages?${params}`);
  const showRecipient = folder === "sent" || folder === "drafts";

  // Refresh when something else changed (a move, a send, the poll timer).
  const { reload } = list;
  useEffect(() => {
    if (version > 0) reload();
  }, [version, reload]);

  function search(e: FormEvent) {
    e.preventDefault();
    setOffset(0);
    setQuery(draftQuery.trim());
  }

  const total = list.data?.total ?? 0;

  return (
    <>
      <div className="border-b border-navy-100 p-3 dark:border-white/10">
        <form onSubmit={search} role="search" className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-navy-400"
            aria-hidden="true"
          />
          <Input
            value={draftQuery}
            onChange={(e) => setDraftQuery(e.target.value)}
            placeholder={`Search ${folderName || "mail"}`}
            aria-label="Search mail"
            className="pr-9 pl-9"
          />
          {query && (
            <button
              type="button"
              className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-navy-400 hover:text-navy-700"
              aria-label="Clear search"
              onClick={() => {
                setDraftQuery("");
                setQuery("");
                setOffset(0);
              }}
            >
              <X className="size-4" />
            </button>
          )}
        </form>
        <div className="mt-2 flex items-center justify-between text-xs text-navy-500 dark:text-navy-400">
          <span>
            {query ? `${total} result${total === 1 ? "" : "s"}` : `${total} message${total === 1 ? "" : "s"}`}
          </span>
          <button
            className="inline-flex items-center gap-1 hover:text-brand-600"
            onClick={onChanged}
            aria-label="Refresh"
          >
            <RefreshCw className={cx("size-3.5", list.loading && "animate-spin")} /> Refresh
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.loading && !list.data ? (
          <SkeletonRows />
        ) : list.error && !list.data ? (
          <div className="space-y-3 p-4">
            <Alert tone={list.error.code === "network_error" ? "warning" : "danger"}>
              {list.error.message}
            </Alert>
            <Button size="sm" variant="secondary" onClick={list.reload}>
              Try again
            </Button>
          </div>
        ) : list.data!.messages.length === 0 ? (
          <EmptyState icon={<Inbox className="size-5" />} title={query ? "No matches" : "Nothing here"}>
            {query ? `No messages match "${query}".` : (EMPTY[folder] ?? "This folder is empty.")}
          </EmptyState>
        ) : (
          <ul>
            {list.data!.messages.map((m) => (
              <li key={m.id}>
                <button
                  onClick={() => onOpen(m)}
                  aria-current={m.id === selectedId ? "true" : undefined}
                  className={cx(
                    "block w-full border-b border-navy-100/70 px-4 py-3 text-left transition dark:border-white/5",
                    m.id === selectedId
                      ? "bg-brand-500/10 dark:bg-brand-400/10"
                      : "hover:bg-navy-100/50 dark:hover:bg-white/5",
                  )}
                >
                  <div className="flex gap-3">
                    <Avatar
                      name={showRecipient ? m.to[0]?.name : m.from[0]?.name}
                      email={(showRecipient ? m.to[0]?.email : m.from[0]?.email) ?? "?"}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span
                          className={cx(
                            "flex-1 truncate text-sm",
                            !m.seen
                              ? "font-bold text-navy-950 dark:text-white"
                              : "text-navy-700 dark:text-navy-200",
                          )}
                        >
                          {showRecipient
                            ? `To: ${m.to.map(shortName).join(", ") || "(no recipients)"}`
                            : shortName(m.from[0])}
                        </span>
                        {m.flagged && (
                          <Star
                            className="size-3.5 shrink-0 fill-amber-400 text-amber-400"
                            aria-label="Flagged"
                          />
                        )}
                        {m.hasAttachment && (
                          <Paperclip
                            className="size-3.5 shrink-0 text-navy-400"
                            aria-label="Has attachment"
                          />
                        )}
                        <span
                          className={cx(
                            "shrink-0 text-xs tabular-nums",
                            !m.seen
                              ? "font-semibold text-brand-600 dark:text-brand-300"
                              : "text-navy-500 dark:text-navy-400",
                          )}
                        >
                          {when(m.receivedAt)}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2">
                        <p
                          className={cx(
                            "flex-1 truncate text-sm",
                            !m.seen ? "font-semibold" : "text-navy-700 dark:text-navy-200",
                          )}
                        >
                          {m.subject || "(no subject)"}
                        </p>
                        {!m.seen && (
                          <span className="size-2 shrink-0 rounded-full bg-brand-500" aria-label="Unread" />
                        )}
                      </div>
                      <p className="mt-0.5 truncate text-xs text-navy-500 dark:text-navy-400">{m.preview}</p>
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {total > PAGE && (
        <div className="flex items-center justify-between border-t border-navy-100 p-2 text-xs dark:border-white/10">
          <Button
            size="sm"
            variant="ghost"
            disabled={offset === 0}
            onClick={() => setOffset((o) => Math.max(0, o - PAGE))}
          >
            Newer
          </Button>
          <span className="text-navy-500">
            {offset + 1}–{Math.min(offset + PAGE, total)} of {total}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={offset + PAGE >= total}
            onClick={() => setOffset((o) => o + PAGE)}
          >
            Older
          </Button>
        </div>
      )}
    </>
  );
}
