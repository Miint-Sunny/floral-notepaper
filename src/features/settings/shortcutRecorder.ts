import { parseHotkey, type Hotkey } from "@tanstack/react-hotkeys";

export function hotkeyToConfigString(hotkey: Hotkey): string {
  const parsed = parseHotkey(hotkey, "windows");
  const parts: string[] = [];
  if (parsed.ctrl) parts.push("Ctrl");
  if (parsed.alt) parts.push("Alt");
  if (parsed.shift) parts.push("Shift");
  parts.push(parsed.key);
  return parts.join("+");
}

export function isValidGlobalShortcut(hotkey: Hotkey): boolean {
  const parsed = parseHotkey(hotkey, "windows");
  return parsed.ctrl || parsed.alt;
}
