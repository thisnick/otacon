import type { CommandSpec } from "./types.js";
import { captureAnnotated, resolveRefToCoords } from "./_trace.js";

export const tap: CommandSpec = {
  name: "tap",
  description: "Tap at coordinates or an element ref.",
  usage: "otacon tap <x> <y> | otacon tap <ref>",
  examples: ["otacon tap 540 1200", "otacon tap e5"],
  isMutating: true,
  async run(args, client, env) {
    if (args.length === 0) throw new Error(`usage: ${this.usage}`);

    let coords: { x: number; y: number } | null = null;
    let ref: string | null = null;
    if (args.length === 1 && /^e\d+$/.test(args[0])) {
      ref = args[0];
    } else if (args.length >= 2) {
      const x = parseInt(args[0]);
      const y = parseInt(args[1]);
      if (isNaN(x) || isNaN(y)) throw new Error(`usage: ${this.usage}`);
      coords = { x, y };
    } else {
      throw new Error(`usage: ${this.usage}`);
    }

    if (env.OTACON_TRACE_DIR) {
      let annotation: { type: "tap"; x: number; y: number } | undefined;
      if (coords) annotation = { type: "tap", x: coords.x, y: coords.y };
      else if (ref) {
        const resolved = await resolveRefToCoords(client, ref);
        if (resolved) annotation = { type: "tap", x: resolved.x, y: resolved.y };
      }
      await captureAnnotated(env.OTACON_TRACE_DIR, {
        verb: "tap",
        args,
        annotation,
      }, client);
    }

    if (coords) {
      await client.action({ action: "tap", x: coords.x, y: coords.y } as any);
    } else if (ref) {
      await client.action({ action: "tap", ref } as any);
    }
    return `tapped ${args.join(" ")}`;
  },
};

export const longTap: CommandSpec = {
  name: "long-tap",
  description: "Long-tap (press and hold) at coordinates or an element ref.",
  usage: "otacon long-tap <x> <y> | otacon long-tap <ref>",
  examples: ["otacon long-tap 540 1200", "otacon long-tap e5"],
  isMutating: true,
  async run(args, client, env) {
    if (args.length === 0) throw new Error(`usage: ${this.usage}`);

    let coords: { x: number; y: number } | null = null;
    let ref: string | null = null;
    if (args.length === 1 && /^e\d+$/.test(args[0])) {
      ref = args[0];
    } else if (args.length >= 2) {
      const x = parseInt(args[0]);
      const y = parseInt(args[1]);
      if (isNaN(x) || isNaN(y)) throw new Error(`usage: ${this.usage}`);
      coords = { x, y };
    } else {
      throw new Error(`usage: ${this.usage}`);
    }

    if (env.OTACON_TRACE_DIR) {
      let annotation: { type: "tap"; x: number; y: number } | undefined;
      if (coords) annotation = { type: "tap", x: coords.x, y: coords.y };
      else if (ref) {
        const resolved = await resolveRefToCoords(client, ref);
        if (resolved) annotation = { type: "tap", x: resolved.x, y: resolved.y };
      }
      await captureAnnotated(env.OTACON_TRACE_DIR, {
        verb: "long-tap",
        args,
        annotation,
      }, client);
    }

    if (coords) {
      await client.action({ action: "long_tap", x: coords.x, y: coords.y } as any);
    } else if (ref) {
      await client.action({ action: "long_tap", ref } as any);
    }
    return `long-tapped ${args.join(" ")}`;
  },
};
