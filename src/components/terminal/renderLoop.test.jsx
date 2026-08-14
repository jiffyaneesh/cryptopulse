/**
 * Regression guard for React error #185 (max update depth exceeded).
 *
 * Zustand v5 compares selector output with Object.is only. A selector that
 * returns a fresh array (slice/map) without useShallow re-renders forever.
 * These components both do that, so mounting them and pushing a tick must
 * stay quiet.
 */

import React from "react";
import { render, act } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import useTickStore from "../../store/tickStore";
import ConfidenceHeat from "./ConfidenceHeat";
import TradeLog from "./TradeLog";

function makeTick(i) {
  return {
    coin_id: "bitcoin",
    symbol: "BTC",
    price_usd: 60000 + i * 10,
    volume_24h: 1e9,
    price_change_24h: 1.2,
    bid_price: 60000 + i * 10 - 5,
    ask_price: 60000 + i * 10 + 5,
    anomaly_score: 0.4,
    is_anomaly: i % 10 === 0,
    polled_at: new Date(1700000000000 + i * 10000).toISOString(),
  };
}

describe("terminal panels do not loop on tick updates", () => {
  beforeEach(() => {
    useTickStore.setState({ tickHistory: {}, latestByCoins: {}, anomalyCounts: {} });
  });

  it.each([
    ["ConfidenceHeat", ConfidenceHeat],
    ["TradeLog", TradeLog],
  ])("%s renders a bounded number of times", (_name, Component) => {
    let renders = 0;
    function Probe() {
      renders += 1;
      return <Component activeCoin="bitcoin" />;
    }

    render(<Probe />);
    const baseline = renders;

    act(() => {
      for (let i = 0; i < 30; i++) useTickStore.getState().addTick(makeTick(i));
    });

    // Well under React's 50-update bailout, and far under 30 ticks × loop.
    expect(renders - baseline).toBeLessThan(40);
  });
});
