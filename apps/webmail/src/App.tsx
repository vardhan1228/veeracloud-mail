import { useCallback, useEffect, useState } from "react";
import {
  Archive,
  FileText,
  Folder as FolderIcon,
  Inbox,
  LogOut,
  Menu,
  PenSquare,
  Send,
  Settings as SettingsIcon,
  ShieldAlert,
  Trash2,
  WifiOff,
  X,
} from "lucide-react";
import {
  Alert,
  AuthScreen,
  Button,
  Dialog,
  Kbd,
  Logo,
  Spinner,
  ThemeToggle,
  api,
  cx,
  navigate,
  useApi,
  useOnline,
  useRoute,
} from "@havins/ui";
import { folderKey, type Folder, type FolderRole, type Me, type MessageSummary } from "./types";
import { MessageList } from "./MessageList";
import { Reader } from "./Reader";
import { Compose, type ComposeSeed } from "./Compose";
import { Settings } from "./Settings";
import { useLiveMail, useNewMailNotification, useUnreadTitle, type LiveState } from "./live";
import { typing } from "./keys";

const LIVE_LABEL: Record<LiveState, string> = {
  live: "Live",
  connecting: "Connecting…",
  offline: "Updates paused",
};

const ICONS: Record<FolderRole, typeof Inbox> = {
  inbox: Inbox,
  drafts: FileText,
  sent: Send,
  archive: Archive,
  junk: ShieldAlert,
  trash: Trash2,
};

export function App() {
  const me = useApi<Me>("/mail/me");
  if (me.loading && !me.data) return <Spinner label="Opening your mailbox" />;
  if (me.error?.status === 401) return <SignIn onSignedIn={me.reload} />;
  if (me.error) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-4">
        {me.error.code === "network_error" ? (
          <Alert tone="warning" title="Cannot reach the mail service">
            {me.error.message}
          </Alert>
        ) : (
          <Alert tone="danger" title="Cannot open your mailbox">
            {me.error.message}
          </Alert>
        )}
        <Button variant="secondary" onClick={me.reload}>
          Try again
        </Button>
      </div>
    );
  }
  return <Mail me={me.data!} />;
}

function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  return (
    <AuthScreen
      heading="Sign in to your mail"
      subheading="Use your work email address and the password your administrator gave you."
      emailLabel="Work email"
      aside={
        <>
          <p className="font-display text-3xl font-extrabold leading-tight">Your company inbox.</p>
          <p className="mt-3 text-navy-200">Forgot your password? Ask your administrator to reset it.</p>
        </>
      }
      onSubmit={async (address, password, turnstileToken) => {
        await api("/mail/login", { method: "POST", body: { address, password, turnstileToken } });
        navigate("/");
        onSignedIn();
      }}
    />
  );
}

/** Routes: /f/<folder>, /f/<folder>/m/<messageId>, /settings */
function parseRoute(route: string) {
  const parts = route.split("/").filter(Boolean);
  if (parts[0] === "settings") return { view: "settings" as const, folder: "inbox", messageId: null };
  const folder = parts[0] === "f" && parts[1] ? decodeURIComponent(parts[1]) : "inbox";
  const messageId = parts[2] === "m" && parts[3] ? decodeURIComponent(parts[3]) : null;
  return { view: "mail" as const, folder, messageId };
}

