import { Command } from "commander";
import { getHostClient } from "../host-client.js";
import { printDetail, printList } from "../format.js";

type ParentOpts = { host?: string; phone?: string; registry?: string };

interface ApnOverride {
  id: number;
  entryName: string;
  apnName: string;
  operatorNumeric: string;
  types: string;
  protocol: string;
  roamingProtocol: string;
  authType: string;
  user?: string;
  mmsc?: string;
  mmsProxy?: string;
  mmsPort?: number;
  enabled: boolean;
}

interface ApnOptions {
  operator?: string;
  apn?: string;
  types?: string;
  protocol?: string;
  roamingProtocol?: string;
  authType?: string;
  user?: string;
  password?: string;
  mmsc?: string;
  mmsProxy?: string;
  mmsPort?: string;
  id?: string;
  json?: boolean;
}

async function apnsFetch(
  opts: ParentOpts,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const client = await getHostClient(opts);
  const url = `${client.baseUrl}/api/apns${path}`;
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(body || `HTTP ${res.status}`);
  }
  return res;
}

function apnBody(name: string | undefined, opts: ApnOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (name !== undefined) body.entryName = name;
  if (opts.apn !== undefined) body.apn = opts.apn;
  if (opts.operator !== undefined) body.operatorNumeric = opts.operator;
  if (opts.types !== undefined) body.types = withMmsTypeIfNeeded(opts.types, opts);
  if (opts.protocol !== undefined) body.protocol = opts.protocol;
  if (opts.roamingProtocol !== undefined) body.roamingProtocol = opts.roamingProtocol;
  if (opts.authType !== undefined) body.authType = opts.authType;
  if (opts.user !== undefined) body.user = opts.user;
  if (opts.password !== undefined) body.password = opts.password;
  if (opts.mmsc !== undefined) body.mmsc = opts.mmsc;
  if (opts.mmsProxy !== undefined) body.mmsProxy = opts.mmsProxy;
  if (opts.mmsPort !== undefined) body.mmsPort = parsePort(opts.mmsPort);
  return body;
}

function withMmsTypeIfNeeded(types: string, opts: ApnOptions): string {
  if (opts.mmsc === undefined && opts.mmsProxy === undefined && opts.mmsPort === undefined) {
    return types;
  }
  const parts = types.split(/[,|\s]+/).filter(Boolean);
  if (parts.some((part) => part.toLowerCase() === "mms")) {
    return types;
  }
  return [...parts, "mms"].join(",");
}

function normalizeOperator(value: string): string {
  return value.replace(/\D/g, "");
}

