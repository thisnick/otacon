/**
 * Shared otacon command registry. Both the CLI binary and the orchestrator's
 * `otacon` defineCommand dispatch through this map.
 */
import type { CommandSpec } from "./types.js";
import { tap, longTap } from "./tap.js";
import { swipe } from "./swipe.js";
import { key } from "./key.js";
import { typeCmd } from "./type.js";
import { setText } from "./set-text.js";
import { scroll } from "./scroll.js";
import { screenshot } from "./screenshot.js";
import { snapshot } from "./snapshot.js";
import { info } from "./info.js";
import { apps } from "./apps.js";
import { sms } from "./sms.js";
import { call } from "./call.js";
import { clipboard } from "./clipboard.js";
import { contacts } from "./contacts.js";
import { notifications } from "./notifications.js";
import { open } from "./open.js";
import { record } from "./record.js";

export const otaconRegistry: Record<string, CommandSpec> = {
  tap,
  "long-tap": longTap,
  swipe,
  key,
  type: typeCmd,
  "set-text": setText,
  scroll,
  screenshot,
  snapshot,
  info,
  apps,
  sms,
  call,
  clipboard,
  contacts,
  notifications,
  open,
  record,
};

export type { CommandSpec, Env } from "./types.js";
