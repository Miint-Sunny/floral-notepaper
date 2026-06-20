import { EditorView, type Rect, WidgetType } from "@codemirror/view";
import { foldEffect, foldedRanges, unfoldEffect } from "@codemirror/language";
import {
  type CodeToken,
  ensureLanguage,
  getLoadedLanguage,
  highlightCodeToLines,
} from "./codeHighlight";
import DOMPurify from "dompurify";

const COPY_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
const CHEVRON_UP =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg>';
const CHEVRON_DOWN =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';

function rangeFolded(view: EditorView, from: number, to: number): boolean {
  let folded = false;
  foldedRanges(view.state).between(from, to, () => {
    folded = true;
  });
  return folded;
}

export interface CodeToolbarOptions {
  lang: string;
  /** Range collapsed when folding (everything after the opening fence line). */
  foldFrom: number;
  foldTo: number;
  /** Code text used for the copy button. */
  codeFrom: number;
  codeTo: number;
  folded: boolean;
}

/**
 * Build the top-right code-block toolbar DOM (language · copy · fold/expand).
 * Shared by `CodeToolbarWidget` (active per-line render) and `CodeBlockWidget`
 * (inactive block-replace render) so the toolbar stays identical across both.
 */
export function buildCodeToolbar(view: EditorView, opts: CodeToolbarOptions): HTMLElement {
  const { lang, foldFrom, foldTo, codeFrom, codeTo, folded } = opts;
  const bar = document.createElement("div");
  bar.className = "cm-md-code-toolbar";
  bar.contentEditable = "false";
  bar.setAttribute("aria-hidden", "true");

  if (lang) {
    const el = document.createElement("span");
    el.className = "cm-md-code-lang";
    el.textContent = lang;
    bar.appendChild(el);
  }

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "cm-md-code-btn";
  copy.title = "复制";
  copy.innerHTML = COPY_ICON;
  copy.addEventListener("mousedown", (e) => e.preventDefault());
  copy.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const text = view.state.doc.sliceString(codeFrom, codeTo);
    void navigator.clipboard?.writeText(text).then(() => {
      copy.innerHTML = CHECK_ICON;
      copy.classList.add("is-copied");
      window.setTimeout(() => {
        copy.innerHTML = COPY_ICON;
        copy.classList.remove("is-copied");
      }, 1200);
    });
  });
  bar.appendChild(copy);

  const fold = document.createElement("button");
  fold.type = "button";
  fold.className = "cm-md-code-btn";
  fold.title = folded ? "展开" : "折叠";
  fold.innerHTML = folded ? CHEVRON_DOWN : CHEVRON_UP;
  fold.addEventListener("mousedown", (e) => e.preventDefault());
  fold.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (foldTo <= foldFrom) return;
    view.dispatch({
      effects: rangeFolded(view, foldFrom, foldTo)
        ? unfoldEffect.of({ from: foldFrom, to: foldTo })
        : foldEffect.of({ from: foldFrom, to: foldTo }),
    });
  });
  bar.appendChild(fold);

  return bar;
}

/**
 * Top-right toolbar on a fenced code block: language · copy · fold/expand.
 * `foldFrom..foldTo` is the range collapsed when folding (everything after the
 * opening fence line); `codeFrom..codeTo` is the code text used for copy.
 */
export class CodeToolbarWidget extends WidgetType {
  constructor(
    readonly lang: string,
    readonly foldFrom: number,
    readonly foldTo: number,
    readonly codeFrom: number,
    readonly codeTo: number,
    readonly folded: boolean,
  ) {
    super();
  }
  eq(other: CodeToolbarWidget) {
    return (
      other.lang === this.lang &&
      other.foldFrom === this.foldFrom &&
      other.foldTo === this.foldTo &&
      other.codeFrom === this.codeFrom &&
      other.codeTo === this.codeTo &&
      other.folded === this.folded
    );
  }
  toDOM(view: EditorView) {
    return buildCodeToolbar(view, {
      lang: this.lang,
      foldFrom: this.foldFrom,
      foldTo: this.foldTo,
      codeFrom: this.codeFrom,
      codeTo: this.codeTo,
      folded: this.folded,
    });
  }
  ignoreEvent() {
    return true;
  }
}

/** Measured code-block geometry, fed in so `estimatedHeight` is accurate off-screen. */
export interface CodeMetrics {
  /** px height of one code line (0.88em × editor line-height). */
  lineHeight: number;
  /** px width of one monospace char at the code font size (0.88em). */
  charWidth: number;
  /** px width usable for code text inside a block (content width − padding − ln gutter). */
  contentWidth: number;
}

function metricsEqual(a: CodeMetrics | null, b: CodeMetrics | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.lineHeight === b.lineHeight &&
    a.charWidth === b.charWidth &&
    a.contentWidth === b.contentWidth
  );
}

