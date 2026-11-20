import { useState, type ReactNode } from "react";
import {
  AtSign,
  Globe,
  LayoutDashboard,
  LogOut,
  Menu,
  ScrollText,
  ShieldAlert,
  Users,
  X,
} from "lucide-react";
import {
  Alert,
  AuthScreen,
  Button,
  Card,
  Logo,
  Spinner,
  ThemeToggle,
  authErrorMessage,
  cx,
  navigate,
  resetPassword,
  sendVerification,
  signIn,
  signOut,
  useApi,
  useOnline,
  useRoute,
} from "@havins/ui";
import { Overview } from "./pages/Overview";
import { Domains } from "./pages/Domains";
import { Mailboxes } from "./pages/Mailboxes";
import { Aliases } from "./pages/Aliases";
import { AuditLog } from "./pages/AuditLog";

export interface Me {
  user: {
    id: string;
    email: string;
    displayName: string | null;
    emailVerified: boolean;
    role: "admin" | null;
  };
  mfaVerified: boolean;
}

const NAV = [
  { path: "/", label: "Overview", icon: LayoutDashboard },
  { path: "/mailboxes", label: "Employees", icon: Users },
  { path: "/aliases", label: "Aliases", icon: AtSign },
  { path: "/domains", label: "Domains", icon: Globe },
  { path: "/audit", label: "Audit log", icon: ScrollText },
] as const;

export function App() {
  const me = useApi<Me>("/auth/me");

  if (me.loading && !me.data) return <Spinner label="Loading admin console" />;
  if (me.error?.status === 401) {
    return <SignIn onSignedIn={me.reload} />;
  }
  if (me.error) {
    return (
      <Centered>
        <Alert tone="danger" title="Cannot load the admin console">
          {me.error.message}
        </Alert>
        <Button className="mt-4" variant="secondary" onClick={me.reload}>
          Try again
        </Button>
      </Centered>
    );
  }
  const data = me.data!;
  if (data.user.role !== "admin") {
    return (
      <Blocked
        title={data.user.emailVerified ? "Not an administrator" : "Verify your email first"}
        body={
          data.user.emailVerified
            ? `${data.user.email} is signed in but is not on the admin list. Ask the operator to add it to ADMIN_EMAILS.`
            : `Admin access needs a verified email. Send the verification email to ${data.user.email}, click the link in it, then sign out and back in.`
        }
        verify={!data.user.emailVerified}
      />
    );
  }
  return <Shell me={data} />;
}

function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  return (
    <AuthScreen
      heading="Admin console"
      subheading="Manage company mailboxes, domains and aliases."
      aside={
        <>
          <p className="font-display text-3xl font-extrabold leading-tight">
            Company mail, under your control.
          </p>
          <p className="mt-3 text-navy-200">
            Only administrators sign in here. Employees use webmail with their mailbox address and password.
          </p>
        </>
      }
      onSubmit={async (email, password, token) => {
        try {
          await signIn(email, password, token);
          onSignedIn();
        } catch (err) {
          throw new Error(authErrorMessage(err), { cause: err });
        }
      }}
      onReset={async (email) => {
        try {
          await resetPassword(email);
        } catch (err) {
          throw new Error(authErrorMessage(err), { cause: err });
        }
      }}
    />
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4">{children}</div>;
}

function Blocked({ title, body, verify }: { title: string; body: string; verify: boolean }) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  return (
    <Centered>
      <Card className="p-6">
        <ShieldAlert className="size-8 text-amber-500" aria-hidden="true" />
        <h1 className="mt-3 text-xl font-bold">{title}</h1>
        <p className="mt-2 text-sm text-navy-600 dark:text-navy-300">{body}</p>
        {sent && (
          <div className="mt-4">
            <Alert tone="info">{sent}</Alert>
          </div>
        )}
        {verify && (
          <Button
            className="mt-5 mr-2"
            onClick={async () => {
              try {
                await sendVerification();
                setSent("Verification email sent. Check your inbox (and spam).");
              } catch (err) {
                setSent(authErrorMessage(err));
              }
            }}
          >
            Send verification email
          </Button>
        )}
        <Button
          className="mt-5"
          variant="secondary"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            await signOut();
            window.location.reload();
          }}
        >
          Sign out
        </Button>
      </Card>
    </Centered>
  );
}

