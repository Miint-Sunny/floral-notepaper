import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { OutlineItem } from "../features/markdown/outline";

interface OutlinePanelProps {
  items: OutlineItem[];
  /** Slug of the heading to mark as active (currently in view), if any. */
  activeSlug?: string | null;
  onSelect: (item: OutlineItem) => void;
  /** 内容缩放倍率（仅缩放标题列表，不缩放滚动容器本身）。 */
  zoom?: number;
}

export function OutlinePanel({ items, activeSlug, onSelect, zoom = 1 }: OutlinePanelProps) {
  const { t } = useTranslation();
  const activeRef = useRef<HTMLButtonElement>(null);
  // 缩放放在滚动容器 <nav> 内部的这一层（不是 <nav> 的祖先——否则 WebKit 下原生滚动条会内缩）。
  // 只设 zoom、不动 width：实测 zoom 下 width:auto(100%) 正好填满 <nav>、内容随之放大、无横向溢出；
  // 若再写 width:100/zoom% 反而会把内容缩窄（== 之前"内缩"的真因）。
  const zoomStyle = zoom === 1 ? undefined : { zoom };

  // Keep the followed heading visible as the cursor/scroll moves through the doc.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeSlug]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center min-h-10 px-4 border-b border-paper-deep/20 shrink-0">
        <span className="text-[11px] font-medium text-ink-faint tracking-wide">
          {t("main.outline.title", { defaultValue: "大纲" })}
        </span>
      </div>

      {items.length === 0 ? (
        <div className="flex-1 flex items-center justify-center px-4 text-center text-[11px] text-ink-ghost/70">
          {t("main.outline.empty", { defaultValue: "暂无标题" })}
        </div>
      ) : (
        <nav className="flex-1 overflow-y-auto py-2">
          <div style={zoomStyle}>
            {items.map((item) => {
              const active = activeSlug != null && item.slug === activeSlug;
              return (
                <button
                  key={item.slug}
                  ref={active ? activeRef : undefined}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onSelect(item)}
                  title={item.text}
                  className={`w-full text-left truncate py-1 pr-3 text-[12px] font-body transition-colors cursor-pointer border-l-2 ${
                    active
                      ? "border-bamboo text-bamboo bg-bamboo-mist/40"
                      : "border-transparent text-ink-faint hover:text-bamboo hover:bg-bamboo-mist/30"
                  }`}
                  style={{ paddingLeft: `${0.75 + (item.level - 1) * 0.85}rem` }}
                >
                  {item.text}
                </button>
              );
            })}
          </div>
        </nav>
      )}
    </div>
  );
}