/**
 * An inactive (cursor-outside) fenced code block rendered as a block-replace widget.
 * Visually mirrors the active per-line source render (same monospace lines), but is a
 * single atomic block — which lets us hand CM6 an accurate `estimatedHeight` for the
 * off-screen height map. That is the root fix for the "first click after switch/scroll
 * jumps the viewport": CM6's global HeightOracle mis-estimates wrapped 0.88em code
 * lines, and the accumulated error releases on the first real measurement; an accurate
 * widget height removes the error. `mousedown` enters editing at the clicked line
 * (the StateField then re-renders that block as editable per-line source — swap-to-source).
 */
export class CodeBlockWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly from: number,
    readonly lang: string,
    readonly folded: boolean,
    readonly showLineNumbers: boolean,
    readonly codeWrap: boolean,
    readonly foldFrom: number,
    readonly foldTo: number,
    readonly codeFrom: number,
    readonly codeTo: number,
    readonly metrics: CodeMetrics | null,
  ) {
    super();
  }

  eq(other: CodeBlockWidget) {
    return (
      other.source === this.source &&
      other.from === this.from &&
      other.folded === this.folded &&
      other.showLineNumbers === this.showLineNumbers &&
      other.codeWrap === this.codeWrap &&
      metricsEqual(other.metrics, this.metrics)
    );
  }

  /** Visual line count incl. soft-wrap — drives estimatedHeight + swap-height parity. */
  private visualLineCount(): number {
    if (this.folded) return 1;
    const lines = this.source.split("\n");
    if (!this.codeWrap || !this.metrics || this.metrics.charWidth <= 0) return lines.length;
    const perRow = Math.max(1, Math.floor(this.metrics.contentWidth / this.metrics.charWidth));
    return lines.reduce((n, ln) => n + Math.max(1, Math.ceil(ln.length / perRow)), 0);
  }

  get estimatedHeight() {
    const lh = this.metrics?.lineHeight ?? 22;
    // Vertical padding mirrors .cm-md-code-block-first/last (0.3em top + 0.3em bottom).
    return this.visualLineCount() * lh + lh * 0.32;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-code-block-widget" + (this.codeWrap ? "" : " code-nowrap");
    wrap.setAttribute("contenteditable", "false");

    wrap.appendChild(
      buildCodeToolbar(view, {
        lang: this.lang,
        foldFrom: this.foldFrom,
        foldTo: this.foldTo,
        codeFrom: this.codeFrom,
        codeTo: this.codeTo,
        folded: this.folded,
      }),
    );

    const body = document.createElement("div");
    body.className = "cm-md-code-widget-body";
    const lines = this.source.split("\n");
    const lastIdx = lines.length - 1;

    // Syntax colours (Option B): if the grammar is loaded, colour the code content;
    // otherwise render plain text and kick off the async load (re-renders on completion).
    const support = this.lang && !this.folded ? getLoadedLanguage(this.lang) : undefined;
    let tokenLines: CodeToken[][] | null = null;
    if (support) {
      try {
        tokenLines = highlightCodeToLines(lines.slice(1, lastIdx).join("\n"), support);
      } catch {
        tokenLines = null;
      }
    }

    let offset = this.from;
    const shown = this.folded ? 1 : lines.length;
    for (let i = 0; i < shown; i++) {
      const text = lines[i];
      const row = document.createElement("div");
      row.className = "cm-md-code-widget-line";
      row.dataset.from = String(offset);
      const isFence = i === 0 || i === lastIdx;
      if (this.showLineNumbers && !isFence) {
        const ln = document.createElement("span");
        ln.className = "cm-md-code-widget-ln";
        ln.textContent = String(i);
        row.appendChild(ln);
      }
      const code = document.createElement("span");
      code.className = isFence ? "cm-md-code-widget-fence" : "cm-md-code-widget-code";
      const tokens = !isFence && tokenLines ? tokenLines[i - 1] : null;
      if (tokens && tokens.length) {
        for (const tok of tokens) {
          const span = document.createElement("span");
          if (tok.cls) span.className = tok.cls;
          span.textContent = tok.text;
          code.appendChild(span);
        }
      } else {
        // Zero-width space keeps empty lines at full line height.
        code.textContent = text.length ? text : "​";
      }
      row.appendChild(code);
      body.appendChild(row);
      offset += text.length + 1; // + newline
    }
    if (this.folded) {
      const more = document.createElement("span");
      more.className = "cm-md-fold-placeholder";
      more.textContent = "⋯";
      body.appendChild(more);
    }
    wrap.appendChild(body);

    if (!support && this.lang && !this.folded) ensureLanguage(this.lang, view);

    // Click → enter editing at the clicked line (swap the widget back to source).
    wrap.addEventListener("mousedown", (event) => {
      const target = event.target as HTMLElement;
      if (target.closest(".cm-md-code-toolbar")) return; // toolbar buttons handle themselves
      const row = target.closest(".cm-md-code-widget-line") as HTMLElement | null;
      const pos = row?.dataset.from ? Number(row.dataset.from) : this.from;
      event.preventDefault();
      // No scrollIntoView: the click target is already on-screen; scrolling it to the
      // viewport top is the "cursor jumps to first line" bug. The scroll-anchor extension
      // keeps the click point stable against CM6's height-estimate correction.
      view.dispatch({ selection: { anchor: pos } });
      view.focus();
    });

    return wrap;
  }

  /**
   * Map a doc position inside the block to its on-screen rect (the containing row's
   * vertical extent). Lets CM6 resolve cursor/scroll coordinates over the widget
   * instead of guessing, trimming the residual first-click jitter that an accurate
   * estimatedHeight alone leaves.
   */
  coordsAt(dom: HTMLElement, pos: number): Rect | null {
    const rows = dom.querySelectorAll<HTMLElement>(".cm-md-code-widget-line");
    let target: HTMLElement | null = null;
    for (const row of rows) {
      const f = Number(row.dataset.from);
      if (Number.isNaN(f)) continue;
      if (f <= pos) target = row;
      else break;
    }
    const el = target ?? rows[0] ?? dom;
    const rect = el.getBoundingClientRect();
    return { left: rect.left, right: rect.left, top: rect.top, bottom: rect.bottom };
  }

  ignoreEvent() {
    return false;
  }
}

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
      // No scrollIntoView (see CodeBlockWidget): the table is already on-screen; the
      // scroll-anchor extension keeps the click point stable.
      view.dispatch({ selection: { anchor: this.from } });
      view.focus();
    });
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

