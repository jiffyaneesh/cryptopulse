import React from "react";
import PanelFrame from "../layout/PanelFrame";
import useTickStore from "../../store/tickStore";

export default function TradeLog({ activeCoin }) {
  const history = useTickStore((state) => state.tickHistory[activeCoin] || []);

  // Format tick items for the terminal stream log
  const logEntries = history.slice(-15).reverse().map((tick, idx) => {
    const date = new Date(tick.timestamp || Date.now());
    const timeStr = date.toTimeString().split(" ")[0];
    const isAnomaly = tick.is_anomaly;

    return {
      id: `${tick.timestamp}-${idx}`,
      time: timeStr,
      coin: (tick.symbol || activeCoin).toUpperCase(),
      msg: isAnomaly
        ? `🚨 ANOMALY DETECTED score=${(tick.anomaly_score || 0).toFixed(4)} price=$${tick.price_usd}`
        : `Tick processed score=${(tick.anomaly_score || 0).toFixed(4)} price=$${tick.price_usd}`,
      isAnomaly,
    };
  });

  return (
    <PanelFrame title="TRADE LOG" accentTitle="// LIVE STREAM" noPadding>
      <div className="trade-log">
        {logEntries.length === 0 ? (
          <div className="trade-log__row text-muted">Awaiting incoming telemetry ticks...</div>
        ) : (
          logEntries.map((log) => (
            <div key={log.id} className="trade-log__row">
              <span className="trade-log__time">{log.time}</span>
              <span className="trade-log__coin">{log.coin}</span>
              <span className={`trade-log__msg ${log.isAnomaly ? "trade-log__msg--anomaly" : ""}`}>
                {log.msg}
              </span>
            </div>
          ))
        )}
      </div>
    </PanelFrame>
  );
}
