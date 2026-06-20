import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Annotation, Compartment, EditorState, type TransactionSpec } from "@codemirror/state";
import {
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
  placeholder as cmPlaceholder,
} from "@codemirror/view";
import { history, historyKeymap, defaultKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage, markdownKeymap } from "@codemirror/lang-markdown";
import { codeFolding } from "@codemirror/language";
import { languages } from "@codemirror/language-data";

const codeFoldingExtension = codeFolding({
  placeholderDOM(_view, onclick) {
    const el = document.createElement("span");
    el.className = "cm-md-fold-placeholder";
    el.textContent = "⋯";
    el.title = "展开";
    el.setAttribute("aria-label", "展开代码块");
    el.onclick = onclick;
    return el;
  },
});
import { liveEditorTheme, liveHighlighting } from "./liveEditor/theme";
import { livePreview, rebuildLivePreviewEffect } from "./liveEditor/livePreview";
import type { CodeMetrics } from "./liveEditor/widgets";

export interface LiveEditorProps {
  value: string;
  onChange: (value: string) => void;
  fontSize?: number;
  placeholder?: string;
  readOnly?: boolean;
  autoFocus?: boolean;
  resolveImageSrc?: (src: string) => string;
  showCodeLineNumbers?: boolean;
  showEditorLineNumbers?: boolean;
  activeHighlight?: "off" | "line" | "block" | "block-line";
  /** When false, fenced code blocks scroll horizontally instead of wrapping. */
  codeWrap?: boolean;
  /** Render raw HTML (HTMLBlock/HTMLTag) as sanitized read-only widgets — default off. */
  renderHtml?: boolean;
  /**
   * Identity of the document currently shown (e.g. note id / external file path).
   * Lets value-sync tell a *switch* (docKey changes → cursor may reset) apart from
   * an in-place *reload* of the same doc (docKey unchanged → preserve the cursor).
   */
  docKey?: string | number;
  /** Fired with the main cursor's 0-based line whenever it moves. */
  onCursorLine?: (line: number) => void;
  /**
   * Docs with ≤ this many lines render fully (CM6 virtualization off → no off-screen
   * height estimate → no click-fly). Larger docs virtualize. 0 disables full-render.
   */
  fullRenderMaxLines?: number;
  /**
   * Called when a full-render took longer than the budget, with the doc's line count,
   * so the host can lower + persist the threshold (reactive auto-downgrade / "熔断").
   */
  onSlowRender?: (atLines: number) => void;
}

export interface LiveEditorHandle {
  /** Scroll the given 1-based source line to the top of the viewport. */
  scrollToLine: (line: number) => void;
  /** The main cursor's current 0-based line. */
  getCursorLine: () => number;
}

const identity = (src: string) => src;

// 标记"把外部 value 同步进编辑器"的事务（切换笔记/外部文件时触发）。
// 这类事务不是用户编辑，updateListener 据此跳过 onChange，避免新载入的笔记被误标脏
// → 否则下一次切换会触发"保存"（外部文件会被无谓回写到磁盘、改 mtime）。
const externalSync = Annotation.define<boolean>();

// If a full-rendered doc takes longer than this to lay out, the host lowers + persists
// the threshold so a doc that size virtualizes next time ("熔断" / reactive auto-downgrade).
const SLOW_RENDER_BUDGET_MS = 250;

function countLines(text: string): number {
  let n = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  return n;
}

// The patched CM6 getViewport reads `__cmFullRender`: when true it renders the WHOLE doc
// (viewport = [0, doc.length]) so every line is laid out AND measured → the height map is
// real, never re-estimated → no estimate→real correction → no click-fly (the Typora/HyperMD
// "no virtualization" model). Docs above the line threshold keep normal virtualization.
function applyViewportMargin(lineCount: number, maxLines: number): void {
  (globalThis as { __cmFullRender?: boolean }).__cmFullRender =
    maxLines > 0 && lineCount <= maxLines;
}

