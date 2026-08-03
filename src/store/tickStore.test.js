/**
 * store/tickStore.test.js
 * ───────────────────────
 * Regression tests for the tick store.
 *
 * The subscribe test is the important one: LiveChart drives the canvas via
 * useTickStore.subscribe(selector, callback), which silently never fires if
 * the store is created without the subscribeWithSelector middleware. That
 * failure mode is invisible (no error, chart just never updates), so it needs
 * a test that fails loudly.
 */

import { describe, it, expect, beforeEach } from "vitest";
import useTickStore from "./tickStore";

/** Build a minimal ScoredTick for testing. */
function makeTick(overrides = {}) {
  return {
    coin_id: "bitcoin",
    symbol: "BTC",
    name: "Bitcoin",
    price_usd: 60000,
    volume_24h: 1000,
    price_change_24h: 1.5,
    anomaly_score: 0.1,
    is_anomaly: false,
    model_type: "halftrees",
    threshold: 0.75,
    polled_at: "2026-08-03T10:00:00+00:00",
    scored_at: "2026-08-03T10:00:00+00:00",
    ...overrides,
  };
}

beforeEach(() => {
  useTickStore.setState({
    tickHistory: {},
    latestByCoins: {},
    anomalyCounts: {},
    wsStatus: "connecting",
    reconnectCount: 0,
  });
});

describe("tickStore", () => {
  it("fires selector subscriptions on new ticks (requires subscribeWithSelector)", () => {
    const received = [];
    const unsub = useTickStore.subscribe(
      (state) => state.latestByCoins.bitcoin,
      (tick) => received.push(tick)
    );

    useTickStore.getState().addTick(makeTick({ price_usd: 61000 }));
    unsub();

    expect(received).toHaveLength(1);
    expect(received[0].price_usd).toBe(61000);
  });

  it("does not fire a coin's subscription for another coin's tick", () => {
    const received = [];
    const unsub = useTickStore.subscribe(
      (state) => state.latestByCoins.bitcoin,
      (tick) => received.push(tick)
    );

    useTickStore.getState().addTick(makeTick({ coin_id: "ethereum", symbol: "ETH" }));
    unsub();

    expect(received).toHaveLength(0);
  });

  it("counts only anomalous ticks", () => {
    const { addTick } = useTickStore.getState();
    addTick(makeTick({ is_anomaly: false }));
    addTick(makeTick({ is_anomaly: true }));
    addTick(makeTick({ is_anomaly: true }));

    expect(useTickStore.getState().anomalyCounts.bitcoin).toBe(2);
  });

  it("caps history per coin and keeps the newest tick", () => {
    const { addTick } = useTickStore.getState();
    for (let i = 0; i < 520; i++) addTick(makeTick({ price_usd: i }));

    const history = useTickStore.getState().tickHistory.bitcoin;
    expect(history).toHaveLength(500);
    expect(history[history.length - 1].price_usd).toBe(519);
  });
});