function parseId(id: string): number {
  const parsed = Number.parseInt(id, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid APN id: ${id}`);
  }
  return parsed;
}

function parsePort(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`invalid MMS port: ${value}`);
  }
  return parsed;
}

function addApnOptions(command: Command, includeDefaults: boolean): Command {
  const withOptions = command
    .option("--types <types>", "APN type list", includeDefaults ? "default,supl" : undefined)
    .option("--protocol <protocol>", "APN protocol", includeDefaults ? "ipv4v6" : undefined)
    .option(
      "--roaming-protocol <protocol>",
      "APN roaming protocol",
      includeDefaults ? "ipv4v6" : undefined
    )
    .option("--auth-type <type>", "APN auth type", includeDefaults ? "none" : undefined)
    .option("--user <user>", "APN username")
    .option("--password <password>", "APN password")
    .option("--mmsc <url>", "MMS center URL")
    .option("--mms-proxy <host>", "MMS proxy host or IP")
    .option("--mms-port <port>", "MMS proxy port")
    .option("--json", "output as JSON");
  return withOptions;
}

export function apnCommands(
  parentOpts: () => ParentOpts,
  name = "apns"
): Command {
  const apns = new Command(name).description("APN override management");

  apns
    .command("list")
    .description("List device-owner APN overrides")
    .option("--json", "output as JSON instead of a table")
    .action(async (opts: { json?: boolean }) => {
      const res = await apnsFetch(parentOpts(), "");
      const rows = (await res.json()) as ApnOverride[];
      printList(rows, [
        { header: "ID", get: (a) => a.id },
        { header: "NAME", get: (a) => a.entryName },
        { header: "APN", get: (a) => a.apnName },
        { header: "OPERATOR", get: (a) => a.operatorNumeric },
        { header: "TYPES", get: (a) => a.types },
        { header: "ENABLED", get: (a) => a.enabled ? "yes" : "no" },
        { header: "PROTOCOL", get: (a) => a.protocol },
        { header: "ROAMING", get: (a) => a.roamingProtocol },
        { header: "AUTH", get: (a) => a.authType },
        { header: "MMSC", get: (a) => a.mmsc ?? "" },
        { header: "MMS_PROXY", get: (a) => a.mmsProxy ?? "" },
        { header: "MMS_PORT", get: (a) => a.mmsPort ?? "" },
      ], { json: opts.json });
    });

  addApnOptions(
    apns
      .command("create")
      .description("Create an APN override")
      .argument("<name>", "human-readable APN name")
      .requiredOption("--operator <mccmnc>", "MCC+MNC operator numeric, e.g. 310240")
      .requiredOption("--apn <apn>", "APN name, e.g. stkmobi"),
    true
  ).action(async (name: string, opts: ApnOptions) => {
    const res = await apnsFetch(parentOpts(), "", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(apnBody(name, opts)),
    });
    printDetail(await res.json(), { json: opts.json });
  });

  addApnOptions(
    apns
      .command("update")
      .description("Update an APN override")
      .argument("<id>", "APN id from list/create")
      .option("--name <name>", "human-readable APN name")
      .option("--operator <mccmnc>", "MCC+MNC operator numeric")
      .option("--apn <apn>", "APN name"),
    false
  ).action(async (id: string, opts: ApnOptions & { name?: string }) => {
    const res = await apnsFetch(parentOpts(), `/${parseId(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(apnBody(opts.name, opts)),
    });
    printDetail(await res.json(), { json: opts.json });
  });

  addApnOptions(
    apns
      .command("upsert")
      .description("Create an APN override, or update an existing matching APN")
      .argument("<name>", "human-readable APN name")
      .requiredOption("--operator <mccmnc>", "MCC+MNC operator numeric, e.g. 310240")
      .requiredOption("--apn <apn>", "APN name, e.g. stkmobi")
      .option("--id <id>", "APN id to update instead of matching by operator+APN"),
    true
  ).action(async (name: string, opts: ApnOptions) => {
    let id = opts.id ? parseId(opts.id) : undefined;
    if (id === undefined) {
      const listRes = await apnsFetch(parentOpts(), "");
      const rows = (await listRes.json()) as ApnOverride[];
      const operator = normalizeOperator(opts.operator ?? "");
      id = rows.find((row) =>
        normalizeOperator(row.operatorNumeric) === operator && row.apnName === opts.apn
      )?.id;
    }

    const res = await apnsFetch(parentOpts(), id === undefined ? "" : `/${id}`, {
      method: id === undefined ? "POST" : "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(apnBody(name, opts)),
    });
    const payload = await res.json() as Record<string, unknown>;
    printDetail(opts.json ? payload : { action: id === undefined ? "created" : "updated", ...payload }, {
      json: opts.json,
    });
  });

  apns
    .command("delete")
    .description("Delete an APN override")
    .argument("<id>", "APN id from list/create")
    .option("--json", "output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const res = await apnsFetch(parentOpts(), `/${parseId(id)}`, { method: "DELETE" });
      printDetail(await res.json(), { json: opts.json });
    });

  apns
    .command("status")
    .description("Show whether override APNs are enabled")
    .option("--json", "output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const res = await apnsFetch(parentOpts(), "/enabled");
      printDetail(await res.json(), { json: opts.json });
    });

  apns
    .command("enable")
    .description("Enable override APNs on the phone")
    .option("--json", "output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const res = await apnsFetch(parentOpts(), "/enabled", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      printDetail(await res.json(), { json: opts.json });
    });

  apns
    .command("disable")
    .description("Disable override APNs on the phone")
    .option("--json", "output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const res = await apnsFetch(parentOpts(), "/enabled", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      printDetail(await res.json(), { json: opts.json });
    });

  return apns;
}
