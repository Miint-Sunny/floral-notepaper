import { EditorView, WidgetType } from "@codemirror/view";

/** A round bullet replacing a `-` / `*` / `+` list marker. */
export class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-md-bullet";
    span.textContent = "•";
    return span;
  }
  ignoreEvent() {
    return true;
  }
}

/** A rendered horizontal rule replacing a `---` / `***` / `___` line. */
export class HorizontalRuleWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const hr = document.createElement("span");
    hr.className = "cm-md-hr";
    hr.setAttribute("aria-hidden", "true");
    return hr;
  }
  ignoreEvent() {
    return false;
  }
}

/** An interactive task-list checkbox. Toggling rewrites the source marker. */
export class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly pos: number,
  ) {
    super();
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.pos === this.pos;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.checked;
    box.className = "cm-md-task";
    box.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const next = this.checked ? " " : "x";
      view.dispatch({
        changes: { from: this.pos, to: this.pos + 1, insert: next },
      });
    });
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

/** Renders an inline image. `resolve` maps the markdown src to a usable URL. */
export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly resolve: (src: string) => string,
  ) {
    super();
  }
  eq(other: ImageWidget) {
    return other.src === this.src && other.alt === this.alt;
  }
  toDOM() {
    const img = document.createElement("img");
    img.src = this.resolve(this.src);
    img.alt = this.alt;
    img.loading = "lazy";
    img.className = "cm-md-image";
    return img;
  }
  ignoreEvent() {
    return true;
  }
}

interface TableModel {
  aligns: Array<"left" | "center" | "right" | null>;
  header: string[];
  rows: string[][];
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length) {
      current += ch + s[i + 1];
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseAlign(spec: string): "left" | "center" | "right" | null {
  const s = spec.trim();
  const left = s.startsWith(":");
  const right = s.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

export function parseTable(source: string): TableModel | null {
  const lines = source.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return null;
  const header = splitRow(lines[0]);
  const aligns = splitRow(lines[1]).map(parseAlign);
  const rows = lines.slice(2).map(splitRow);
  return { header, aligns, rows };
}

/** Renders a GFM pipe table. Clicking moves the cursor into the source. */
export class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly from: number,
  ) {
    super();
  }
  eq(other: TableWidget) {
    return other.source === this.source && other.from === this.from;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-table-wrap";
    const model = parseTable(this.source);
    if (!model) {
      wrap.textContent = this.source;
      return wrap;
    }
    const table = document.createElement("table");
    table.className = "cm-md-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    model.header.forEach((cell, i) => {
      const th = document.createElement("th");
      th.textContent = cell;
      const a = model.aligns[i];
      if (a) th.style.textAlign = a;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    model.rows.forEach((row) => {
      const tr = document.createElement("tr");
      model.header.forEach((_, i) => {
        const td = document.createElement("td");
        td.textContent = row[i] ?? "";
        const a = model.aligns[i];
        if (a) td.style.textAlign = a;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    wrap.addEventListener("mousedown", (event) => {
      event.preventDefault();
      view.dispatch({
        selection: { anchor: this.from },
        scrollIntoView: true,
      });
      view.focus();
    });
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}
