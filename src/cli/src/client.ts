export interface ActionParams {
  action: string;
  [key: string]: unknown;
}

export interface DeviceInfo {
  activity: string | null;
  window: string | null;
  model: string | null;
  resolution: string | null;
}

export interface Notification {
  key: string;
  package: string;
  title: string | null;
  text: string | null;
  time: string | null;
}

export interface SmsThread {
  thread_id: number;
  address: string;
  snippet: string;
  date: string;
}

export interface SmsMessage {
  id: number;
  address: string;
  body: string;
  date: string;
  type: string;
}

export interface App {
  package: string;
  label: string | null;
}

export interface Contact {
  name: string;
  phones: string[];
}

export class OtaconClient {
  constructor(private baseUrl: string) {
    // Accept self-signed certs for Tailscale
    if (baseUrl.includes("otacon-")) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    }
  }

  async action(params: ActionParams): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        (body as Record<string, string>).error || `HTTP ${res.status}`
      );
    }
  }

  async screenshot(): Promise<Buffer> {
    const res = await fetch(`${this.baseUrl}/api/screenshot`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async snapshot(format: "text" | "json" = "text"): Promise<string | object> {
    const res = await fetch(
      `${this.baseUrl}/api/snapshot?format=${format}`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (format === "json") return res.json();
    return res.text();
  }

  async info(): Promise<DeviceInfo> {
    const res = await fetch(`${this.baseUrl}/api/info`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async notifications(): Promise<Notification[]> {
    const res = await fetch(`${this.baseUrl}/api/notifications`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async smsThreads(): Promise<SmsThread[]> {
    const res = await fetch(`${this.baseUrl}/api/sms/threads`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async smsMessages(threadId: number): Promise<SmsMessage[]> {
    const res = await fetch(
      `${this.baseUrl}/api/sms/threads/${threadId}/messages`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async smsSend(to: string, body: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/sms/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, body }),
    });
    if (!res.ok) {
      const respBody = await res.json().catch(() => ({}));
      throw new Error(
        (respBody as Record<string, string>).error || `HTTP ${res.status}`
      );
    }
  }

  async apps(): Promise<App[]> {
    const res = await fetch(`${this.baseUrl}/api/apps`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async appsRunning(): Promise<App[]> {
    const res = await fetch(`${this.baseUrl}/api/apps/running`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async appLaunch(pkg: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/apps/running`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ package: pkg }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        (body as Record<string, string>).error || `HTTP ${res.status}`
      );
    }
  }

  async appStop(pkg: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/api/apps/running/${encodeURIComponent(pkg)}`,
      { method: "DELETE" }
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        (body as Record<string, string>).error || `HTTP ${res.status}`
      );
    }
  }

  async contacts(query?: string): Promise<Contact[]> {
    const params = query ? `?q=${encodeURIComponent(query)}` : "";
    const res = await fetch(`${this.baseUrl}/api/contacts${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
}
