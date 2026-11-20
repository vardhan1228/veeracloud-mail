import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Paperclip, Send, X } from "lucide-react";
import {
  Alert,
  ApiError,
  Button,
  Dialog,
  Input,
  Kbd,
  Spinner,
  api,
  apiUpload,
  cx,
  fieldError,
  formatBytes,
  formatDateTime,
  useToast,
} from "@havins/ui";
import { formatAddress, type Attachment, type EmailAddress, type Me, type Message } from "./types";

export type ComposeSeed =
  | { mode: "new"; to?: string[] }
  | { mode: "reply" | "replyAll" | "forward"; message: Message }
  | { mode: "draft"; draftId: string };

interface Draft {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  attachments: Attachment[];
  inReplyToId?: string;
  draftId?: string;
}

const MAX_TOTAL = 25 * 1024 * 1024;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function prefix(p: string, subject: string) {
  return new RegExp(`^${p}:`, "i").test(subject) ? subject : `${p}: ${subject}`;
}

function quote(m: Message) {
  const body = (m.text ?? "")
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  return `\n\nOn ${formatDateTime(m.receivedAt)}, ${m.from.map(formatAddress).join(", ")} wrote:\n${body}`;
}

function initial(seed: ComposeSeed, me: Me): Draft {
  const empty: Draft = { to: [], cc: [], bcc: [], subject: "", text: "", attachments: [] };
  if (seed.mode === "new") return { ...empty, to: seed.to ?? [] };
  if (seed.mode === "draft") return empty;
  const m = seed.message;
  const self = me.address.toLowerCase();
  const emails = (xs: EmailAddress[]) => xs.map((x) => x.email.toLowerCase());
  if (seed.mode === "forward") {
    const header = `\n\n---------- Forwarded message ----------\nFrom: ${m.from.map(formatAddress).join(", ")}\nDate: ${formatDateTime(m.receivedAt)}\nSubject: ${m.subject}\nTo: ${m.to.map(formatAddress).join(", ")}\n\n`;
    return {
      ...empty,
      subject: prefix("Fwd", m.subject),
      text: header + (m.text ?? ""),
      attachments: m.attachments,
      inReplyToId: m.id,
    };
  }
  const replyTo = emails(m.replyTo.length ? m.replyTo : m.from);
  const to = replyTo.filter((e) => e !== self);
  const cc =
    seed.mode === "replyAll"
      ? [...new Set([...emails(m.to), ...emails(m.cc)])].filter((e) => e !== self && !to.includes(e))
      : [];
  return {
    ...empty,
    to: to.length ? to : replyTo,
    cc,
    subject: prefix("Re", m.subject),
    text: quote(m),
    inReplyToId: m.id,
  };
}

