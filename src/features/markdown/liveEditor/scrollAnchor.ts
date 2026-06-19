import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/**
 * Counter for the即时模式「点击弹射」(first-click-after-scroll viewport jump).
 *
 * Root cause (CM6, see codemirror/dev#1384): off-screen line heights are *estimated*
 * by a global HeightOracle. lineWrapping + a doc full of wrapped lines makes the
 * estimate wrong. The first click after scrolling forces a measure → the oracle
 * refreshes from the newly-measured visible lines → every off-screen estimate (incl.
 * above the viewport) shifts → CM6's own scroll-anchor correction (index.js:8178) does
 * `scrollTop += diff` to keep its near-top anchor in place, and that diff *is* the jump.
 *
 * Per-block `estimatedHeight` (CodeBlockWidget) only fixes the code-block share of the
 * error — prose paragraphs go through `Decoration.line`, which has no height-injection
 * hook, so they stay estimated and still jump. This extension fixes BOTH by anchoring
 * to the actual rendered DOM position of the click target, which is immune to the
 * height-map estimate of every other line.
 *
 * How: on mousedown we remember the mouse Y. Inside CM6's *own* measure cycle
 * (`requestMeasure`, so the correction lands before paint — no flash), we read the
 * cursor line's real screen position via `coordsAtPos` and nudge `scrollTop` so it
 * sits back at the mouse Y. The clicked text stays under the pointer; the off-screen
 * estimate correction is absorbed off-screen where it isn't visible.
 *
 * Honest bound: Marijn WONTFIX'd the sub-pixel "first click" residual, so a tiny
 * settle may remain. Needs real-machine WKWebView verification (see AGENTS.md §3 坑9).
 */
export function scrollAnchor(): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      // Only primary-button clicks.
      if (event.button !== 0) return;
      const anchorY = event.clientY;
      // Anchor to the click position itself (not the cursor) so we don't depend on when
      // CM6 commits the selection. Any visible reference works — the estimate-correction
      // shifts the whole viewport uniformly, so re-pinning one point re-pins all of it.
      const anchorPos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (anchorPos == null) return;
      view.requestMeasure({
        key: "live-scroll-anchor",
        read: () => view.coordsAtPos(anchorPos),
        write: (coords) => {
          if (!coords) return;
          const diff = coords.top - anchorY;
          // Ignore sub-pixel noise; cap pathological corrections defensively.
          if (Math.abs(diff) > 1 && Math.abs(diff) < view.scrollDOM.scrollHeight) {
            view.scrollDOM.scrollTop += diff;
          }
        },
      });
    },
  });
}
