// Types derived from registry OpenAPI spec (components/schemas).
// Defined inline to avoid operationId conflicts in the generated types.

export interface Phone {
  id: string;
  adb_serial: string;
  phone_number?: string | null;
  model?: string | null;
  bt_mac?: string | null;
  imei?: string | null;
  adapter_mac?: string | null;
  host_id?: string | null;
  status: string;
  config: { wifi_enabled: boolean; bluetooth_enabled: boolean };
  connected_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Host {
  id: string;
  /** Network address (FQDN or IP) the CLI uses to reach this host. */
  address?: string | null;
  api_port: number;
  status: string;
  last_heartbeat?: string | null;
  created_at: string;
}

export interface Dongle {
  id: string;
  bt_mac: string;
  host_id?: string | null;
  phone_id?: string | null;
  hci_device?: string | null;
  status: string;
  created_at: string;
}

export interface PendingRegistration {
  id: string;
  host_id: string;
  hostname?: string | null;
  kind?: "host" | "client";
  status: "pending" | "approved" | "rejected";
  requested_at: string;
  resolved_at?: string | null;
}

export interface Token {
  id: string;
  scope: "node" | "admin";
  node_id?: string | null;
  token_prefix: string;
  created_at: string;
  last_seen_at?: string | null;
  expires_at?: string | null;
  revoked_at?: string | null;
  note?: string | null;
}

async function throwOnError(res: Response): Promise<void> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(body || `HTTP ${res.status}`);
  }
}

/**
 * Typed client for the otacon registry admin API.
 * All requests use bearer token auth.
 */
export class RegistryClient {
  constructor(
    private baseUrl: string,
    private token: string
  ) {}

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.token}`,
    };
  }

  // ── Fleet view ──────────────────────────────────────────────────

  async listPhones(): Promise<Phone[]> {
    const res = await fetch(`${this.baseUrl}/api/v1/admin/phones`, {
      headers: this.headers(),
    });
    await throwOnError(res);
    return res.json();
  }

  async getPhone(id: string): Promise<Record<string, unknown>> {
    const res = await fetch(
      `${this.baseUrl}/api/v1/admin/phones/${encodeURIComponent(id)}`,
      { headers: this.headers() }
    );
    await throwOnError(res);
    return res.json();
  }

  async deletePhone(id: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/api/v1/admin/phones/${encodeURIComponent(id)}`,
      { method: "DELETE", headers: this.headers() }
    );
    await throwOnError(res);
  }

  async listHosts(): Promise<Host[]> {
    const res = await fetch(`${this.baseUrl}/api/v1/admin/hosts`, {
      headers: this.headers(),
    });
    await throwOnError(res);
    return res.json();
  }

  async getHost(id: string): Promise<Host> {
    const res = await fetch(
      `${this.baseUrl}/api/v1/admin/hosts/${encodeURIComponent(id)}`,
      { headers: this.headers() }
    );
    await throwOnError(res);
    return res.json();
  }

  async deleteHost(id: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/api/v1/admin/hosts/${encodeURIComponent(id)}`,
      { method: "DELETE", headers: this.headers() }
    );
    await throwOnError(res);
  }

  async listDongles(): Promise<Dongle[]> {
    const res = await fetch(`${this.baseUrl}/api/v1/admin/dongles`, {
      headers: this.headers(),
    });
    await throwOnError(res);
    return res.json();
  }

  async deleteDongle(id: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/api/v1/admin/dongles/${encodeURIComponent(id)}`,
      { method: "DELETE", headers: this.headers() }
    );
    await throwOnError(res);
  }

  // ── Registration management ─────────────────────────────────────

  async listPendingHosts(): Promise<PendingRegistration[]> {
    const res = await fetch(`${this.baseUrl}/api/v1/admin/hosts/pending`, {
      headers: this.headers(),
    });
    await throwOnError(res);
    return res.json();
  }

  async listPendingClients(): Promise<PendingRegistration[]> {
    const res = await fetch(`${this.baseUrl}/api/v1/admin/clients/pending`, {
      headers: this.headers(),
    });
    await throwOnError(res);
    return res.json();
  }

  async approveHost(id: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/api/v1/admin/hosts/${encodeURIComponent(id)}/approve`,
      { method: "POST", headers: this.headers() }
    );
    await throwOnError(res);
  }

  async rejectHost(id: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/api/v1/admin/hosts/${encodeURIComponent(id)}/reject`,
      { method: "POST", headers: this.headers() }
    );
    await throwOnError(res);
  }

  async approveClient(id: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/api/v1/admin/clients/${encodeURIComponent(id)}/approve`,
      { method: "POST", headers: this.headers() }
    );
    await throwOnError(res);
  }

  async rejectClient(id: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/api/v1/admin/clients/${encodeURIComponent(id)}/reject`,
      { method: "POST", headers: this.headers() }
    );
    await throwOnError(res);
  }

  // ── Tokens ──────────────────────────────────────────────────────

  async listTokens(): Promise<Token[]> {
    const res = await fetch(`${this.baseUrl}/api/v1/admin/tokens`, {
      headers: this.headers(),
    });
    await throwOnError(res);
    return res.json();
  }

  async revokeToken(id: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/api/v1/admin/tokens/${encodeURIComponent(id)}/revoke`,
      { method: "POST", headers: this.headers() }
    );
    await throwOnError(res);
  }
}
