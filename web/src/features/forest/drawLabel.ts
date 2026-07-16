/**
 * Custom node-label renderer for sigma. Replaces both the hover and
 * label draw paths so the hovered node gets a capsule that slides open
 * to the right, while other labels render as plain text.
 *
 * Plain-label alpha is the max of two continuous signals:
 *   - the hover fade (neighbour labels ramp in while hovering), and
 *   - the zoom fade (Obsidian's textAlpha curve — labels fade in as a
 *     continuous function of camera ratio, never a threshold pop).
 * Both getters are read per draw call, so the fades track their
 * sources frame-by-frame without any reducer re-runs.
 *
 * Questions: static hunger glyph "?" above the disc (no ambient pulse).
 *
 * All colors come from the canvas palette (tokens.css via
 * getComputedStyle) — nothing hardcoded here, so a token tweak
 * propagates to the canvas without touching this file.
 */

import { palette } from "./palette";

interface LabelData {
  label: string | null;
  x: number;
  y: number;
  size: number;
  color?: string;
  /** Set by the node reducer for the actively hovered node. */
  isHoveredNode?: boolean;
  nodeType?: string;
}

interface LabelSettings {
  labelSize: number;
  labelWeight?: string;
  labelFont: string;
}

/**
 * Build the draw function. Both getters are read per draw call: the
 * hover fade animation drives `getHoverProgress` 0..1 outside of
 * sigma's knowledge, and `getZoomLabelAlpha` derives 0..1 from the
 * live camera ratio.
 */
export function makeDrawNodeLabel(
  getHoverProgress: () => number,
  getZoomLabelAlpha: () => number = () => 0,
) {
  return (context: CanvasRenderingContext2D, data: LabelData, settings: LabelSettings) => {
    // Static question mark — scannable even when title label is hidden.
    if (data.nodeType === "question") {
      const glyphSize = Math.max(8, Math.min(13, data.size * 0.95));
      const [lr, lg, lb] = palette().labelRgb;
      const qAlpha = Math.max(0.55, getZoomLabelAlpha() * 0.4 + 0.55);
      context.save();
      context.font = `600 ${glyphSize}px system-ui, sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillStyle = `rgba(${lr},${lg},${lb},${qAlpha})`;
      context.fillText("?", data.x, data.y - data.size - glyphSize * 0.45);
      context.restore();
    }

    if (!data.label) return;
    const hoverBoost = getHoverProgress();
    const hoverAlpha = Math.max(0, (hoverBoost - 0.4) / 0.6);
    const labelAlpha = data.isHoveredNode
      ? hoverAlpha
      : Math.max(hoverAlpha, getZoomLabelAlpha());
    if (labelAlpha <= 0) return;

    const size = settings.labelSize;
    context.font = `${settings.labelWeight || "normal"} ${size}px ${settings.labelFont}`;

    if (data.isHoveredNode) {
      const textWidth = context.measureText(data.label).width;

      // 胶囊形状包住 Node 和 Label
      const padding = 6;
      const r = Math.max(data.size + 4, size / 2 + 4);
      const lcX = data.x; // 左侧圆心与节点同心
      const textStartX = data.x + data.size + padding;

      // 动画：向右平滑展开（为了让展开有冲刺的灵动感，使用开方 easing）
      const fullRcX = textStartX + textWidth;
      const expandProgress = Math.pow(labelAlpha, 0.5);
      const rcX = lcX + (fullRcX - lcX) * expandProgress;

      context.save();
      context.beginPath();
      // 画左半圆：从 90度（底）顺时针画到 -90度（顶），覆盖整个左侧
      context.arc(lcX, data.y, r, Math.PI / 2, -Math.PI / 2);
      context.lineTo(rcX, data.y - r);
      // 画右半圆：从 -90度（顶）顺时针画到 90度（底），覆盖整个右侧
      context.arc(rcX, data.y, r, -Math.PI / 2, Math.PI / 2);
      context.closePath();

      // 背景（canvasBg 玻璃态）
      const [bgR, bgG, bgB] = palette().canvasBgRgb;
      context.fillStyle = `rgba(${bgR}, ${bgG}, ${bgB}, ${labelAlpha * 0.95})`;
      context.fill();
      // 细边框（border）
      const [brR, brG, brB] = palette().borderRgb;
      context.lineWidth = 1;
      context.strokeStyle = `rgba(${brR}, ${brG}, ${brB}, ${labelAlpha})`;
      context.stroke();

      // 裁切后续绘制（含文字），实现“向右遮罩揭开”的抽出效果
      context.clip();

      // 文字（label）
      // 文字虽然一直画在原本最终的固定位置，但在展开过程中未达到的区域会被 mask 裁切掉
      const [lr, lg, lb] = palette().labelRgb;
      context.fillStyle = `rgba(${lr}, ${lg}, ${lb}, ${labelAlpha})`;
      context.fillText(data.label, textStartX, data.y + size / 3);

      context.restore();

      // 裁切区域释放后，重新在顶层画出高亮的节点实体，避免被沙色背景遮挡
      context.beginPath();
      context.arc(data.x, data.y, data.size, 0, Math.PI * 2);
      context.fillStyle = data.color || palette().dim;
      context.fill();
    } else {
      // Label text without a backdrop. Tracks --color-forest-canvas-label
      // via the palette so a token tweak doesn't desync this line.
      const [lr, lg, lb] = palette().labelRgb;
      context.fillStyle = `rgba(${lr}, ${lg}, ${lb}, ${labelAlpha})`;
      context.fillText(data.label, data.x + data.size + 3, data.y + size / 3);
    }
  };
}
