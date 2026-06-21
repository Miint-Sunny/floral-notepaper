/**
 * GFM pipe-table parse/serialize for the editable-table widget (Level B).
 *
 * Design (mirrors atomic-editor's whole-table-serialize approach, but preserves column
 * alignment, which atomic-editor discards):
 * - The model holds *display* text — escaped pipes (`\|`) are unescaped to literal `|`,
 *   so contenteditable cells show clean content.
 * - On edit, the whole table is re-serialized from the DOM and the table's source range is
 *   replaced. There is no per-cell offset mapping (deliberately — it is fragile).
 * - Serialization is canonical (`| a | b |`), so an *edit* reflows whitespace. Byte fidelity
 *   for "enter a cell and leave without typing" is achieved by the caller only serializing on
 *   an actual `input` event, never on focus/blur alone.
 *
 * These functions are pure and exhaustively unit-tested (tableModel.test.ts) because a bug
 * here would silently corrupt the user's markdown.
 */

export type TableAlign = "left" | "center" | "right" | null;

export interface TableModel {
  /** Header cell text, pipes unescaped for display. */
  header: string[];
  /** Per-column alignment, indexed to the separator row. */
  aligns: TableAlign[];
  /** Body rows of cell text, pipes unescaped for display. */
  rows: string[][];
}

const NEWLINE_RE = /\r?\n/g;
const BACKSLASH_RE = /\\/g;
const RAW_PIPE_RE = /\|/g;
// A separator cell is dashes with optional leading/trailing colon (e.g. `---`, `:--`, `:-:`).
const SEPARATOR_CELL_RE = /^:?-+:?$/;

/**
 * Raw markdown cell → display text. Reverses `escapeCell`: a backslash escapes the next
 * `\` or `|` (a literal `\\` → `\`, `\|` → `|`); a backslash before anything else is kept
 * verbatim (matches GFM, which only treats `\` as an escape before punctuation we emit).
 * Done as a single left-to-right scan so sequences like `\\\|` resolve correctly.
 */
export function unescapeCell(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "\\" && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (next === "\\" || next === "|") {
        out += next;
        i++;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/**
 * Display text → raw markdown cell. Collapses newlines, then escapes BOTH backslash and
 * pipe (`\` → `\\`, `|` → `\|`). Escaping backslash too is what makes the round-trip
 * lossless: without it a cell whose text is `\|` (literal backslash + pipe) would serialize
 * to `\\|`, which re-parses as an escaped backslash followed by a *delimiter* pipe — silently
 * splitting the cell. Backslash is escaped first so the `\` added for pipes is never doubled.
 */
export function escapeCell(text: string): string {
  return text.replace(NEWLINE_RE, " ").replace(BACKSLASH_RE, "\\\\").replace(RAW_PIPE_RE, "\\|");
}

/**
 * Split one table row into RAW cells, honoring `\|` escapes and stripping the outer pipes.
 * Escaped pipes stay attached to their cell; only unescaped `|` delimit columns.
 */
export function splitRawCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let buf = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length) {
      buf += ch + s[i + 1];
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  cells.push(buf.trim());
  return cells;
}

function parseAlign(spec: string): TableAlign {
  const s = spec.trim();
  const left = s.startsWith(":");
  const right = s.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

function alignToSpec(align: TableAlign): string {
  switch (align) {
    case "left":
      return ":---";
    case "center":
      return ":---:";
    case "right":
      return "---:";
    default:
      return "---";
  }
}

/**
 * Parse a GFM pipe-table source block into a `{header, aligns, rows}` model with cell text
 * unescaped for display. Returns null when the block is not a valid header+separator table.
 */
export function parseTableModel(source: string): TableModel | null {
  const lines = source.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return null;
  const sepCells = splitRawCells(lines[1]);
  if (sepCells.length === 0 || !sepCells.every((c) => SEPARATOR_CELL_RE.test(c))) {
    return null;
  }
  const header = splitRawCells(lines[0]).map(unescapeCell);
  const aligns = sepCells.map(parseAlign);
  const rows = lines.slice(2).map((l) => splitRawCells(l).map(unescapeCell));
  return { header, aligns, rows };
}

/**
 * Serialize a table model back to canonical GFM markdown, preserving column alignment.
 *
 * The column count is the MAXIMUM across header, separator and every body row — the table is
 * widened (padding shorter rows with empty cells) but **never truncated**. Truncating to the
 * header width would silently delete content from a ragged/overflowing row (an unescaped pipe,
 * an extra cell), which for a notes app is unacceptable file corruption. Widening keeps every
 * cell; the widget separately renders ambiguous tables read-only (see `isEditableTable`).
 */
export function serializeTable(model: TableModel): string {
  const cols = Math.max(
    1,
    model.header.length,
    model.aligns.length,
    ...model.rows.map((r) => r.length),
  );
  const cellAt = (arr: string[], c: number) => escapeCell(arr[c] ?? "");
  const lines: string[] = [];
  lines.push(
    "| " + Array.from({ length: cols }, (_, c) => cellAt(model.header, c)).join(" | ") + " |",
  );
  lines.push(
    "| " +
      Array.from({ length: cols }, (_, c) => alignToSpec(model.aligns[c] ?? null)).join(" | ") +
      " |",
  );
  for (const row of model.rows) {
    lines.push("| " + Array.from({ length: cols }, (_, c) => cellAt(row, c)).join(" | ") + " |");
  }
  return lines.join("\n");
}

/**
 * Whether a parsed table is unambiguous enough to render as an editable widget. The separator
 * must match the header width and no body row may OVERFLOW the header — an overflow row (e.g. an
 * unescaped pipe inside a cell, or a code span containing `|`) is structurally ambiguous and
 * would be reshaped on the first edit, so such tables fall back to read-only. Short rows are
 * fine (they just pad with empty cells).
 */
export function isEditableTable(model: TableModel): boolean {
  if (model.header.length === 0) return false;
  if (model.aligns.length !== model.header.length) return false;
  return model.rows.every((r) => r.length <= model.header.length);
}