function Mail({ me }: { me: Me }) {
  const route = parseRoute(useRoute());
  const online = useOnline();
  const folders = useApi<{ folders: Folder[] }>("/mail/folders");
  const [compose, setCompose] = useState<ComposeSeed | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [help, setHelp] = useState(false);
  // Bumped after any change so the list and folder counts refresh together.
  const [version, setVersion] = useState(0);
  const { reload: reloadFolders } = folders;
  const refresh = useCallback(() => {
    setVersion((v) => v + 1);
    reloadFolders();
  }, [reloadFolders]);

  // New mail is pushed from the server; no waiting for a poll.
  const live = useLiveMail(refresh);
  const inbox = folders.data?.folders.find((f) => f.role === "inbox");
  useUnreadTitle(inbox?.unread ?? 0, `${me.companyName} Mail`);
  useNewMailNotification(
    inbox?.unread,
    useCallback(() => navigate("/f/inbox"), []),
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e) || compose) return;
      if (e.key === "c" && online) {
        e.preventDefault();
        setCompose({ mode: "new" });
      } else if (e.key === "?") setHelp(true);
      else if (e.key === "/") {
        e.preventDefault();
        document.querySelector<HTMLInputElement>('input[aria-label="Search mail"]')?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [compose, online]);

  const currentFolder = folders.data?.folders.find((f) => folderKey(f) === route.folder);
  const sessionEnded = folders.error?.status === 401;
  useEffect(() => {
    if (sessionEnded) window.location.reload();
  }, [sessionEnded]);

  const openMessage = (m: MessageSummary) => {
    if (currentFolder?.role === "drafts") setCompose({ mode: "draft", draftId: m.id });
    else navigate(`/f/${encodeURIComponent(route.folder)}/m/${encodeURIComponent(m.id)}`);
  };

  const sidebar = (
    <div className="flex h-full flex-col">
      <Button
        className="w-full"
        onClick={() => (setCompose({ mode: "new" }), setMenuOpen(false))}
        disabled={!online}
      >
        <PenSquare className="size-4" /> Compose
      </Button>
      <p className="mt-3 flex items-center gap-2 px-1 text-xs text-navy-500 dark:text-navy-400" role="status">
        <span
          className={cx(
            "size-2 rounded-full",
            live === "live"
              ? "bg-emerald-500 shadow-[0_0_0_3px_rgb(16_185_129/0.2)]"
              : live === "connecting"
                ? "animate-pulse bg-amber-400"
                : "bg-navy-300",
          )}
          aria-hidden="true"
        />
        {LIVE_LABEL[live]}
        <button
          className="ml-auto hover:text-brand-600"
          onClick={() => setHelp(true)}
          aria-label="Keyboard shortcuts"
        >
          <Kbd>?</Kbd>
        </button>
      </p>
      <nav className="mt-5 flex-1 space-y-0.5 overflow-y-auto" aria-label="Folders">
        {folders.loading && !folders.data ? (
          <Spinner label="Loading folders" />
        ) : folders.error ? (
          <Alert tone="danger">{folders.error.message}</Alert>
        ) : (
          folders.data!.folders.map((f) => {
            const Icon = f.role ? ICONS[f.role] : FolderIcon;
            const active = route.view === "mail" && folderKey(f) === route.folder;
            return (
              <a
                key={f.id}
                href={`#/f/${encodeURIComponent(folderKey(f))}`}
                onClick={() => setMenuOpen(false)}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition",
                  active
                    ? "bg-brand-500/10 font-semibold text-brand-700 dark:bg-brand-400/15 dark:text-brand-200"
                    : "text-navy-700 hover:bg-navy-100/70 dark:text-navy-200 dark:hover:bg-white/5",
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden="true" />
                <span className="flex-1 truncate">{f.name}</span>
                {f.unread > 0 && f.role !== "sent" && f.role !== "drafts" && (
                  <span className="text-xs font-semibold tabular-nums">{f.unread}</span>
                )}
              </a>
            );
          })
        )}
      </nav>
      <div className="border-t border-navy-100 pt-3 dark:border-white/10">
        <p className="truncate text-sm font-medium">{me.displayName}</p>
        <p className="truncate text-xs text-navy-500 dark:text-navy-400">{me.address}</p>
        <div className="mt-2 flex items-center gap-1">
          <a
            href="#/settings"
            onClick={() => setMenuOpen(false)}
            className="rounded-lg p-2 text-navy-600 hover:bg-navy-100/70 dark:text-navy-200 dark:hover:bg-white/10"
            aria-label="Settings"
          >
            <SettingsIcon className="size-4" />
          </a>
          <ThemeToggle />
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              await api("/mail/logout", { method: "POST" }).catch(() => undefined);
              navigate("/");
              window.location.reload();
            }}
          >
            <LogOut className="size-4" /> Sign out
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex h-dvh flex-col">
      {!online && (
        <div
          className="flex items-center justify-center gap-2 bg-amber-500 px-4 py-1.5 text-sm font-medium text-navy-950"
          role="status"
        >
          <WifiOff className="size-4" aria-hidden="true" /> You are offline. Sending and changes are paused
          until you reconnect.
        </div>
      )}
      {me.developmentServer && (
        <div className="bg-navy-900 px-4 py-1 text-center text-xs text-navy-100">
          Development mail server: mail is delivered only between local mailboxes.
        </div>
      )}

      <header className="flex items-center justify-between border-b border-navy-100 px-3 py-2 lg:hidden dark:border-white/10">
        <Button variant="ghost" size="sm" aria-label="Open folders" onClick={() => setMenuOpen(true)}>
          <Menu className="size-5" />
        </Button>
        <span className="truncate text-sm font-semibold">
          {route.view === "settings" ? "Settings" : (currentFolder?.name ?? "Mail")}
        </span>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Compose"
          onClick={() => setCompose({ mode: "new" })}
          disabled={!online}
        >
          <PenSquare className="size-5" />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-60 shrink-0 flex-col border-r border-navy-100 p-4 lg:flex dark:border-white/10">
          <div className="mb-5">
            <Logo />
          </div>
          {sidebar}
        </aside>

        {menuOpen && (
          <div className="fixed inset-0 z-40 bg-navy-950/50 lg:hidden" onClick={() => setMenuOpen(false)}>
            <div
              className="absolute inset-y-0 left-0 w-72 bg-white p-4 dark:bg-navy-900"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-5 flex items-center justify-between">
                <Logo />
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Close folders"
                  onClick={() => setMenuOpen(false)}
                >
                  <X className="size-5" />
                </Button>
              </div>
              <div className="h-[calc(100%-4rem)]">{sidebar}</div>
            </div>
          </div>
        )}

        {route.view === "settings" ? (
          <main className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-8">
            <Settings me={me} />
          </main>
        ) : (
          <>
            <section
              className={cx(
                "min-w-0 flex-col border-r border-navy-100 md:flex md:w-80 xl:w-96 dark:border-white/10",
                route.messageId ? "hidden" : "flex flex-1 md:flex-none",
              )}
              aria-label="Messages"
            >
              <MessageList
                key={route.folder}
                folder={route.folder}
                folderName={currentFolder?.name ?? ""}
                selectedId={route.messageId}
                version={version}
                onOpen={openMessage}
                onChanged={refresh}
              />
            </section>
            <main className={cx("min-w-0 flex-1 flex-col", route.messageId ? "flex" : "hidden md:flex")}>
              {route.messageId ? (
                <Reader
                  key={route.messageId}
                  id={route.messageId}
                  folder={route.folder}
                  online={online}
                  onCompose={setCompose}
                  onChanged={refresh}
                />
              ) : (
                <div className="grid flex-1 place-items-center p-8 text-center text-sm text-navy-500 dark:text-navy-400">
                  Select a message to read it.
                </div>
              )}
            </main>
          </>
        )}
      </div>

      <Dialog open={help} title="Keyboard shortcuts" onClose={() => setHelp(false)}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-sm">
          {(
            [
              ["c", "Compose"],
              ["/", "Search"],
              ["r", "Reply"],
              ["a", "Reply all"],
              ["f", "Forward"],
              ["e", "Archive"],
              ["#", "Move to trash"],
              ["s", "Flag / unflag"],
              ["u", "Mark unread and close"],
              ["Esc", "Back to list"],
              ["?", "This help"],
            ] as const
          ).map(([k, label]) => (
            <div key={k} className="contents">
              <dt>
                <Kbd>{k}</Kbd>
              </dt>
              <dd className="text-navy-600 dark:text-navy-300">{label}</dd>
            </div>
          ))}
        </dl>
      </Dialog>

      {compose && (
        <Compose
          seed={compose}
          me={me}
          online={online}
          onClose={(changed) => {
            setCompose(null);
            if (changed) refresh();
          }}
        />
      )}
    </div>
  );
}
