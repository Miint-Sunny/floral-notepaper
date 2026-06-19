import { LanguageDescription, type LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { StateEffect } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { highlightCode } from "@lezer/highlight";
import { liveHighlightStyle } from "./theme";

/**
 * Syntax highlighting for inactive code-block widgets (Option B). The main editor's
 * `syntaxHighlighting(liveHighlightStyle)` only colours code once its grammar has been
 * lazily loaded by `@codemirror/language-data`, and it colours the *editable* document —
 * a block-replace widget renders its own DOM, so it must run the highlighter itself.
 * Grammars load async; widgets render plain text first, then re-render once loaded.
 */

/** Dispatched when a grammar finishes loading so livePreview rebuilds the code widgets. */
export const codeLangLoaded = StateEffect.define<void>();

const loaded = new Map<string, LanguageSupport>();
const pending = new Set<string>();
const unavailable = new Set<string>();

function langKey(lang: string): string {
  return lang.trim().toLowerCase();
}

/** The grammar for `lang` if already loaded (synchronous), else undefined. */
export function getLoadedLanguage(lang: string): LanguageSupport | undefined {
  return loaded.get(langKey(lang));
}

/**
 * Kick off the async load of `lang`'s grammar if it isn't loaded/in-flight/unknown.
 * On success, dispatch `codeLangLoaded` so every inactive code-block widget rebuilds
 * and re-renders with colours. No-op when there is no matching grammar (e.g. mermaid).
 */
export function ensureLanguage(lang: string, view: EditorView): void {
  const key = langKey(lang);
  if (!key || loaded.has(key) || pending.has(key) || unavailable.has(key)) return;
  const desc = LanguageDescription.matchLanguageName(languages, key, true);
  if (!desc) {
    unavailable.add(key);
    return;
  }
  pending.add(key);
  void desc.load().then(
    (support) => {
      loaded.set(key, support);
      pending.delete(key);
      try {
        view.dispatch({ effects: codeLangLoaded.of() });
      } catch {
        // The view may have been destroyed before the grammar resolved — ignore.
      }
    },
    () => {
      pending.delete(key);
      unavailable.add(key);
    },
  );
}

export interface CodeToken {
  text: string;
  cls: string;
}

/**
 * Highlight `codeText` into per-line token lists, using the live `HighlightStyle`
 * (its generated classes are already injected into the document by `syntaxHighlighting`,
 * so applying them to the widget's spans yields the same colours as the editor).
 */
export function highlightCodeToLines(codeText: string, support: LanguageSupport): CodeToken[][] {
  const tree = support.language.parser.parse(codeText);
  const lines: CodeToken[][] = [[]];
  highlightCode(
    codeText,
    tree,
    liveHighlightStyle,
    (text, cls) => {
      lines[lines.length - 1]!.push({ text, cls });
    },
    () => {
      lines.push([]);
    },
  );
  return lines;
}
