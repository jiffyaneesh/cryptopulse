import React from "react";
import PanelFrame from "../layout/PanelFrame";
import useTickStore from "../../store/tickStore";

export default function OpenPositions({ activeCoin }) {
  const latest = useTickStore((state) => state.latestByCoins[activeCoin]);
  const currentPrice = latest ? latest.price_usd : 0;

  // Mock active positions matching trading terminal reference interface
  const positions = [
    {
      symbol: "BTC/USDT",
      type: "LONG",
      entry: 109850,
      current: activeCoin === "bitcoin" && currentPrice ? currentPrice : 110423,
      pnl: "+0.52%",
      isProfit: true,
    },
    {
      symbol: "ETH/USDT",
      type: "SHORT",
      entry: 3950,
      current: activeCoin === "ethereum" && currentPrice ? currentPrice : 3906,
      pnl: "+1.11%",
      isProfit: true,
    },
    {
      symbol: "SOL/USDT",
      type: "LONG",
      entry: 189.5,
      current: activeCoin === "solana" && currentPrice ? currentPrice : 187.3,
      pnl: "-1.16%",
      isProfit: false,
    },
  ];

  return (
    <PanelFrame title="OPEN POSITIONS" accentTitle="// ACTIVE SIGNALS" noPadding>
      <table className="positions-table">
        <thead>
          <tr>
            <th>PAIR</th>
            <th>TYPE</th>
            <th>ENTRY</th>
            <th>LAST</th>
            <th>P&L</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((pos, idx) => (
            <tr key={idx}>
              <td className="font-bold">{pos.symbol}</td>
              <td className={pos.type === "LONG" ? "text-profit" : "text-loss"}>{pos.type}</td>
              <td>${pos.entry.toLocaleString()}</td>
              <td>${pos.current.toLocaleString()}</td>
              <td className={pos.isProfit ? "text-profit font-bold" : "text-loss font-bold"}>
                {pos.pnl}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </PanelFrame>
  );
}
