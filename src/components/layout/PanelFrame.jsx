import React from "react";

/**
 * PanelFrame — Reusable Cyberpunk Terminal Container.
 *
 * @param {Object} props
 * @param {string} props.title - Panel header title.
 * @param {string} [props.accentTitle] - Highlighted portion of title.
 * @param {React.ReactNode} [props.headerRight] - Custom content on top right of panel header.
 * @param {React.ReactNode} props.children - Panel body content.
 * @param {string} [props.className] - Additional wrapper CSS class.
 * @param {boolean} [props.noPadding] - Disable body padding if true.
 */
export default function PanelFrame({
  title,
  accentTitle,
  headerRight,
  children,
  className = "",
  noPadding = false,
}) {
  return (
    <div className={`panel-frame ${className}`}>
      <div className="panel-frame__header">
        <div className="panel-frame__title">
          <span>{title}</span>
          {accentTitle && (
            <span className="panel-frame__title-accent">{accentTitle}</span>
          )}
        </div>
        {headerRight && <div>{headerRight}</div>}
      </div>
      <div className={`panel-frame__body ${noPadding ? "panel__body--no-pad" : ""}`}>
        {children}
      </div>
    </div>
  );
}
