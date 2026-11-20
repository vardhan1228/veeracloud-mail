import type { Store } from "@havins/database";
import { MockEmailProvider } from "./mock";
import { StalwartAdmin, type StalwartConfig } from "./stalwart/admin";
import { JmapClient } from "./stalwart/jmap";
import { ProviderNotConfiguredError, type EmailProvider, type MailAdmin, type MailClient } from "./types";

export interface ProviderConfig {
  environment: "development" | "preview" | "production";
  /** MAIL_PROVIDER var: "stalwart", "mock" (development/preview only) or "none". */
  provider: string | undefined;
  db: Store;
  stalwart?: Partial<StalwartConfig>;
}

export class StalwartProvider implements EmailProvider {
  readonly key = "stalwart";
  readonly isMock = false;
  readonly admin: MailAdmin;

  constructor(private readonly config: StalwartConfig) {
    this.admin = new StalwartAdmin(config);
  }

  authenticate(address: string, password: string): Promise<MailClient | null> {
    return JmapClient.connect(this.config.baseUrl, address, password, this.config.fetcher);
  }
}

/** Returns the configured provider, or throws ProviderNotConfiguredError ("setup required"). */
export function createEmailProvider(config: ProviderConfig): EmailProvider {
  const key = (config.provider ?? "").trim().toLowerCase();
  if (key === "" || key === "none") throw new ProviderNotConfiguredError();
  if (key === "mock") {
    if (config.environment === "production") {
      throw new ProviderNotConfiguredError("The mock mail server cannot be used in production");
    }
    return new MockEmailProvider(config.db);
  }
  if (key === "stalwart") {
    const s = config.stalwart ?? {};
    if (!s.baseUrl || !s.adminUser || !s.adminPassword) {
      throw new ProviderNotConfiguredError(
        "Stalwart is selected but STALWART_URL / admin credentials are missing",
      );
    }
    const url = new URL(s.baseUrl);
    if (config.environment === "production" && url.protocol !== "https:") {
      throw new ProviderNotConfiguredError("STALWART_URL must use https in production");
    }
    return new StalwartProvider({
      baseUrl: s.baseUrl,
      adminUser: s.adminUser,
      adminPassword: s.adminPassword,
      fetcher: s.fetcher,
    });
  }
  throw new ProviderNotConfiguredError(`Unknown mail provider "${key}"`);
}
