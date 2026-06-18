import { useEffect, useRef, useState } from "react";

// 延迟加载 mermaid 库：它是预览里最重的依赖，原先在模块顶层 import + initialize，使整个
// （懒加载的）预览 chunk 一挂载就把 mermaid 拉进来、即便笔记里没有图表。改为只在真有
// ```mermaid 块、组件挂载时才动态 import 其独立 chunk 并初始化一次（promise 缓存复用）。
type MermaidApi = (typeof import("mermaid"))["default"];
let mermaidPromise: Promise<MermaidApi> | null = null;
function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid")
      .then((m) => {
        m.default.initialize({ startOnLoad: false, theme: "default", securityLevel: "loose" });
        return m.default;
      })
      .catch((error) => {
        // 失败不钉死缓存（rejected promise 会让之后的图表也拿到坏 promise）；清空让后续重试。
        // renderChart 的 try/catch 会落错误 UI + console.error，rejection 不会逸散。
        mermaidPromise = null;
        throw error;
      });
  }
  return mermaidPromise;
}

interface MermaidProps {
  chart: string;
}

export function Mermaid({ chart }: MermaidProps) {
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const containerId = useRef(`mermaid-${Math.random().toString(36).substring(2, 9)}`);

  useEffect(() => {
    let active = true;
    const renderChart = async () => {
      try {
        const mermaid = await loadMermaid();
        if (!active) return;
        const { svg: renderedSvg } = await mermaid.render(containerId.current, chart.trim());
        if (active) {
          setSvg(renderedSvg);
          setError(null);
        }
      } catch (err) {
        if (active) {
          console.error("Mermaid render error:", err);
          setError("Failed to render Mermaid chart");
        }
      }
    };

    void renderChart();

    return () => {
      active = false;
    };
  }, [chart]);

  if (error) {
    return (
      <div className="my-3 p-3 text-xs font-mono bg-red-100/10 text-red-500 rounded border border-red-500/20">
        <div>⚠️ {error}</div>
        <pre className="mt-2 text-[10px] overflow-x-auto whitespace-pre-wrap">{chart}</pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="my-3 p-4 bg-paper-warm/50 text-ink-ghost/60 rounded flex items-center justify-center font-mono text-xs animate-pulse">
        Rendering chart...
      </div>
    );
  }

  return (
    <div
      className="my-4 flex justify-center bg-paper-warm/20 rounded p-2 overflow-x-auto"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
