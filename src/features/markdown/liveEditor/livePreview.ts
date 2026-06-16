import { StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import {
  BulletWidget,
  CheckboxWidget,
  HorizontalRuleWidget,
  ImageWidget,
  TableWidget,
} from "./widgets";

export interface LivePreviewOptions {
  /** Maps a markdown image src to a URL usable in an <img> tag. */
  resolveImageSrc: (src: string) => string;
  /** Show 1-based line numbers inside fenced code blocks. */
  showCodeLineNumbers?: boolean;
}

const LIST_LEVEL_INDENT_EM = 1.5;
const hideMark = Decoration.replace({});
const strong = Decoration.mark({ class: "cm-md-strong" });
const em = Decoration.mark({ class: "cm-md-em" });
const strike = Decoration.mark({ class: "cm-md-strike" });
const inlineCode = Decoration.mark({ class: "cm-md-inline-code" });
const linkText = Decoration.mark({ class: "cm-md-link" });
const fenceMark = Decoration.mark({ class: "cm-md-fence-mark" });
const quoteLine = Decoration.line({ class: "cm-md-quote" });
const tableSourceLine = Decoration.line({ class: "cm-md-table-source" });
const headingLine = [
  null,
  Decoration.line({ class: "cm-md-h1" }),
  Decoration.line({ class: "cm-md-h2" }),
  Decoration.line({ class: "cm-md-h3" }),
  Decoration.line({ class: "cm-md-h4" }),
  Decoration.line({ class: "cm-md-h5" }),
  Decoration.line({ class: "cm-md-h6" }),
];

function directChildren(node: SyntaxNode): Array<{ name: string; from: number; to: number }> {
  const out: Array<{ name: string; from: number; to: number }> = [];
  const cursor = node.cursor();
  if (cursor.firstChild()) {
    do {
      out.push({ name: cursor.name, from: cursor.from, to: cursor.to });
    } while (cursor.nextSibling());
  }
  return out;
}

function buildDecorations(state: EditorState, options: LivePreviewOptions): DecorationSet {
  const { doc } = state;
  if (doc.length === 0) return Decoration.none;
  const decorations: Array<Range<Decoration>> = [];

  // A construct is "active" (show raw source) when any selection range sits on
  // one of the lines it spans — the Typora / Obsidian active-line behaviour.
  const isActive = (from: number, to: number): boolean => {
    const startLine = doc.lineAt(from).number;
    const endLine = doc.lineAt(to).number;
    for (const range of state.selection.ranges) {
      const a = doc.lineAt(range.from).number;
      const b = doc.lineAt(range.to).number;
      if (a <= endLine && b >= startLine) return true;
    }
    return false;
  };

  const hideWithTrailingSpace = (from: number, to: number) => {
    let end = to;
    if (doc.sliceString(end, end + 1) === " ") end += 1;
    decorations.push(hideMark.range(from, end));
  };

  try {
    syntaxTree(state).iterate({
      enter: (nodeRef) => {
        const { name, from, to } = nodeRef;

        const headingMatch = /^ATXHeading(\d)$/.exec(name);
        if (headingMatch) {
          const level = Number(headingMatch[1]);
          decorations.push(headingLine[level]!.range(doc.lineAt(from).from));
          if (!isActive(from, to)) {
            for (const mark of directChildren(nodeRef.node)) {
              if (mark.name === "HeaderMark") hideWithTrailingSpace(mark.from, mark.to);
            }
          }
          return undefined;
        }

        if (name === "StrongEmphasis" || name === "Emphasis" || name === "Strikethrough") {
          const style = name === "StrongEmphasis" ? strong : name === "Emphasis" ? em : strike;
          decorations.push(style.range(from, to));
          if (!isActive(from, to)) {
            for (const mark of directChildren(nodeRef.node)) {
              if (mark.name === "EmphasisMark" || mark.name === "StrikethroughMark") {
                decorations.push(hideMark.range(mark.from, mark.to));
              }
            }
          }
          return undefined;
        }

        if (name === "InlineCode") {
          decorations.push(inlineCode.range(from, to));
          if (!isActive(from, to)) {
            for (const mark of directChildren(nodeRef.node)) {
              if (mark.name === "CodeMark") decorations.push(hideMark.range(mark.from, mark.to));
            }
          }
          return false;
        }

        if (name === "Link") {
          if (!isActive(from, to)) {
            const marks = directChildren(nodeRef.node).filter((k) => k.name === "LinkMark");
            if (marks.length >= 2) {
              const open = marks[0];
              const close = marks[1];
              if (close.from > open.to) decorations.push(linkText.range(open.to, close.from));
              decorations.push(hideMark.range(open.from, open.to));
              decorations.push(hideMark.range(close.from, to));
            }
          }
          return undefined;
        }

        if (name === "Image") {
          if (!isActive(from, to)) {
            const kids = directChildren(nodeRef.node);
            const urlNode = kids.find((k) => k.name === "URL");
            const marks = kids.filter((k) => k.name === "LinkMark");
            const alt = marks.length >= 2 ? doc.sliceString(marks[0].to, marks[1].from) : "";
            const src = urlNode ? doc.sliceString(urlNode.from, urlNode.to) : "";
            if (src) {
              decorations.push(
                Decoration.replace({
                  widget: new ImageWidget(src, alt, options.resolveImageSrc),
                }).range(from, to),
              );
              return false;
            }
          }
          return undefined;
        }

        if (name === "HorizontalRule") {
          if (!isActive(from, to)) {
            decorations.push(
              Decoration.replace({ widget: new HorizontalRuleWidget() }).range(from, to),
            );
          }
          return false;
        }

        if (name === "FencedCode") {
          const startLine = doc.lineAt(from).number;
          const endLine = doc.lineAt(to).number;
          for (let l = startLine; l <= endLine; l++) {
            const line = doc.line(l);
            const classes = ["cm-md-code-block"];
            if (l === startLine) classes.push("cm-md-code-block-first");
            if (l === endLine) classes.push("cm-md-code-block-last");
            decorations.push(Decoration.line({ class: classes.join(" ") }).range(line.from));
            // Number only the code content lines, not the ``` fence lines.
            if (options.showCodeLineNumbers && l > startLine && l < endLine) {
              decorations.push(
                Decoration.line({
                  class: "cm-md-code-content",
                  attributes: { "data-ln": String(l - startLine) },
                }).range(line.from),
              );
            }
          }
          return undefined;
        }

        if (
          (name === "CodeMark" || name === "CodeInfo") &&
          nodeRef.node.parent?.name === "FencedCode"
        ) {
          decorations.push(fenceMark.range(from, to));
          return undefined;
        }

        if (name === "Blockquote") {
          const startLine = doc.lineAt(from).number;
          const endLine = doc.lineAt(to).number;
          for (let l = startLine; l <= endLine; l++) {
            decorations.push(quoteLine.range(doc.line(l).from));
          }
          return undefined;
        }

        if (name === "QuoteMark") {
          // Always collapse the ">" marker (no active-line reveal) so the quote
          // reads as one continuous block and the text never shifts horizontally.
          hideWithTrailingSpace(from, to);
          return undefined;
        }

        if (name === "ListItem") {
          // Normalize indentation: collapse the source's leading whitespace and
          // re-apply a consistent per-depth indent with a hanging indent so
          // wrapped lines align under the text instead of the marker.
          const line = doc.lineAt(from);
          let depth = 0;
          for (let p = nodeRef.node.parent; p; p = p.parent) {
            if (p.name === "BulletList" || p.name === "OrderedList") depth += 1;
          }
          const lineText = doc.sliceString(line.from, line.to);
          const leading = lineText.length - lineText.trimStart().length;
          if (leading > 0) decorations.push(hideMark.range(line.from, line.from + leading));
          const markerEm = 1.4;
          const padLeft = Math.max(0, depth - 1) * LIST_LEVEL_INDENT_EM + markerEm;
          decorations.push(
            Decoration.line({
              attributes: { style: `padding-left:${padLeft}em;text-indent:-${markerEm}em;` },
            }).range(line.from),
          );
          return undefined;
        }

        if (name === "ListMark") {
          // Always render unordered markers as a round bullet (no active-line
          // reveal) so the line never jumps horizontally when the cursor enters.
          if (/^[-*+]$/.test(doc.sliceString(from, to))) {
            decorations.push(Decoration.replace({ widget: new BulletWidget() }).range(from, to));
          }
          return undefined;
        }

        if (name === "TaskMarker") {
          if (!isActive(from, to)) {
            const checked = /[xX]/.test(doc.sliceString(from, to));
            decorations.push(
              Decoration.replace({ widget: new CheckboxWidget(checked, from + 1) }).range(from, to),
            );
          }
          return false;
        }

        if (name === "Table") {
          const lineFrom = doc.lineAt(from).from;
          const lineTo = doc.lineAt(to).to;
          if (!isActive(lineFrom, lineTo)) {
            const source = doc.sliceString(lineFrom, lineTo);
            decorations.push(
              Decoration.replace({
                widget: new TableWidget(source, lineFrom),
                block: true,
              }).range(lineFrom, lineTo),
            );
            return false;
          }
          const startLine = doc.lineAt(from).number;
          const endLine = doc.lineAt(to).number;
          for (let l = startLine; l <= endLine; l++) {
            decorations.push(tableSourceLine.range(doc.line(l).from));
          }
          return undefined;
        }

        return undefined;
      },
    });
  } catch (error) {
    console.error("[liveEditor] failed to build decorations", error);
    return Decoration.none;
  }

  return Decoration.set(decorations, true);
}

export function livePreview(options: LivePreviewOptions): Extension {
  return StateField.define<DecorationSet>({
    create: (state) => buildDecorations(state, options),
    update: (value, tr) => {
      if (tr.docChanged || tr.selection) return buildDecorations(tr.state, options);
      return value;
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}