function Shell({ me }: { me: Me }) {
  const route = useRoute();
  const online = useOnline();
  const [menuOpen, setMenuOpen] = useState(false);
  const section = "/" + (route.split("/")[1] ?? "");
  const page = (() => {
    switch (section) {
      case "/mailboxes":
        return <Mailboxes />;
      case "/aliases":
        return <Aliases />;
      case "/domains":
        return <Domains />;
      case "/audit":
        return <AuditLog />;
      default:
        return <Overview />;
    }
  })();

  const nav = (
    <nav className="space-y-1" aria-label="Main">
      {NAV.map(({ path, label, icon: Icon }) => (
        <a
          key={path}
          href={`#${path}`}
          onClick={() => setMenuOpen(false)}
          aria-current={section === path ? "page" : undefined}
          className={cx(
            "flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition",
            section === path
              ? "bg-brand-500/10 text-brand-700 dark:bg-brand-400/15 dark:text-brand-200"
              : "text-navy-600 hover:bg-navy-100/70 dark:text-navy-300 dark:hover:bg-white/5",
          )}
        >
          <Icon className="size-4" aria-hidden="true" />
          {label}
        </a>
      ))}
    </nav>
  );

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[240px_1fr]">
      <aside className="hidden border-r border-navy-100 px-4 py-5 lg:flex lg:flex-col dark:border-white/10">
        <Logo />
        <div className="mt-8 flex-1">{nav}</div>
        <Account me={me} />
      </aside>

      <header className="flex items-center justify-between border-b border-navy-100 px-4 py-3 lg:hidden dark:border-white/10">
        <Logo />
        <Button variant="ghost" size="sm" aria-label="Open menu" onClick={() => setMenuOpen(true)}>
          <Menu className="size-5" />
        </Button>
      </header>
      {menuOpen && (
        <div className="fixed inset-0 z-40 bg-navy-950/50 lg:hidden" onClick={() => setMenuOpen(false)}>
          <div
            className="absolute inset-y-0 left-0 flex w-72 flex-col bg-white px-4 py-5 dark:bg-navy-900"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <Logo />
              <Button variant="ghost" size="sm" aria-label="Close menu" onClick={() => setMenuOpen(false)}>
                <X className="size-5" />
              </Button>
            </div>
            <div className="mt-6 flex-1">{nav}</div>
            <Account me={me} />
          </div>
        </div>
      )}

      <main className="min-w-0 px-4 py-6 sm:px-8">
        {!online && (
          <div className="mb-4">
            <Alert tone="warning" title="You are offline">
              Changes cannot be saved until your connection is back.
            </Alert>
          </div>
        )}
        {!me.mfaVerified && (
          <div className="mb-4">
            <Alert tone="warning" title="Development mode: no second factor">
              This session has no MFA. Production requires administrators to sign in with a second factor.
            </Alert>
          </div>
        )}
        {page}
      </main>
    </div>
  );
}

function Account({ me }: { me: Me }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="border-t border-navy-100 pt-4 dark:border-white/10">
      <p className="truncate text-sm font-medium">{me.user.displayName ?? me.user.email}</p>
      <p className="truncate text-xs text-navy-500 dark:text-navy-400">{me.user.email}</p>
      <div className="mt-3 flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            await signOut();
            navigate("/");
            window.location.reload();
          }}
        >
          <LogOut className="size-4" /> Sign out
        </Button>
        <ThemeToggle />
      </div>
    </div>
  );
}
