/**
 * components/layout/ConnectionStatus.jsx
 * ───────────────────────────────────────
 * WebSocket connection status indicator for the Navbar.
 *
 * Displays three states with distinct visual treatments:
 *   - "connected":    Green animated dot + "Live" label.
 *   - "reconnecting": Amber spinning icon + reconnect attempt count.
 *   - "disconnected": Red static dot + "Offline" label.
 *
 * Reads status directly from Zustand store — no props needed.
 *
 * @module components/layout/ConnectionStatus
 */

import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import useTickStore from "../../store/tickStore";

/**
 * ConnectionStatus — WebSocket connection state badge.
 *
 * @returns {React.ReactElement}
 */
function ConnectionStatus() {
  const wsStatus = useTickStore((state) => state.wsStatus);
  const reconnectCount = useTickStore((state) => state.reconnectCount);

  const config = {
    connected: {
      label: "Live",
      dotClass: "status-dot status-dot--connected",
      textClass: "text-normal",
    },
    reconnecting: {
      label: `Reconnecting${reconnectCount > 0 ? ` #${reconnectCount}` : ""}`,
      dotClass: "status-dot status-dot--reconnecting animate-spin",
      textClass: "text-warning",
    },
    connecting: {
      label: "Connecting",
      dotClass: "status-dot status-dot--reconnecting animate-pulse-dot",
      textClass: "text-warning",
    },
    disconnected: {
      label: "Offline",
      dotClass: "status-dot status-dot--disconnected",
      textClass: "text-anomaly",
    },
  };

  const { label, dotClass, textClass } = config[wsStatus] || config.disconnected;

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={wsStatus}
        className="connection-status"
        initial={{ opacity: 0, x: 10 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: -10 }}
        transition={{ duration: 0.2 }}
      >
        <span className={dotClass} />
        <span className={`connection-status__label text-xs font-medium ${textClass}`}>
          {label}
        </span>
      </motion.div>
    </AnimatePresence>
  );
}

export default ConnectionStatus;