// Measure code-block geometry from the live editor so inactive code-block widgets can
// report an accurate `estimatedHeight` (the root fix for the first-click viewport jump).
// Code is monospace at 0.88em with the editor's unitless 1.9 line-height, so one code
// line ≈ defaultLineHeight × 0.88; char width is probed directly (proportional → mono
// can't be scaled by a constant). Block padding is 1em L+R at the code size; the optional
// line-number gutter adds 3.2em.
function measureCodeMetrics(view: EditorView, showLineNumbers: boolean): CodeMetrics {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:absolute;visibility:hidden;left:-9999px;top:0;white-space:pre;margin:0;padding:0;" +
    "font-family:var(--font-mono);font-size:0.88em;line-height:1.9;";
  probe.textContent = "0".repeat(100);
  view.contentDOM.appendChild(probe);
  const rect = probe.getBoundingClientRect();
  const codeFontPx = parseFloat(getComputedStyle(probe).fontSize) || 12;
  view.contentDOM.removeChild(probe);

  const charWidth = rect.width / 100 || codeFontPx * 0.6;
  const lineHeight = rect.height || view.defaultLineHeight * 0.88;
  const horizPad = codeFontPx * 2;
  const lnGutter = showLineNumbers ? codeFontPx * 3.2 : 0;
  const contentWidth = Math.max(charWidth * 4, view.contentDOM.clientWidth - horizPad - lnGutter);
  return { lineHeight, charWidth, contentWidth };
}

