/**
 * components/ui/GlassCard.jsx
 * ───────────────────────────
 * Reusable glassmorphism card container.
 *
 * Provides the standard glass surface used throughout the dashboard:
 * semi-transparent dark background, backdrop blur, subtle border,
 * and soft drop shadow. Accepts an optional title and accent color.
 *
 * This is a pure presentational component — it accepts children and props,
 * has no state, makes no API calls, and reads no store values.
 *
 * @module components/ui/GlassCard
 */

import React from "react";

/**
 * GlassCard — Glassmorphism card container.
 *
 * @param {object}          props
 * @param {React.ReactNode} props.children    - Card body content.
 * @param {string}          [props.title]     - Optional header title text.
 * @param {string}          [props.className] - Additional CSS class names.
 * @param {string}          [props.accentColor] - CSS color for the top border accent line.
 * @param {object}          [props.style]     - Additional inline styles (use sparingly).
 * @returns {React.ReactElement}
 */
function GlassCard({ children, title, className = "", accentColor, style = {} }) {
  return (
    <div
      className={`glass-card ${className}`}
      style={{
        // Apply accent top border when accentColor provided
        borderTop: accentColor ? `1px solid ${accentColor}` : undefined,
        ...style,
      }}
    >
      {title && (
        <div className="glass-card__header">
          <span className="glass-card__title text-sm font-medium text-secondary">
            {title}
          </span>
          {accentColor && (
            <div
              className="glass-card__accent-dot"
              style={{ backgroundColor: accentColor }}
            />
          )}
        </div>
      )}
      <div className="glass-card__body">{children}</div>
    </div>
  );
}

export default GlassCard;
