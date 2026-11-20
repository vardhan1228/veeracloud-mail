import { useEffect, useRef, useState } from "react";
import { apiUrl } from "@havins/ui";

export type LiveState = "connecting" | "live" | "offline";

/**
 * Subscribes to /mail/events (server-sent events pushed from the mail server). Calls
 * `onChange` whenever the mailbox changes. EventSource reconnects by itself; while it is
 * down a slow poll keeps the view fresh.
 */
export function useLiveMail(onChange: () => void): LiveState {
  const [state, setState] = useState<LiveState>("connecting");
  const cb = useRef(onChange);
  cb.current = onChange;

  useEffect(() => {
    let source: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let closed = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const fire = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => cb.current(), 250);
    };

    const startPoll = () => {
      poll ??= setInterval(() => {
        if (navigator.onLine && document.visibilityState === "visible") cb.current();
      }, 60_000);
    };
    const stopPoll = () => {
      if (poll) clearInterval(poll);
      poll = null;
    };

    const connect = () => {
      if (closed || typeof EventSource === "undefined") {
        startPoll();
        setState("offline");
        return;
      }
      source = new EventSource(apiUrl("/mail/events"), { withCredentials: true });
      source.addEventListener("ready", () => {
        setState("live");
        stopPoll();
        // Catch anything that arrived while disconnected.
        fire();
      });
      source.addEventListener("change", fire);
      source.addEventListener("unavailable", () => setState("offline"));
      source.onerror = () => {
        setState(navigator.onLine ? "connecting" : "offline");
        startPoll();
      };
    };
    connect();

    const reconnect = () => {
      source?.close();
      connect();
    };
    window.addEventListener("online", reconnect);
    return () => {
      closed = true;
      source?.close();
      stopPoll();
      if (debounce) clearTimeout(debounce);
      window.removeEventListener("online", reconnect);
    };
  }, []);

  return state;
}

/** Shows "(3) Inbox · Company Mail" in the tab title. */
export function useUnreadTitle(unread: number, base: string) {
  useEffect(() => {
    document.title = unread > 0 ? `(${unread}) ${base}` : base;
  }, [unread, base]);
}

const NOTIFY_KEY = "webmail-notify";

export function notificationsEnabled(): boolean {
  try {
    return (
      typeof Notification !== "undefined" &&
      Notification.permission === "granted" &&
      localStorage.getItem(NOTIFY_KEY) !== "off"
    );
  } catch {
    return false;
  }
}

export async function setNotifications(on: boolean): Promise<boolean> {
  if (typeof Notification === "undefined") return false;
  try {
    localStorage.setItem(NOTIFY_KEY, on ? "on" : "off");
  } catch {
    // storage unavailable
  }
  if (!on) return false;
  if (Notification.permission === "granted") return true;
  return (await Notification.requestPermission()) === "granted";
}

/** Desktop notification when the inbox unread count goes up while the tab is in the background. */
export function useNewMailNotification(inboxUnread: number | undefined, onClick: () => void) {
  const prev = useRef<number | undefined>(undefined);
  useEffect(() => {
    const before = prev.current;
    prev.current = inboxUnread;
    if (before === undefined || inboxUnread === undefined || inboxUnread <= before) return;
    if (document.visibilityState === "visible" || !notificationsEnabled()) return;
    const n = new Notification("New mail", {
      body: `You have ${inboxUnread} unread message${inboxUnread === 1 ? "" : "s"}.`,
      icon: "/favicon.svg",
      tag: "new-mail",
    });
    n.onclick = () => {
      window.focus();
      onClick();
      n.close();
    };
  }, [inboxUnread, onClick]);
}
