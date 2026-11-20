import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Archive,
  ArrowLeft,
  Download,
  Forward,
  Inbox,
  MailOpen,
  Reply,
  ReplyAll,
  ShieldAlert,
  ShieldCheck,
  Star,
  Trash2,
} from "lucide-react";
import {
  Alert,
  Avatar,
  Button,
  Spinner,
  api,
  apiUrl,
  formatBytes,
  formatDateTime,
  navigate,
  useApi,
  useToast,
  type ApiError,
} from "@havins/ui";
import { formatAddress, type Message } from "./types";
import type { ComposeSeed } from "./Compose";
import { typing } from "./keys";

/**
 * Message HTML is untrusted. It renders in an iframe sandbox without allow-scripts or
 * allow-same-origin, so it cannot run code or reach the app. The CSP also blocks remote
 * resources (tracking pixels) until the reader opts in to images.
 */
function srcDoc(html: string, remoteImages: boolean, dark: boolean) {
  const img = remoteImages ? "img-src data: cid: https:;" : "img-src data: cid:;";
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ${img} style-src 'unsafe-inline'; font-src data:;">
<base target="_blank">
<style>body{margin:0;padding:16px;font:14px/1.55 Inter,system-ui,sans-serif;word-wrap:break-word;${dark ? "background:#fff;" : ""}}img{max-width:100%;height:auto}</style>
</head><body>${html}</body></html>`;
}

const FOLDER_NAMES: Record<string, string> = {
  inbox: "Inbox",
  archive: "Archive",
  junk: "Junk",
  trash: "Trash",
};

const hasRemoteImages = (html: string) => /<img[^>]+src\s*=\s*["']?https?:/i.test(html);

export function Reader({
  id,
  folder,
  online,
  onCompose,
  onChanged,
}: {
  id: string;
  folder: string;
  online: boolean;
  onCompose: (seed: ComposeSeed) => void;
  onChanged: () => void;
}) {
  const res = useApi<{ message: Message }>(`/mail/messages/${encodeURIComponent(id)}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [flagged, setFlagged] = useState<boolean | null>(null);
  const [remoteImages, setRemoteImages] = useState(false);
  const toast = useToast();
  const msg = res.data?.message;
  const back = () => navigate(`/f/${encodeURIComponent(folder)}`);

  // Opening a message marks it read.
  const markRead = msg && !msg.seen;
  useEffect(() => {
    if (!markRead) return;
    api(`/mail/messages/${encodeURIComponent(id)}`, { method: "PATCH", body: { seen: true } }).then(
      onChanged,
      () => undefined,
    );
  }, [markRead, id]);

  const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  const doc = useMemo(
    () => (msg?.html ? srcDoc(msg.html, remoteImages, dark) : null),
    [msg?.html, remoteImages, dark],
  );

  async function act(name: string, body: Record<string, unknown> | null, leave: boolean) {
    setBusy(name);
    setError(null);
    const path = `/mail/messages/${encodeURIComponent(id)}`;
    try {
      if (body) await api(path, { method: "PATCH", body });
      else await api(path, { method: "DELETE" });
      onChanged();
      if (leave) back();
      const target = typeof body?.folder === "string" ? body.folder : null;
      if (!body) toast.success("Message deleted permanently");
      else if (target) {
        toast.success(`Moved to ${FOLDER_NAMES[target] ?? target}`, {
          label: "Undo",
          run: () => {
            void api(path, { method: "PATCH", body: { folder } }).then(onChanged, () =>
              toast.error("Could not undo"),
            );
          },
        });
      } else if (body.seen === false) toast.info("Marked as unread");
    } catch (err) {
      setError(err as ApiError);
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // Keyboard shortcuts while a message is open.
  useEffect(() => {
    if (!msg) return;
    const onKey = (e: KeyboardEvent) => {
      if (typing(e) || document.querySelector("dialog[open]")) return;
      const keys: Record<string, () => void> = {
        r: () => onCompose({ mode: "reply", message: msg }),
        a: () => onCompose({ mode: "replyAll", message: msg }),
        f: () => onCompose({ mode: "forward", message: msg }),
        e: () => {
          if (folder !== "archive") void act("archive", { folder: "archive" }, true);
        },
        "#": () => {
          if (folder !== "trash") void act("trash", { folder: "trash" }, true);
        },
        s: () => {
          const next = !(flagged ?? msg.flagged);
          setFlagged(next);
          void act("flag", { flagged: next }, false);
        },
        u: () => void act("unread", { seen: false }, true),
        Escape: back,
      };
      const run = keys[e.key];
      if (run && (online || e.key === "Escape")) {
        e.preventDefault();
        run();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (res.loading && !msg) return <Spinner label="Loading message" />;
  if (res.error || !msg) {
    return (
      <div className="space-y-3 p-6">
        <Button size="sm" variant="ghost" onClick={back}>
          <ArrowLeft className="size-4" /> Back
        </Button>
        <Alert
          tone={res.error?.status === 404 ? "info" : "danger"}
          title={res.error?.status === 404 ? "Message not found" : "Cannot open message"}
        >
          {res.error?.status === 404 ? "It may have been moved or deleted." : res.error?.message}
        </Alert>
      </div>
    );
  }

  const isFlagged = flagged ?? msg.flagged;
  const inTrashOrJunk = folder === "trash" || folder === "junk";
  const tool = (label: string, icon: ReactNode, onClick: () => void, key = label) => (
    <Button
      size="sm"
      variant="ghost"
      aria-label={label}
      title={label}
      loading={busy === key}
      disabled={!online}
      onClick={onClick}
    >
      {icon}
    </Button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-navy-100 px-2 py-1.5 dark:border-white/10">
        <Button size="sm" variant="ghost" aria-label="Back to list" className="md:hidden" onClick={back}>
          <ArrowLeft className="size-4" />
        </Button>
        {tool("Reply", <Reply className="size-4" />, () => onCompose({ mode: "reply", message: msg }))}
        {tool("Reply all", <ReplyAll className="size-4" />, () =>
          onCompose({ mode: "replyAll", message: msg }),
        )}
        {tool("Forward", <Forward className="size-4" />, () => onCompose({ mode: "forward", message: msg }))}
        <span className="mx-1 h-5 w-px bg-navy-200 dark:bg-white/10" />
        {folder !== "archive" &&
          folder !== "inbox" &&
          tool("Move to inbox", <Inbox className="size-4" />, () => act("inbox", { folder: "inbox" }, true))}
        {folder !== "archive" &&
          tool("Archive", <Archive className="size-4" />, () => act("archive", { folder: "archive" }, true))}
        {folder === "junk"
          ? tool("Not junk", <ShieldCheck className="size-4" />, () =>
              act("notjunk", { folder: "inbox" }, true),
            )
          : tool("Report junk", <ShieldAlert className="size-4" />, () =>
              act("junk", { folder: "junk" }, true),
            )}
        {tool(
          isFlagged ? "Unflag" : "Flag",
          <Star className={isFlagged ? "size-4 fill-amber-400 text-amber-400" : "size-4"} />,
          () => {
            setFlagged(!isFlagged);
            void act("flag", { flagged: !isFlagged }, false);
          },
          "flag",
        )}
        {tool("Mark unread", <MailOpen className="size-4" />, () => act("unread", { seen: false }, true))}
        {inTrashOrJunk
          ? tool("Delete permanently", <Trash2 className="size-4 text-red-600" />, () => {
              if (confirm("Delete this message permanently? This cannot be undone."))
                void act("delete", null, true);
            })
          : tool("Move to trash", <Trash2 className="size-4" />, () =>
              act("trash", { folder: "trash" }, true),
            )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-3 px-5 py-4">
          {error && <Alert tone="danger">{error.message}</Alert>}
          <h1 className="text-xl font-bold break-words">{msg.subject || "(no subject)"}</h1>
          <div className="flex gap-3 text-sm">
            <Avatar name={msg.from[0]?.name} email={msg.from[0]?.email ?? "?"} size="lg" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <p className="truncate font-semibold">
                  {msg.from.map(formatAddress).join(", ") || "(unknown sender)"}
                </p>
                <p className="text-xs text-navy-500 dark:text-navy-400">{formatDateTime(msg.receivedAt)}</p>
              </div>
              <p className="truncate text-navy-500 dark:text-navy-400">
                To: {msg.to.map(formatAddress).join(", ") || "—"}
              </p>
              {msg.cc.length > 0 && (
                <p className="truncate text-navy-500 dark:text-navy-400">
                  Cc: {msg.cc.map(formatAddress).join(", ")}
                </p>
              )}
            </div>
          </div>
          {folder === "junk" && (
            <Alert tone="warning" title="This message was marked as junk">
              Be careful with links and attachments. If it is safe, choose “Not junk”.
            </Alert>
          )}
          {msg.html && !remoteImages && hasRemoteImages(msg.html) && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl bg-navy-100/70 px-3 py-2 text-xs dark:bg-white/5">
              Remote images are blocked to protect your privacy.
              <Button size="sm" variant="secondary" onClick={() => setRemoteImages(true)}>
                Show images
              </Button>
            </div>
          )}
        </div>

        {doc ? (
          <iframe
            title="Message body"
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            srcDoc={doc}
            className="block h-[70vh] w-full border-0 bg-white"
          />
        ) : (
          <pre className="px-5 pb-6 font-sans text-sm whitespace-pre-wrap break-words">
            {msg.text || "(empty message)"}
          </pre>
        )}

        {msg.attachments.length > 0 && (
          <div className="border-t border-navy-100 px-5 py-4 dark:border-white/10">
            <p className="mb-2 text-xs font-semibold tracking-wide text-navy-500 uppercase">
              {msg.attachments.length} attachment{msg.attachments.length === 1 ? "" : "s"}
            </p>
            <ul className="flex flex-wrap gap-2">
              {msg.attachments.map((a) => (
                <li key={a.blobId}>
                  <a
                    href={apiUrl(
                      `/mail/attachments/${encodeURIComponent(a.blobId)}?name=${encodeURIComponent(a.name)}`,
                    )}
                    className="flex items-center gap-2 rounded-xl border border-navy-200 px-3 py-2 text-sm hover:bg-navy-100/60 dark:border-white/15 dark:hover:bg-white/5"
                    download={a.name}
                  >
                    <Download className="size-4 text-navy-500" aria-hidden="true" />
                    <span className="max-w-[16rem] truncate">{a.name}</span>
                    <span className="text-xs text-navy-500">{formatBytes(a.size)}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
