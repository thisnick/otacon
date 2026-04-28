/**
 * Shared command spec consumed by both the CLI binary and the orchestrator's
 * `otacon` defineCommand. Each spec implements one verb of the otacon CLI.
 */
import type { OtaconClient } from "../../client.js";

export type Env = Record<string, string | undefined>;

export interface CommandSpec {
  name: string;
  description: string;
  /** Usage string, e.g. "otacon tap <x> <y> | otacon tap <ref>" */
  usage: string;
  examples: string[];
  /**
   * If true, the command mutates phone state. When env.OTACON_TRACE_DIR is
   * set, the command captures an annotated screenshot before the action.
   */
  isMutating: boolean;
  /**
   * Run the command. Returns stdout text. Throw on error — the caller
   * (CLI binary or sandbox dispatcher) maps errors to stderr / exit codes.
   */
  run(args: string[], client: OtaconClient, env: Env): Promise<string>;
}
