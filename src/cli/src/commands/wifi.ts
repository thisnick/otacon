import { Command } from "commander";
import { getHostClient } from "../host-client.js";
import { printDetail } from "../format.js";

type ParentOpts = { host?: string; phone?: string; registry?: string };

interface WifiStatus {
  enabled: boolean;
  connected: boolean;
  ssid?: string | null;
  rssi?: number | null;
  desired_enabled: boolean;
}

async function wifiFetch(
  parentOpts: ParentOpts,
  init?: RequestInit
): Promise<Response> {
  const client = await getHostClient(parentOpts);
  const res = await fetch(`${client.baseUrl}/api/wifi`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(body || `HTTP ${res.status}`);
  }
  return res;
}

function printWifiStatus(status: WifiStatus, opts: { json?: boolean }): void {
  const observed = status.connected
    ? `connected${status.ssid ? `  ${status.ssid}` : ""}${status.rssi ? `  ${status.rssi} dBm` : ""}`
    : status.enabled ? "enabled" : "disabled";
  printDetail({
    desired: status.desired_enabled ? "on" : "off",
    observed,
    enabled: status.enabled,
    connected: status.connected,
    ssid: status.ssid,
    rssi: status.rssi,
  }, { json: opts.json });
}

async function setWifiEnabled(
  parentOpts: () => ParentOpts,
  enabled: boolean,
  opts: { json?: boolean }
): Promise<void> {
  const res = await wifiFetch(parentOpts(), {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  });
  printWifiStatus(await res.json() as WifiStatus, opts);
}

export function wifiCommands(parentOpts: () => ParentOpts): Command {
  const wifi = new Command("wifi").description("Wi-Fi control for the active phone");

  wifi
    .command("status")
    .description("Show host-local desired state and observed Wi-Fi status")
    .option("--json", "output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const res = await wifiFetch(parentOpts());
      printWifiStatus(await res.json() as WifiStatus, opts);
    });

  wifi
    .command("on")
    .description("Turn Wi-Fi on for the active phone")
    .option("--json", "output as JSON")
    .action(async (opts: { json?: boolean }) => {
      await setWifiEnabled(parentOpts, true, opts);
    });

  wifi
    .command("off")
    .description("Turn Wi-Fi off for the active phone")
    .option("--json", "output as JSON")
    .action(async (opts: { json?: boolean }) => {
      await setWifiEnabled(parentOpts, false, opts);
    });

  return wifi;
}
