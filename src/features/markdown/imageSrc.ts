export type FileSrcConverter = (path: string) => string;

const NOTE_IMAGE_PREFIX = "images/";
// Remote / inline / already-converted sources are left untouched.
const REMOTE_RE = /^(https?:|data:|blob:|asset:|tauri:|ipc:)/i;
// POSIX absolute (`/…`) or Windows drive (`C:/…`) after backslash normalization.
const ABSOLUTE_RE = /^(\/|[a-zA-Z]:\/)/;

/**
 * Resolves a markdown/HTML image `src` to a URL the WebView can actually load.
 * - remote / data / blob / already-asset → unchanged;
 * - `file://` URL or absolute local path → Tauri asset protocol (`convertFileSrc`);
 * - relative path → resolved against `noteDir` (the note's own folder — for external
 *   files, this also covers `images/…` sitting next to the note); falling back to the
 *   app-managed `<dataDir>/images/…` store when there is no note folder.
 * The asset-protocol scope must allow the resolved directory (see lib.rs setup, which
 * allows the data dir + the user's home tree).
 */
export function resolveMarkdownImageSrc(
  src: string | undefined,
  imageBaseDir: string | undefined,
  convertFileSrc: FileSrcConverter,
  noteDir?: string,
): string {
  if (!src) {
    return "";
  }
  if (REMOTE_RE.test(src)) {
    return src;
  }

  const normalized = src.replace(/\\/g, "/");

  if (/^file:\/\//i.test(normalized)) {
    try {
      return convertFileSrc(decodeURIComponent(normalized.replace(/^file:\/\/+/i, "/")));
    } catch {
      return src;
    }
  }

  if (ABSOLUTE_RE.test(normalized)) {
    return convertFileSrc(normalized);
  }

  // Relative path. Prefer the note's own folder (external files); otherwise treat
  // `images/…` as the app-managed store under the data dir.
  if (noteDir) {
    return convertFileSrc(`${noteDir}/${normalized}`);
  }
  if (imageBaseDir && normalized.startsWith(NOTE_IMAGE_PREFIX)) {
    return convertFileSrc(`${imageBaseDir}/${normalized}`);
  }
  return src;
}
