import { lazy, Suspense, useEffect } from "react";
import "./App.css";
import { ContextMenuProvider } from "./components/ContextMenu";
import { MainWindow } from "./components/MainWindow";
import { ToastContainer } from "./components/Toast";

// 次要窗口（小窗/磁贴）按路由懒加载，避免主窗口启动时把它们（及其经 Tile 牵连的
// MarkdownPreview 重栈）一起 eager 进包。
const NotePad = lazy(() => import("./components/NotePad").then((m) => ({ default: m.NotePad })));
const TileShowcase = lazy(() =>
  import("./components/TileShowcase").then((m) => ({ default: m.TileShowcase })),
);
import { tabToIndentListener } from "indent-textarea";
import { getConfig } from "./features/settings/api";
import { applyTheme, watchSystemTheme } from "./features/settings/theme";
import type { AppConfig, ThemeOption } from "./features/settings/types";
import { notifyMainWindowReady } from "./features/windows/api";
import { getInitialRoute } from "./features/windows/windowRoutes";
import { syncLanguage } from "./locales";
import { listen } from "@tauri-apps/api/event";

function App() {
  const route = getInitialRoute();
  const activeView = route.view;

  useEffect(() => {
    let cleanup = () => {};
    getConfig()
      .then((config) => {
        const theme = (config.theme || "system") as ThemeOption;
        applyTheme(theme);
        cleanup = watchSystemTheme(theme);
        document.documentElement.style.setProperty(
          "--tab-indent-size",
          String(config.tabIndentSize ?? 2),
        );
        void syncLanguage(config.locale);
      })
      .catch(() => {});
    return () => cleanup();
  }, []);

  useEffect(() => {
    let themeCleanup = () => {};
    const unlisten = listen<AppConfig>("config-changed", (event) => {
      const theme = (event.payload.theme || "system") as ThemeOption;
      applyTheme(theme);
      themeCleanup();
      themeCleanup = watchSystemTheme(theme);
      document.documentElement.style.setProperty(
        "--tab-indent-size",
        String(event.payload.tabIndentSize ?? 2),
      );
      void syncLanguage(event.payload.locale);
    });
    return () => {
      themeCleanup();
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (activeView !== "main") return;
    // Reveal the (initially hidden) main window as soon as React has committed
    // its first render. The DOM is built and index.html has already painted the
    // themed background, so revealing now shows content with no white flash.
    //
    // Do NOT gate this on requestAnimationFrame: rAF is suspended while the
    // window is hidden, so its callback would never fire — the reveal would
    // deadlock and only happen via the slow safety timer (~3s = "奇慢"). useEffect
    // runs off React's scheduler (not the paint pipeline), so it fires promptly
    // even while hidden.
    void notifyMainWindowReady();
  }, [activeView]);

  useEffect(() => {
    const handleTab = (event: KeyboardEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLTextAreaElement)) return;
      if (target.dataset.tabIndent !== "true") return;
      tabToIndentListener(event);
    };
    window.addEventListener("keydown", handleTab, true);
    return () => window.removeEventListener("keydown", handleTab, true);
  }, []);

  useEffect(() => {
    const isWindows =
      navigator.userAgent.includes("Windows") || navigator.platform.toLowerCase().startsWith("win");
    if (!isWindows) return;

    const preventSystemMenu = (e: KeyboardEvent) => {
      if (e.altKey && e.code === "Space") {
        e.preventDefault();
      }
    };
    document.addEventListener("keydown", preventSystemMenu, true);
    return () => document.removeEventListener("keydown", preventSystemMenu, true);
  }, []);

  return (
    <ContextMenuProvider>
      <div className="app-window-shell h-screen font-body text-ink overflow-hidden">
        {activeView === "main" ? (
          <MainWindow />
        ) : (
          <Suspense fallback={null}>
            {activeView === "notepad" ? (
              <NotePad initialNoteId={route.noteId} />
            ) : (
              <TileShowcase noteId={route.noteId} />
            )}
          </Suspense>
        )}
        <ToastContainer />
      </div>
    </ContextMenuProvider>
  );
}

export default App;