export function Compose({
  seed,
  me,
  online,
  onClose,
}: {
  seed: ComposeSeed;
  me: Me;
  online: boolean;
  onClose: (changed: boolean) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => initial(seed, me));
  const [loading, setLoading] = useState(seed.mode === "draft");
  const [dirty, setDirty] = useState(false);
  const [showCc, setShowCc] = useState(draft.cc.length > 0);
  const [busy, setBusy] = useState<"send" | "save" | null>(null);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savedOnce, setSavedOnce] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  // Opening a draft loads its full content.
  useEffect(() => {
    if (seed.mode !== "draft") return;
    api<{ message: Message }>(`/mail/messages/${encodeURIComponent(seed.draftId)}`).then(
      ({ message: m }) => {
        setDraft({
          to: m.to.map((x) => x.email),
          cc: m.cc.map((x) => x.email),
          bcc: [],
          subject: m.subject,
          text: m.text ?? "",
          attachments: m.attachments,
          draftId: m.id,
        });
        setShowCc(m.cc.length > 0);
        setLoading(false);
      },
      (err: unknown) => {
        setError(err);
        setLoading(false);
      },
    );
  }, [seed]);

  const update = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };

  const payload = () => ({
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    text: draft.text,
    attachments: draft.attachments,
    inReplyToId: draft.inReplyToId,
    draftId: draft.draftId,
  });

  async function send() {
    if (draft.to.length + draft.cc.length + draft.bcc.length === 0) {
      setError(new Error("Add at least one recipient."));
      return;
    }
    setBusy("send");
    setError(null);
    try {
      const result = await api<{ id: string; undelivered: string[] }>("/mail/send", {
        method: "POST",
        body: payload(),
      });
      if (result.undelivered.length > 0)
        toast.error(`Sent, but not delivered to: ${result.undelivered.join(", ")}`);
      else toast.success("Message sent");
      onClose(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  async function saveDraft() {
    setBusy("save");
    setError(null);
    try {
      const { id } = await api<{ id: string }>("/mail/drafts", { method: "POST", body: payload() });
      setDraft((d) => ({ ...d, draftId: id }));
      setDirty(false);
      setSavedOnce(true);
      setNotice("Draft saved.");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  async function addFiles(files: FileList | null) {
    if (!files) return;
    setError(null);
    let total = draft.attachments.reduce((n, a) => n + a.size, 0);
    for (const file of Array.from(files)) {
      if (total + file.size > MAX_TOTAL) {
        setError(new Error(`${file.name} would take attachments over 25 MB.`));
        break;
      }
      total += file.size;
      setUploading((n) => n + 1);
      try {
        const att = await apiUpload<Attachment>("/mail/attachments", file);
        setDraft((d) => ({ ...d, attachments: [...d.attachments, att] }));
        setDirty(true);
      } catch (err) {
        setError(err);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (fileRef.current) fileRef.current.value = "";
  }

  function close() {
    if (dirty && !confirm("Discard this message? Choose “Save draft” first to keep it.")) return;
    onClose(savedOnce);
  }

  const title = {
    new: "New message",
    reply: "Reply",
    replyAll: "Reply all",
    forward: "Forward",
    draft: "Draft",
  }[seed.mode];
  const generalError =
    error instanceof ApiError
      ? error.details?.fieldErrors
        ? (fieldError(error, "to") ?? fieldError(error, "attachments") ?? error.message)
        : error.message
      : error instanceof Error
        ? error.message
        : null;

  return (
    <Dialog open wide title={title} onClose={close}>
      {loading ? (
        <Spinner label="Loading draft" />
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && online && !busy && uploading === 0) {
              e.preventDefault();
              void send();
            }
          }}
        >
          <Recipients
            label="To"
            value={draft.to}
            onChange={(to) => update({ to })}
            autoFocus={seed.mode === "new" || seed.mode === "forward"}
          />
          {showCc ? (
            <>
              <Recipients label="Cc" value={draft.cc} onChange={(cc) => update({ cc })} />
              <Recipients label="Bcc" value={draft.bcc} onChange={(bcc) => update({ bcc })} />
            </>
          ) : (
            <button
              type="button"
              className="text-xs font-medium text-brand-600 dark:text-brand-300"
              onClick={() => setShowCc(true)}
            >
              Add Cc / Bcc
            </button>
          )}
          <Input
            aria-label="Subject"
            placeholder="Subject"
            value={draft.subject}
            onChange={(e) => update({ subject: e.target.value })}
          />
          <textarea
            aria-label="Message"
            value={draft.text}
            onChange={(e) => update({ text: e.target.value })}
            rows={12}
            autoFocus={seed.mode === "reply" || seed.mode === "replyAll"}
            onFocus={(e) => {
              if (seed.mode === "reply" || seed.mode === "replyAll") e.currentTarget.setSelectionRange(0, 0);
            }}
            className="w-full rounded-xl border border-navy-200 bg-white/90 p-3 text-sm focus:border-brand-500 focus:ring-4 focus:ring-brand-500/15 focus:outline-none dark:border-white/15 dark:bg-navy-950/60"
          />

          {(draft.attachments.length > 0 || uploading > 0) && (
            <ul className="flex flex-wrap gap-2">
              {draft.attachments.map((a) => (
                <li
                  key={a.blobId}
                  className="flex items-center gap-2 rounded-lg bg-navy-100/70 px-2.5 py-1 text-xs dark:bg-white/10"
                >
                  <span className="max-w-[12rem] truncate">{a.name}</span>
                  <span className="text-navy-500">{formatBytes(a.size)}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${a.name}`}
                    onClick={() =>
                      update({ attachments: draft.attachments.filter((x) => x.blobId !== a.blobId) })
                    }
                  >
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
              {uploading > 0 && <li className="px-2.5 py-1 text-xs text-navy-500">Uploading {uploading}…</li>}
            </ul>
          )}

          {!online && (
            <Alert tone="warning">You are offline. Your message stays here until you reconnect.</Alert>
          )}
          {generalError && <Alert tone="danger">{generalError}</Alert>}
          {notice && !dirty && <p className="text-xs text-emerald-600 dark:text-emerald-400">{notice}</p>}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="submit"
              loading={busy === "send"}
              disabled={!online || uploading > 0 || busy !== null}
            >
              <Send className="size-4" /> Send
            </Button>
            <Button
              type="button"
              variant="secondary"
              loading={busy === "save"}
              disabled={!online || uploading > 0 || busy !== null}
              onClick={saveDraft}
            >
              Save draft
            </Button>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={(e) => void addFiles(e.target.files)}
            />
            <Button
              type="button"
              variant="ghost"
              disabled={!online}
              onClick={() => fileRef.current?.click()}
              aria-label="Attach files"
            >
              <Paperclip className="size-4" /> Attach
            </Button>
            <span className="ml-auto hidden items-center gap-1 text-xs text-navy-500 sm:flex">
              <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd> to send
            </span>
            <Button type="button" variant="ghost" onClick={close}>
              Discard
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/** Address chips with autocomplete from the company directory and past correspondents. */
function Recipients({
  label,
  value,
  onChange,
  autoFocus,
}: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  const [suggestions, setSuggestions] = useState<EmailAddress[]>([]);
  const [active, setActive] = useState(0);
  const [invalid, setInvalid] = useState<string | null>(null);

  useEffect(() => {
    const q = text.trim();
    if (q.length < 1) {
      setSuggestions([]);
      return;
    }
    const t = setTimeout(() => {
      api<{ contacts: EmailAddress[] }>(`/mail/contacts?q=${encodeURIComponent(q)}`).then(
        (r) => {
          setSuggestions(r.contacts.filter((c) => !value.includes(c.email)));
          setActive(0);
        },
        () => setSuggestions([]),
      );
    }, 200);
    return () => clearTimeout(t);
  }, [text, value]);

  function commit(raw: string) {
    const parts = raw
      .split(/[,;\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const bad = parts.find((p) => !EMAIL.test(p));
    if (bad) {
      setInvalid(`"${bad}" is not a valid email address`);
      return false;
    }
    setInvalid(null);
    onChange([...new Set([...value, ...parts])]);
    setText("");
    setSuggestions([]);
    return true;
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" && suggestions.length) {
      e.preventDefault();
      setActive((a) => (a + 1) % suggestions.length);
    } else if (e.key === "ArrowUp" && suggestions.length) {
      e.preventDefault();
      setActive((a) => (a - 1 + suggestions.length) % suggestions.length);
    } else if ((e.key === "Enter" || e.key === "Tab") && suggestions[active]) {
      e.preventDefault();
      commit(suggestions[active].email);
    } else if ((e.key === "Enter" || e.key === "," || e.key === ";") && text.trim()) {
      e.preventDefault();
      commit(text);
    } else if (e.key === "Backspace" && !text && value.length) {
      onChange(value.slice(0, -1));
    }
  }

  return (
    <div className="relative">
      <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-xl border border-navy-200 bg-white/90 px-2 py-1.5 focus-within:border-brand-500 focus-within:ring-4 focus-within:ring-brand-500/15 dark:border-white/15 dark:bg-navy-950/60">
        <span className="px-1 text-xs font-medium text-navy-500">{label}</span>
        {value.map((email) => (
          <span
            key={email}
            className="flex items-center gap-1 rounded-lg bg-brand-500/10 px-2 py-0.5 text-xs text-brand-800 dark:text-brand-100"
          >
            {email}
            <button
              type="button"
              aria-label={`Remove ${email}`}
              onClick={() => onChange(value.filter((x) => x !== email))}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          aria-label={`${label} recipients`}
          value={text}
          autoFocus={autoFocus}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onBlur={() => {
            if (text.trim()) commit(text);
            setTimeout(() => setSuggestions([]), 150);
          }}
          className="min-w-[8rem] flex-1 bg-transparent py-0.5 text-sm outline-none"
          role="combobox"
          aria-expanded={suggestions.length > 0}
          aria-autocomplete="list"
        />
      </div>
      {invalid && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{invalid}</p>}
      {suggestions.length > 0 && (
        <ul
          role="listbox"
          className="absolute z-10 mt-1 w-full overflow-hidden rounded-xl border border-navy-100 bg-white shadow-lift dark:border-white/10 dark:bg-navy-900"
        >
          {suggestions.map((s, i) => (
            <li key={s.email} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(s.email);
                }}
                className={cx("block w-full px-3 py-2 text-left text-sm", i === active && "bg-brand-500/10")}
              >
                {s.name && <span className="font-medium">{s.name} </span>}
                <span className="text-navy-500">{s.email}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