// ===== Raw HTML rendering (HTMLBlock / HTMLTag) — read-only, swap-to-source. =====

// Tags/attributes allowed when rendering raw HTML inside a live-preview widget: tables +
// inline formatting + images. DOMPurify strips <script>, event handlers and javascript: URLs.
const HTML_ALLOWED_TAGS = [
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "caption",
  "colgroup",
  "col",
  "img",
  "a",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "del",
  "ins",
  "mark",
  "sub",
  "sup",
  "br",
  "span",
  "div",
  "p",
  "code",
  "pre",
  "kbd",
  "samp",
  "small",
  "abbr",
  "center",
  "ul",
  "ol",
  "li",
  "hr",
  "blockquote",
  "details",
  "summary",
];
const HTML_ALLOWED_ATTR = [
  "href",
  "title",
  "src",
  "alt",
  "width",
  "height",
  "style",
  "align",
  "valign",
  "colspan",
  "rowspan",
  "scope",
  "class",
  "target",
  "rel",
  "open",
];

/**
 * Sanitizes a raw HTML fragment (DOMPurify) and resolves any `<img src>` through the same
 * resolver markdown images use, so vault-local paths load. Returns a fragment ready to append.
 */
function renderHtmlFragment(
  source: string,
  resolveImageSrc: (src: string) => string,
): DocumentFragment {
  const frag = DOMPurify.sanitize(source, {
    ALLOWED_TAGS: HTML_ALLOWED_TAGS,
    ALLOWED_ATTR: HTML_ALLOWED_ATTR,
    RETURN_DOM_FRAGMENT: true,
  });
  for (const img of frag.querySelectorAll("img")) {
    const raw = img.getAttribute("src");
    if (raw) img.setAttribute("src", resolveImageSrc(raw));
    img.loading = "lazy";
  }
  return frag;
}

/** Read-only render of a block-level raw HTML node (`<table>`, `<div>`, …). Click → edit source. */
export class HtmlBlockWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly from: number,
    readonly resolveImageSrc: (src: string) => string,
  ) {
    super();
  }
  eq(other: HtmlBlockWidget) {
    return other.source === this.source && other.from === this.from;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-html-block";
    wrap.appendChild(renderHtmlFragment(this.source, this.resolveImageSrc));
    // Read-only: clicking anywhere drops the cursor into the raw HTML source (swap-to-source),
    // mirroring TableWidget. No scrollIntoView — the block is already on-screen.
    wrap.addEventListener("mousedown", (event) => {
      event.preventDefault();
      view.dispatch({ selection: { anchor: this.from } });
      view.focus();
    });
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

/** Read-only render of an inline raw HTML node (`<img>`, `<span>`, …). */
export class HtmlInlineWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly resolveImageSrc: (src: string) => string,
  ) {
    super();
  }
  eq(other: HtmlInlineWidget) {
    return other.source === this.source;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-md-html-inline";
    span.appendChild(renderHtmlFragment(this.source, this.resolveImageSrc));
    return span;
  }
  ignoreEvent() {
    return true;
  }
}
