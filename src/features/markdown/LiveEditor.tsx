import { useEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, placeholder as cmPlaceholder } from "@codemirror/view";
import { history, historyKeymap, defaultKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage, markdownKeymap } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { liveEditorTheme, liveHighlighting } from "./liveEditor/theme";
import { livePreview } from "./liveEditor/livePreview";

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
}

const identity = (src: string) => src;

export function LiveEditor({
  value,
  onChange,
  fontSize = 14,
  placeholder,
  readOnly = false,
  autoFocus = false,
  resolveImageSrc = identity,
  showCodeLineNumbers = false,
  showEditorLineNumbers = false,
}: LiveEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeCompartment = useRef(new Compartment());
  const previewCompartment = useRef(new Compartment());
  const editableCompartment = useRef(new Compartment());
  const lineNumbersCompartment = useRef(new Compartment());

  // Keep latest callbacks/values accessible from CodeMirror without rebuilding.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const resolveImageSrcRef = useRef(resolveImageSrc);
  resolveImageSrcRef.current = resolveImageSrc;
  const showCodeLineNumbersRef = useRef(showCodeLineNumbers);
  showCodeLineNumbersRef.current = showCodeLineNumbers;

  const makePreviewExtension = () =>
    livePreview({
      resolveImageSrc: (src) => resolveImageSrcRef.current(src),
      showCodeLineNumbers: showCodeLineNumbersRef.current,
    });

  // Create the editor once on mount.
  useEffect(() => {
    if (!hostRef.current) return;

    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          keymap.of([...markdownKeymap, indentWithTab, ...defaultKeymap, ...historyKeymap]),
          history(),
          lineNumbersCompartment.current.of(showEditorLineNumbers ? lineNumbers() : []),
          EditorView.lineWrapping,
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          liveHighlighting,
          themeCompartment.current.of(liveEditorTheme(fontSize)),
          previewCompartment.current.of(makePreviewExtension()),
          editableCompartment.current.of(EditorView.editable.of(!readOnly)),
          cmPlaceholder(placeholder ?? ""),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    viewRef.current = view;

    if (autoFocus) view.focus();

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Editor is created once; prop changes are handled by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync external value changes (e.g. switching notes) into the editor.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (value === current) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value]);

  // React to font-size changes.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartment.current.reconfigure(liveEditorTheme(fontSize)),
    });
  }, [fontSize]);

  // React to image-resolver or code-line-number changes (rebuild decorations).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: previewCompartment.current.reconfigure(makePreviewExtension()),
    });
    // makePreviewExtension reads the latest values via refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolveImageSrc, showCodeLineNumbers]);

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

  return <div ref={hostRef} className="cm-live-editor h-full overflow-hidden" />;
}
