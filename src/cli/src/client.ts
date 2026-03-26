import type { components } from "./api-types.js";

// Re-export schema types for convenience
export type Action = components["schemas"]["Action"];
export type TapAction = components["schemas"]["TapAction"];
export type LongTapAction = components["schemas"]["LongTapAction"];
export type SwipeAction = components["schemas"]["SwipeAction"];
export type PinchAction = components["schemas"]["PinchAction"];
export type KeyAction = components["schemas"]["KeyAction"];
export type TypeAction = components["schemas"]["TypeAction"];
export type SetTextAction = components["schemas"]["SetTextAction"];
export type ScrollForwardAction = components["schemas"]["ScrollForwardAction"];
export type ScrollBackwardAction = components["schemas"]["ScrollBackwardAction"];
export type A11yNode = components["schemas"]["A11yNode"];
export type DeviceInfo = components["schemas"]["DeviceInfo"];
export type Notification = components["schemas"]["Notification"];
export type NotificationAction = components["schemas"]["NotificationAction"];
export type ClipboardContent = components["schemas"]["ClipboardContent"];
export type SmsThread = components["schemas"]["SmsThread"];
export type SmsMessage = components["schemas"]["SmsMessage"];
export type App = components["schemas"]["App"];
export type Contact = components["schemas"]["Contact"];

async function throwOnError(res: Response): Promise<void> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error || `HTTP ${res.status}`
    );
  }
}

export class OtaconClient {
  constructor(private baseUrl: string) {}

  async action(params: Action): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    await throwOnError(res);
  }

  async screenshot(): Promise<Buffer> {
    const res = await fetch(`${this.baseUrl}/api/screenshot`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async snapshot(format: "text"): Promise<string>;
  async snapshot(format: "json"): Promise<A11yNode[]>;
  async snapshot(format: "text" | "json" = "text"): Promise<string | A11yNode[]> {
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

  async notificationDismiss(key: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/api/notifications/${encodeURIComponent(key)}`,
      { method: "DELETE" }
    );
    await throwOnError(res);
  }

  async notificationAction(key: string, index: number): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/api/notifications/${encodeURIComponent(key)}/action/${index}`,
      { method: "POST" }
    );
    await throwOnError(res);
  }

  async clipboardGet(): Promise<ClipboardContent> {
    const res = await fetch(`${this.baseUrl}/api/clipboard`);
    await throwOnError(res);
    return res.json();
  }

  async clipboardSet(text: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/clipboard`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    await throwOnError(res);
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
    await throwOnError(res);
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
    await throwOnError(res);
  }

  async appStop(pkg: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/api/apps/running/${encodeURIComponent(pkg)}`,
      { method: "DELETE" }
    );
    await throwOnError(res);
  }

  async contacts(query?: string): Promise<Contact[]> {
    const params = query ? `?q=${encodeURIComponent(query)}` : "";
    const res = await fetch(`${this.baseUrl}/api/contacts${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async open(uri: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uri }),
    });
    await throwOnError(res);
  }
}
