/**
 * components/ui/Tooltip.jsx
 * ─────────────────────────
 * Reusable hover tooltip for terminal UI.
 * Pure CSS — no JS positioning library needed at this scale.
 *
 * Usage:
 *   <Tooltip text="Explain something">
 *     <span>hover me</span>
 *   </Tooltip>
 *
 * Props:
 *   text       — tooltip content (string or ReactNode)
 *   position   — "top" | "bottom" | "left" | "right"  (default: "top")
 *   maxWidth   — CSS max-width of tooltip box            (default: "220px")
 *   className  — extra class on wrapper
 */

import React from "react";

export default function Tooltip({
  text,
  position = "top",
  maxWidth = "220px",
  className = "",
  children,
}) {
  if (!text) return children;

  return (
    <span
      className={`tooltip-wrap tooltip-wrap--${position} ${className}`}
      data-tooltip-maxwidth={maxWidth}
    >
      {children}
      <span
        className="tooltip-box"
        style={{ maxWidth }}
        role="tooltip"
      >
        {text}
      </span>
    </span>
  );
}