export const LiveEditor = forwardRef<LiveEditorHandle, LiveEditorProps>(function LiveEditor(
  {
    value,
    onChange,
    fontSize = 14,
    placeholder,
    readOnly = false,
    autoFocus = false,
    resolveImageSrc = identity,
    showCodeLineNumbers = false,
    showEditorLineNumbers = false,
    activeHighlight = "off",
    codeWrap = true,
    renderHtml = false,
    docKey,
    onCursorLine,
    fullRenderMaxLines = 2000,
    onSlowRender,
  },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Tracks the docKey of the value currently in the editor (see value-sync below).
  const lastDocKeyRef = useRef(docKey);

  useImperativeHandle(
    ref,
    () => ({
      scrollToLine(line: number) {
        const view = viewRef.current;
        if (!view) return;
        const lineNumber = Math.min(Math.max(Math.trunc(line), 1), view.state.doc.lines);
        const pos = view.state.doc.line(lineNumber).from;
        view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "start" }) });
      },
      getCursorLine() {
        const view = viewRef.current;
        if (!view) return 0;
        return view.state.doc.lineAt(view.state.selection.main.head).number - 1;
      },
    }),
    [],
  );
  const themeCompartment = useRef(new Compartment());
  const previewCompartment = useRef(new Compartment());
  const editableCompartment = useRef(new Compartment());
  const lineNumbersCompartment = useRef(new Compartment());
  const activeLineCompartment = useRef(new Compartment());

  // Keep latest callbacks/values accessible from CodeMirror without rebuilding.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onCursorLineRef = useRef(onCursorLine);
  onCursorLineRef.current = onCursorLine;
  const resolveImageSrcRef = useRef(resolveImageSrc);
  resolveImageSrcRef.current = resolveImageSrc;
  const showCodeLineNumbersRef = useRef(showCodeLineNumbers);
  showCodeLineNumbersRef.current = showCodeLineNumbers;
  const activeHighlightRef = useRef(activeHighlight);
  activeHighlightRef.current = activeHighlight;
  const codeWrapRef = useRef(codeWrap);
  codeWrapRef.current = codeWrap;
  const renderHtmlRef = useRef(renderHtml);
  renderHtmlRef.current = renderHtml;
  const fullRenderMaxLinesRef = useRef(fullRenderMaxLines);
  fullRenderMaxLinesRef.current = fullRenderMaxLines;
  const onSlowRenderRef = useRef(onSlowRender);
  onSlowRenderRef.current = onSlowRender;
  // Latest measured code geometry (null until the view has mounted + been measured).
  const codeMetricsRef = useRef<CodeMetrics | null>(null);

  // Circuit breaker: if this doc was full-rendered and the layout took too long, tell the
  // host so it lowers + persists the threshold (next doc this size virtualizes instead).
  const reportIfSlow = (text: string, startedAt: number) => {
    const lines = countLines(text);
    if (lines <= 0 || lines > fullRenderMaxLinesRef.current) return; // wasn't full-rendered
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (performance.now() - startedAt > SLOW_RENDER_BUDGET_MS) {
          onSlowRenderRef.current?.(lines);
        }
      });
    });
  };

  const makePreviewExtension = () =>
    livePreview({
      resolveImageSrc: (src) => resolveImageSrcRef.current(src),
      showCodeLineNumbers: showCodeLineNumbersRef.current,
      activeBlock:
        activeHighlightRef.current === "block" || activeHighlightRef.current === "block-line",
      activeLineInBlock: activeHighlightRef.current === "block-line",
      codeWrap: codeWrapRef.current,
      codeMetrics: codeMetricsRef.current,
      renderHtml: renderHtmlRef.current,
      // Freeze decoration rebuilds while an IME composition is in progress (see livePreview).
      isComposing: () => viewRef.current?.composing ?? false,
    });

  // Re-measure code geometry and, if it changed, rebuild decorations so inactive
  // code-block widgets re-estimate their height. Called on mount, resize, font change.
  const applyCodeMetrics = () => {
    const view = viewRef.current;
    if (!view) return;
    const next = measureCodeMetrics(view, showCodeLineNumbersRef.current);
    const prev = codeMetricsRef.current;
    if (
      prev &&
      prev.lineHeight === next.lineHeight &&
      prev.charWidth === next.charWidth &&
      prev.contentWidth === next.contentWidth
    ) {
      return;
    }
    codeMetricsRef.current = next;
    view.dispatch({ effects: previewCompartment.current.reconfigure(makePreviewExtension()) });
  };

  // Create the editor once on mount.
  useEffect(() => {
    if (!hostRef.current) return;

    // Tell the patched CM6 getViewport whether to render this doc fully (no click-fly).
    applyViewportMargin(countLines(value), fullRenderMaxLines);
    const mountStart = performance.now();

    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          keymap.of([...markdownKeymap, indentWithTab, ...defaultKeymap, ...historyKeymap]),
          history(),
          lineNumbersCompartment.current.of(showEditorLineNumbers ? lineNumbers() : []),
          activeLineCompartment.current.of(activeHighlight === "line" ? highlightActiveLine() : []),
          EditorView.lineWrapping,
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          codeFoldingExtension,
          liveHighlighting,
          themeCompartment.current.of(liveEditorTheme(fontSize)),
          previewCompartment.current.of(makePreviewExtension()),
          editableCompartment.current.of(EditorView.editable.of(!readOnly)),
          cmPlaceholder(placeholder ?? ""),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              // 外部 value 同步（切换笔记/文件）不算用户编辑，不上报 onChange（不标脏）；
              // 真实键入、撤销/重做等不带此注解，照常上报。
              const isExternalSync = update.transactions.some((tr) => tr.annotation(externalSync));
              if (!isExternalSync) {
                onChangeRef.current(update.state.doc.toString());
              }
            }
            if (update.docChanged || update.selectionSet) {
              const head = update.state.selection.main.head;
              onCursorLineRef.current?.(update.state.doc.lineAt(head).number - 1);
            }
          }),
        ],
      }),
    });
    viewRef.current = view;

    if (autoFocus) view.focus();

    // Circuit breaker: if the initial full-render was slow, ask the host to back off.
    reportIfSlow(value, mountStart);

    // Root fix for the "click-fly": a plain pointer click must never scroll the viewport, but
    // CM6 dispatches the click's selection with scrollIntoView:true and its measure loop scrolls
    // to a stale (top-ish) cursor coord — deferred until heights settle, so any JS time-window /
    // scrollTop-pin loses the race. Instead we set `view._noClickScroll` on mousedown; the
    // patched CM6 measure() (see patches/@codemirror+view) drops BOTH scroll-write paths (the
    // pending scrollTarget AND the height-anchor correction) while it is set, no matter how many
    // measures later they fire. The guard is cleared on the next genuine wheel/keydown (so the
    // user can scroll/type and have the cursor revealed normally) with a fallback timeout so it
    // never sticks. (Diagnosed via a scrollTop-setter stack trace: writer was scrollIntoView
    // ←measure, NOT a height-estimate error — estimates are accurate after the CJK height patch.)
    const setNoClickScroll = (on: boolean) => {
      (view as unknown as { _noClickScroll?: boolean })._noClickScroll = on;
    };
    let clearTimer = 0;
    let pinTop = 0;
    let pinUntil = 0;
    let pinRaf = 0;
    const pinTick = () => {
      if (Date.now() >= pinUntil) {
        pinRaf = 0;
        return;
      }
      if (view.scrollDOM.scrollTop !== pinTop) view.scrollDOM.scrollTop = pinTop;
      pinRaf = requestAnimationFrame(pinTick);
    };
    const armSuppress = () => {
      if (view.composing) return; // never interfere with IME composition
      setNoClickScroll(true); // kernel guard: drop CM6's JS scroll paths (anchor + scrollTarget)
      // Freeze scrollTop at the click position for one short window to also catch the NATIVE
      // click-scroll teleport (WKWebView pulling the focused caret into view on click — goes
      // through no JS scroll path, so the kernel guard misses it). rAF restores before paint;
      // the `scroll` listener catches WKWebView's async-painted scroll. Native wheel resumes when
      // the window ends (300ms) or the user types (keydown).
      pinTop = view.scrollDOM.scrollTop;
      pinUntil = Date.now() + 300;
      if (!pinRaf) pinRaf = requestAnimationFrame(pinTick);
      window.clearTimeout(clearTimer);
      clearTimer = window.setTimeout(() => setNoClickScroll(false), 1500);
    };
    const endGuard = () => {
      window.clearTimeout(clearTimer);
      setNoClickScroll(false);
      pinUntil = 0;
    };
    const onScroll = () => {
      if (Date.now() < pinUntil && Math.abs(view.scrollDOM.scrollTop - pinTop) > 4) {
        view.scrollDOM.scrollTop = pinTop;
      }
    };
    // When an IME composition ends, rebuild decorations once for the just-composed text
    // (rebuilds were deferred during composition — see livePreview's isComposing gate).
    // Deferred a frame so CM6 applies the final composed-text transaction first.
    const onCompositionEnd = () => {
      requestAnimationFrame(() => {
        viewRef.current?.dispatch({ effects: rebuildLivePreviewEffect.of(null) });
      });
    };
    view.contentDOM.addEventListener("mousedown", armSuppress, true);
    view.scrollDOM.addEventListener("keydown", endGuard, true);
    view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
    view.contentDOM.addEventListener("compositionend", onCompositionEnd, true);

    // Measure code geometry once the view has laid out, then keep it current on resize
    // (window resize, sidebar/outline toggle, split-pane drag all change the wrap width).
    const rafId = requestAnimationFrame(() => applyCodeMetrics());
    let resizePending = false;
    const resizeObserver = new ResizeObserver(() => {
      if (resizePending) return;
      resizePending = true;
      requestAnimationFrame(() => {
        resizePending = false;
        applyCodeMetrics();
      });
    });
    resizeObserver.observe(view.scrollDOM);

    return () => {
      cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      view.contentDOM.removeEventListener("mousedown", armSuppress, true);
      view.scrollDOM.removeEventListener("keydown", endGuard, true);
      view.scrollDOM.removeEventListener("scroll", onScroll);
      view.contentDOM.removeEventListener("compositionend", onCompositionEnd, true);
      window.clearTimeout(clearTimer);
      if (pinRaf) cancelAnimationFrame(pinRaf);
      view.destroy();
      viewRef.current = null;
    };
    // Editor is created once; prop changes are handled by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync external value changes (switching notes / external-file reloads) into the editor.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    // 是否仍是同一篇文档（仅 value 变、docKey 未变）= 原地回读，需保留光标。
    const sameDoc = docKey !== undefined && docKey === lastDocKeyRef.current;
    lastDocKeyRef.current = docKey;

    const current = view.state.doc.toString();
    if (value === current) return;

    const spec: TransactionSpec = {
      changes: { from: 0, to: current.length, insert: value },
      annotations: externalSync.of(true),
    };
    // 原地回读（如外部文件 mtime 轮询、被别的程序改动后重载）整篇替换会丢光标 →
    // 保留并钳制原选区，避免光标乱跳。切换到另一篇（docKey 改变）则不保留、沿用归位行为。
    if (sameDoc) {
      const prev = view.state.selection.main;
      spec.selection = {
        anchor: Math.min(prev.anchor, value.length),
        head: Math.min(prev.head, value.length),
      };
    }
    // Decide full-render vs virtualize for the newly-loaded doc before it lays out.
    applyViewportMargin(countLines(value), fullRenderMaxLinesRef.current);
    const switchStart = performance.now();
    view.dispatch(spec);
    // Force CM6 to fully measure the just-loaded doc NOW (synchronously) instead of next frame:
    // `view.dispatch` only schedules an async rAF measure, so until then the new doc sits with an
    // ESTIMATED height map. The FIRST click would otherwise (a) trigger that deferred measure — a
    // visible scroll flicker — and (b) resolve through the off-screen-estimate path of
    // posAtCoords (imprecise → cursor snaps to the line start instead of the clicked column).
    // Reading coordsAtPos runs readMeasured() → measure() right here, settling the viewport so the
    // first post-switch click lands precisely with no scroll correction. Best-effort (try/catch
    // for empty / out-of-range head). Diagnosed via a multi-agent read of the CM6 pointer path.
    try {
      view.coordsAtPos(view.state.selection.main.head);
    } catch {
      /* empty doc or out-of-range head — settle is best-effort */
    }
    // Circuit breaker: measure the full-render cost of the newly-loaded doc.
    reportIfSlow(value, switchStart);
  }, [value, docKey]);

  // Re-evaluate the current doc when the threshold changes (slider / 熔断 auto-downgrade).
  useEffect(() => {
    applyViewportMargin(countLines(value), fullRenderMaxLines);
    viewRef.current?.requestMeasure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullRenderMaxLines]);

  // React to font-size changes.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartment.current.reconfigure(liveEditorTheme(fontSize)),
    });
    // Font size changes the code line height / char width → re-measure after relayout.
    requestAnimationFrame(() => applyCodeMetrics());
  }, [fontSize]);

  // React to image-resolver / code-line-number / highlight / code-wrap changes.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    // showCodeLineNumbers (gutter) and codeWrap change the usable code width → re-measure
    // into the ref first so the rebuilt widgets pick up the new metrics in one pass.
    codeMetricsRef.current = measureCodeMetrics(view, showCodeLineNumbersRef.current);
    view.dispatch({
      effects: previewCompartment.current.reconfigure(makePreviewExtension()),
    });
    // makePreviewExtension reads the latest values via refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolveImageSrc, showCodeLineNumbers, activeHighlight, codeWrap, renderHtml]);

  // React to read-only changes.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: editableCompartment.current.reconfigure(EditorView.editable.of(!readOnly)),
    });
  }, [readOnly]);

  // Toggle the whole-document line-number gutter.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: lineNumbersCompartment.current.reconfigure(
        showEditorLineNumbers ? lineNumbers() : [],
      ),
    });
  }, [showEditorLineNumbers]);

  // Toggle active-line highlighting (block highlighting is handled in livePreview).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: activeLineCompartment.current.reconfigure(
        activeHighlight === "line" ? highlightActiveLine() : [],
      ),
    });
  }, [activeHighlight]);

  return (
    <div
      ref={hostRef}
      className={`cm-live-editor h-full overflow-hidden ${codeWrap ? "" : "code-nowrap"}`}
    />
  );
});
