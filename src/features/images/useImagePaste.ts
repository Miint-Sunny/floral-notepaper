import { useCallback, useRef } from "react";
import type { TFunction } from "i18next";
import { saveImage } from "./api";
import { imageExtensionFromFile } from "./insertImage";

export { imageExtensionFromFile };

const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

interface UseImagePasteOptions {
  noteId: string | null;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  setContent: (content: string) => void;
  markDirty: () => void;
  onEnsureNoteSaved: () => Promise<string | null>;
  disabled?: boolean;
  onError?: (message: string) => void;
  t?: TFunction;
}

async function processImageFile(file: File, noteId: string, t?: TFunction): Promise<string | null> {
  if (file.size > MAX_IMAGE_SIZE) {
    throw new Error(
      t?.("errors.imageTooLarge", { defaultValue: "图片文件过大（上限 20 MB）" }) ??
        "图片文件过大（上限 20 MB）",
    );
  }

  const ext = imageExtensionFromFile(file);
  if (!ext) return null;

  const buffer = await file.arrayBuffer();
  const data = Array.from(new Uint8Array(buffer));
  return saveImage(noteId, data, ext);
}

function isImageFile(file: Pick<File, "name" | "type">): boolean {
  return imageExtensionFromFile(file) !== null;
}

export function insertTextAtCursor(
  textarea: HTMLTextAreaElement,
  setContent: (value: string) => void,
  text: string,
) {
  const before = textarea.value.slice(0, textarea.selectionStart);
  const needsLeadingNewline = before.length > 0 && !before.endsWith("\n");
  const insertion = (needsLeadingNewline ? "\n" : "") + text + "\n";

  textarea.focus();
  document.execCommand("insertText", false, insertion);
  setContent(textarea.value);
}

export function getImageFiles(dataTransfer: DataTransfer): File[] {
  const files: File[] = [];
  const seen = new Set<File>();

  for (let i = 0; i < dataTransfer.items.length; i++) {
    const item = dataTransfer.items[i];
    if (item.kind !== "file") continue;

    const file = item.getAsFile();
    if (file && isImageFile(file)) {
      files.push(file);
      seen.add(file);
    }
  }

  for (let i = 0; i < dataTransfer.files.length; i++) {
    const file = dataTransfer.files[i];
    if (seen.has(file) || !isImageFile(file)) continue;
    files.push(file);
  }

  return files;
}

interface UseImageFileSaverOptions {
  noteId: string | null;
  onEnsureNoteSaved: () => Promise<string | null>;
  disabled?: boolean;
  onError?: (message: string) => void;
  t?: TFunction;
}

/**
 * Surface-agnostic image saver: saves the given image files to the note's `images/` store and
 * returns the markdown to insert (`![](images/…)` lines, joined by newlines), or `""` if nothing
 * was saved. Unlike `useImagePaste` (which is bound to a `<textarea>` and inserts via
 * `execCommand`), this leaves insertion to the caller — used by the CodeMirror live editor, which
 * inserts through a `dispatch`. Reuses the same save pipeline so behaviour matches edit mode.
 */
export function useImageFileSaver({
  noteId,
  onEnsureNoteSaved,
  disabled,
  onError,
  t,
}: UseImageFileSaverOptions) {
  const processingRef = useRef(false);

  return useCallback(
    async (files: File[]): Promise<string> => {
      if (disabled || processingRef.current || files.length === 0) return "";
      processingRef.current = true;
      try {
        let resolvedId = noteId;
        if (!resolvedId) {
          resolvedId = await onEnsureNoteSaved();
          if (!resolvedId) return "";
        }
        const markdownLines: string[] = [];
        for (const file of files) {
          const relativePath = await processImageFile(file, resolvedId, t);
          if (relativePath) markdownLines.push(`![](${relativePath})`);
        }
        return markdownLines.join("\n");
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : (t?.("errors.imagePasteFailed", { defaultValue: "图片粘贴失败" }) ?? "图片粘贴失败");
        onError?.(message);
        return "";
      } finally {
        processingRef.current = false;
      }
    },
    [noteId, onEnsureNoteSaved, disabled, onError, t],
  );
}

export function useImagePaste({
  noteId,
  textareaRef,
  setContent,
  markDirty,
  onEnsureNoteSaved,
  disabled,
  onError,
  t,
}: UseImagePasteOptions) {
  const processingRef = useRef(false);

  const processFiles = useCallback(
    async (files: File[]) => {
      if (processingRef.current || files.length === 0) return;
      processingRef.current = true;

      try {
        let resolvedId = noteId;
        if (!resolvedId) {
          resolvedId = await onEnsureNoteSaved();
          if (!resolvedId) return;
        }

        const textarea = textareaRef.current;
        if (!textarea) return;

        const markdownLines: string[] = [];
        for (const file of files) {
          const relativePath = await processImageFile(file, resolvedId, t);
          if (relativePath) {
            markdownLines.push(`![](${relativePath})`);
          }
        }

        if (markdownLines.length > 0) {
          insertTextAtCursor(textarea, setContent, markdownLines.join("\n"));
          markDirty();
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : (t?.("errors.imagePasteFailed", { defaultValue: "图片粘贴失败" }) ?? "图片粘贴失败");
        onError?.(message);
      } finally {
        processingRef.current = false;
      }
    },
    [noteId, textareaRef, setContent, markDirty, onEnsureNoteSaved, onError, t],
  );

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (disabled) return;
      const files = getImageFiles(event.clipboardData);
      if (files.length === 0) return;
      event.preventDefault();
      void processFiles(files);
    },
    [disabled, processFiles],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLTextAreaElement>) => {
      if (disabled) return;
      const files = getImageFiles(event.dataTransfer);
      if (files.length === 0) return;
      event.preventDefault();
      void processFiles(files);
    },
    [disabled, processFiles],
  );

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLTextAreaElement>) => {
      if (disabled) return;
      const hasImage =
        Array.from(event.dataTransfer.items).some((item) => {
          if (item.kind !== "file") return false;
          const file = item.getAsFile();
          return file ? isImageFile(file) : item.type in MIME_TO_EXT;
        }) || Array.from(event.dataTransfer.files).some(isImageFile);
      if (hasImage) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }
    },
    [disabled],
  );

  return { handlePaste, handleDrop, handleDragOver };
}
