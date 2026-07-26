/**
 * components/ui/Spinner.jsx
 * ─────────────────────────
 * Loading spinner for chart initialization and data loading states.
 *
 * @module components/ui/Spinner
 */

import React from "react";

/**
 * Spinner — CSS animation loading indicator.
 *
 * @param {object} props
 * @param {string} [props.size="32px"]   - Width and height of the spinner.
 * @param {string} [props.label="Loading..."] - Accessible aria-label.
 * @returns {React.ReactElement}
 */
function Spinner({ size = "32px", label = "Loading..." }) {
  return (
    <div className="spinner-wrapper" role="status" aria-label={label}>
      <div
        className="spinner"
        style={{ width: size, height: size }}
      />
      <span className="sr-only">{label}</span>
    </div>
  );
}

export default Spinner;
