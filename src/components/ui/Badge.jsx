/**
 * components/ui/Badge.jsx
 * ───────────────────────
 * Status badge for anomaly classification display.
 *
 * Two variants: 'anomaly' (red with pulse) and 'normal' (green).
 * Uses framer-motion for scale animation on mount and on variant change.
 *
 * @module components/ui/Badge
 */

import React from "react";
import { motion, AnimatePresence } from "framer-motion";

/**
 * Badge — Anomaly or Normal status indicator.
 *
 * @param {object} props
 * @param {"anomaly"|"normal"} props.variant - Visual variant.
 * @param {string} [props.label]             - Override text. Defaults to "ANOMALY" / "NORMAL".
 * @param {string} [props.className]         - Additional CSS classes.
 * @returns {React.ReactElement}
 */
function Badge({ variant = "normal", label, className = "" }) {
  const isAnomaly = variant === "anomaly";
  const displayLabel = label || (isAnomaly ? "ANOMALY" : "NORMAL");

  return (
    <AnimatePresence mode="wait">
      <motion.span
        key={variant}
        className={`badge badge--${variant} ${className}`}
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.8, opacity: 0 }}
        transition={{ duration: 0.2, type: "spring", stiffness: 400 }}
      >
        {/* Pulse dot for anomaly variant */}
        {isAnomaly && <span className="badge__pulse-dot" />}
        {displayLabel}
      </motion.span>
    </AnimatePresence>
  );
}

export default Badge;
