/**
 * Lightweight table formatter for CLI list output.
 *
 * Use `printList(items, columns, opts)` to render either a column-aligned
 * table (default) or a JSON dump (when opts.json is true).
 */

export interface Column<T> {
  header: string;
  /** Function to extract the cell value from an item */
  get: (item: T) => string | number | null | undefined;
  /** Optional max width — truncates with ellipsis if exceeded */
  maxWidth?: number;
}

export interface PrintOptions {
  json?: boolean;
}

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

const tty = process.stdout.isTTY;

function color(s: string, code: string): string {
  return tty ? `${code}${s}${RESET}` : s;
}

/** Color status strings (connected/online = green, disconnected/offline = dim, unreachable = red, etc.) */
export function colorStatus(s: string): string {
  const lower = s.toLowerCase();
  if (lower === "connected" || lower === "online") return color(s, GREEN);
  if (lower === "unreachable" || lower === "offline" || lower === "lost") return color(s, RED);
  if (lower === "disconnected" || lower === "pending") return color(s, YELLOW);
  return s;
}

function fmt(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return color("-", DIM);
  return String(value);
}

function visibleLength(s: string): number {
  // Strip ANSI escape codes for width calculation
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function pad(s: string, width: number): string {
  const visible = visibleLength(s);
  if (visible >= width) return s;
  return s + " ".repeat(width - visible);
}

function truncate(s: string, max: number): string {
  if (visibleLength(s) <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/**
 * Print a list of items as a column-aligned table, or JSON if opts.json.
 * Column headers are bold (in TTY); cell values use the column's `get` function.
 * Empty/null cells render as a dim "-".
 */
export function printList<T>(
  items: T[],
  columns: Column<T>[],
  opts: PrintOptions = {}
): void {
  if (opts.json) {
    console.log(JSON.stringify(items, null, 2));
    return;
  }

  if (items.length === 0) {
    console.log(color("(no items)", DIM));
    return;
  }

  // Compute cells (apply truncation) and column widths
  const rows = items.map((item) =>
    columns.map((col) => {
      let cell = fmt(col.get(item));
      if (col.maxWidth) cell = truncate(cell, col.maxWidth);
      return cell;
    })
  );

  const widths = columns.map((col, i) => {
    const headerWidth = visibleLength(col.header);
    const dataWidth = Math.max(...rows.map((r) => visibleLength(r[i])));
    return Math.max(headerWidth, dataWidth);
  });

  // Header
  const header = columns.map((col, i) => color(pad(col.header, widths[i]), BOLD)).join("  ");
  console.log(header);

  // Rows
  for (const row of rows) {
    console.log(row.map((cell, i) => pad(cell, widths[i])).join("  "));
  }
}

/** Print a single record as a vertical key-value list (for `phone status` etc.) */
export function printDetail(record: Record<string, unknown>, opts: PrintOptions = {}): void {
  if (opts.json) {
    console.log(JSON.stringify(record, null, 2));
    return;
  }
  const keyWidth = Math.max(...Object.keys(record).map((k) => k.length));
  for (const [k, v] of Object.entries(record)) {
    const value =
      v === null || v === undefined || v === ""
        ? color("-", DIM)
        : typeof v === "object"
          ? JSON.stringify(v)
          : String(v);
    console.log(`${color(pad(k, keyWidth), BOLD)}  ${value}`);
  }
}
