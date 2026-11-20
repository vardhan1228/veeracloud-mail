import { useState, type FormEvent } from "react";
import { Alert, ApiError, Button, Card, CardHeader, Field, Input, api, fieldError } from "@havins/ui";
import type { Me } from "./types";
import { notificationsEnabled, setNotifications } from "./live";

export function Settings({ me }: { me: Me }) {
  return (
    <div className="mx-auto max-w-xl space-y-6">
      <h1 className="text-2xl font-extrabold">Settings</h1>
      <Card>
        <CardHeader title="Account" />
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 p-5 text-sm">
          <dt className="text-navy-500">Name</dt>
          <dd>{me.displayName}</dd>
          <dt className="text-navy-500">Address</dt>
          <dd className="break-all">{me.address}</dd>
          <dt className="text-navy-500">Company</dt>
          <dd>{me.companyName}</dd>
        </dl>
        <p className="px-5 pb-5 text-xs text-navy-500 dark:text-navy-400">
          Ask your administrator to change your name or storage.
        </p>
      </Card>
      <Notifications />
      <ChangePassword />
    </div>
  );
}

function Notifications() {
  const supported = typeof Notification !== "undefined";
  const [on, setOn] = useState(notificationsEnabled);
  const [denied, setDenied] = useState(supported && Notification.permission === "denied");
  return (
    <Card>
      <CardHeader
        title="Desktop notifications"
        description="Get a notification when new mail arrives while this tab is in the background."
      />
      <div className="flex flex-wrap items-center gap-3 p-5">
        {!supported ? (
          <p className="text-sm text-navy-500">This browser does not support notifications.</p>
        ) : denied ? (
          <Alert tone="warning">
            Notifications are blocked for this site. Allow them in your browser's site settings.
          </Alert>
        ) : (
          <Button
            variant={on ? "secondary" : "primary"}
            onClick={async () => {
              const granted = await setNotifications(!on);
              setOn(granted);
              setDenied(Notification.permission === "denied");
            }}
          >
            {on ? "Turn off notifications" : "Turn on notifications"}
          </Button>
        )}
      </div>
    </Card>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    if (next !== confirmPw) {
      setError(new Error("The new passwords do not match."));
      return;
    }
    setBusy(true);
    try {
      await api("/mail/password", { method: "POST", body: { currentPassword: current, newPassword: next } });
      setCurrent("");
      setNext("");
      setConfirmPw("");
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const general =
    error instanceof ApiError
      ? error.details?.fieldErrors
        ? null
        : error.message
      : error instanceof Error
        ? error.message
        : null;

  return (
    <Card>
      <CardHeader
        title="Change password"
        description="This also changes the password your mail apps (phone, Outlook) use."
      />
      <form onSubmit={submit} className="space-y-4 p-5" noValidate>
        <Field label="Current password" error={fieldError(error, "currentPassword")}>
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          )}
        </Field>
        <Field
          label="New password"
          hint="At least 12 characters. A short sentence is easy to remember."
          error={fieldError(error, "newPassword")}
        >
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          )}
        </Field>
        <Field label="Confirm new password">
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="new-password"
              value={confirmPw}
              onChange={(e) => setConfirmPw(e.target.value)}
            />
          )}
        </Field>
        {general && <Alert tone="danger">{general}</Alert>}
        {done && <Alert tone="success">Password changed. Your other devices have been signed out.</Alert>}
        <Button type="submit" loading={busy}>
          Change password
        </Button>
      </form>
    </Card>
  );
}
