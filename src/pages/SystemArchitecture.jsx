/**
 * pages/SystemArchitecture.jsx
 * ────────────────────────────
 * Deep dive into CryptoPulse's high-throughput, low-latency asynchronous architecture:
 * Bounded Queues, Backpressure, Zero-Loss Sentinel Shutdown, and WebSockets.
 */

import React, { useEffect } from "react";
import ResearchNav from "../components/research/ResearchNav";
import MathFormula, { InlineMath } from "../components/research/MathFormula";
import TheoremBox from "../components/research/TheoremBox";
import AlgorithmBlock from "../components/research/AlgorithmBlock";
import "../styles/research.css";

export function SystemArchitecture() {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  return (
    <div className="paper-page">
      <ResearchNav />

      <main className="paper-container">
        <header className="paper-header">
          <div className="paper-meta-badge">
            <span>SYSTEM DESIGN & DISTRIBUTED STREAMS • PART III</span>
          </div>

          <h1 className="paper-title">
            Asynchronous Stream Architecture: Bounded Queues, Deterministic Sentinels, and Zero-Copy Fanout
          </h1>

          <div className="paper-authors">
            <span><strong>High-Performance Distributed Systems Group</strong></span>
            <span>•</span>
            <span>FastAPI & Asynchronous Event-Loop Engineering</span>
          </div>

          <div className="paper-abstract-box">
            <div className="paper-abstract-title">Module Summary</div>
            <p className="paper-abstract-text">
              Real-time surveillance engines must process continuous market feeds with deterministic latency
              while guaranteeing zero tick loss during peak API volatility bursts or graceful service restarts.
              This paper analyzes the 3-stage decoupled pipeline of CryptoPulse, proving how bounded
              asynchronous queues enforce natural backpressure, deriving the race-free <strong>Shutdown Sentinel Protocol</strong>,
              and examining the lockless WebSocket broadcast fanout mechanism that achieves sub-millisecond client delivery.
            </p>
          </div>
        </header>

        <div className="paper-layout">
          <aside className="paper-toc">
            <div className="paper-toc__title"><span>⚙️</span> Sections</div>
            <ul className="paper-toc__list">
              <li className="paper-toc__item"><a href="#sec-3stage">1. Three-Stage Pipeline</a></li>
              <li className="paper-toc__item"><a href="#sec-backpressure">2. Bounded Queue Backpressure</a></li>
              <li className="paper-toc__item"><a href="#sec-sentinel">3. Shutdown Sentinel Protocol</a></li>
              <li className="paper-toc__item"><a href="#sec-ws-fanout">4. Zero-Copy WebSocket Broadcast</a></li>
              <li className="paper-toc__item"><a href="#sec-live-config">5. Zero-Restart Parameter Tuning</a></li>
            </ul>
          </aside>

          <article className="paper-content">
            {/* Section 1 */}
            <section id="sec-3stage" className="paper-section">
              <h2 className="paper-section__title">
                <span className="paper-section__num">1.0</span>
                The Three-Stage Asynchronous Pipeline
              </h2>
              <p className="paper-paragraph">
                The CryptoPulse backend is organized as three decoupled concurrent asynchronous tasks
                connected via bounded memory channels:
              </p>

              <div className="formula-block" style={{ padding: "1.5rem", textAlign: "left", display: "block" }}>
                <pre style={{ margin: 0, fontFamily: "var(--font-code)", fontSize: "0.85rem", color: "#00e5ff", lineHeight: "1.6" }}>
{`┌────────────────────────┐      ┌────────────────────────┐      ┌────────────────────────┐
│   CoinGeckoPoller      │      │     ScoringWorker      │      │     broadcast_loop     │
│ (Binance Batch REST)   │      │  (Online ML / River)   │      │   (SQLite / Postgres)  │
└───────────┬────────────┘      └───────────┬────────────┘      └───────────┬────────────┘
            │                               │                               │
            ▼                               ▼                               ▼
       [raw_queue]                   [scored_queue]                  [Active WebSockets]
     (Capacity = 100)               (Capacity = 100)               (Zero-Copy JSON Fanout)`}
                </pre>
              </div>

              <p className="paper-paragraph">
                <strong>Stage 1 (Poller):</strong> Issues a single HTTP/2 batch query to Binance for all tracked symbols every 10 seconds.
                Ticks are packaged into lightweight dataclasses and pushed to <code>raw_queue</code>.
              </p>
              <p className="paper-paragraph">
                <strong>Stage 2 (Scorer):</strong> Consumes from <code>raw_queue</code>, converts observations into stationary features,
                invokes the per-coin ML model instance in <InlineMath math="\mathcal{O}(1)" /> time, and pushes scored results to <code>scored_queue</code>.
              </p>
              <p className="paper-paragraph">
                <strong>Stage 3 (Broadcaster & Persistence):</strong> Atomically writes the scored tick to persistent storage (WAL-mode SQLite / Postgres)
                and broadcasts the JSON payload to all connected WebSocket clients.
              </p>
            </section>

            {/* Section 2 */}
            <section id="sec-backpressure" className="paper-section">
              <h2 className="paper-section__title">
                <span className="paper-section__num">2.0</span>
                Bounded Queues & Natural Backpressure
              </h2>
              <p className="paper-paragraph">
                Unbounded queues in streaming engines represent a severe memory leak hazard: if downstream database writes
                or ML inference encounters transient I/O latency, unbounded queues grow indefinitely until the OS kernel issues an Out-Of-Memory (OOM) kill.
              </p>

              <TheoremBox type="theorem" number="2.1" title="Deterministic Bounded Ingress Guarantee">
                Let <InlineMath math="K = 100" /> be the maximum capacity of <code>raw_queue</code>.
                If downstream scoring latency <InlineMath math="T_{\text{score}} > T_{\text{poll}}" />, the poller coroutine's <code>await raw_queue.put(tick)</code>
                suspends on the event loop until space is freed:
                <div style={{ textAlign: "center", margin: "0.5rem 0" }}>
                  <InlineMath math="\text{MemoryUsage}(\text{Pipeline}) \le 2 \times K \times \text{sizeof}(\text{Tick}) + \mathcal{O}(1) < \infty" />
                </div>
                guaranteeing strict upper bounds on memory footprint under arbitrary network congestion.
              </TheoremBox>
            </section>

            {/* Section 3 */}
            <section id="sec-sentinel" className="paper-section">
              <h2 className="paper-section__title">
                <span className="paper-section__num">3.0</span>
                The Race-Free Shutdown Sentinel Protocol
              </h2>
              <p className="paper-paragraph">
                Traditional polling shutdown implementations rely on periodic timeout polling (e.g. <code>asyncio.wait_for(queue.get(), timeout=1.0)</code>).
                When a timeout expires, the future is cancelled; if an item arrived in the same event-loop tick, it is lost forever.
              </p>

              <AlgorithmBlock
                number="2"
                title="Zero-Loss Sentinel Shutdown Sequence"
                inputs={["Active Lifespan Shutdown Trigger (SIGTERM / SIGINT)"]}
                outputs={["All in-flight ticks scored, persisted, and broadcasted"]}
                lines={[
                  { indent: 0, text: "Stop Ingestion Poller (prevent any new network ticks)" },
                  { indent: 0, text: "raw_queue.put_nowait(SHUTDOWN_SENTINEL)" },
                  { indent: 0, text: "while true do" },
                  { indent: 1, text: "item ← ScoringWorker.raw_queue.get()" },
                  { indent: 1, text: "if item is SHUTDOWN_SENTINEL then" },
                  { indent: 2, text: "scored_queue.put_nowait(SHUTDOWN_SENTINEL)" },
                  { indent: 2, text: "break  // Scoring Worker terminates cleanly" },
                  { indent: 1, text: "else" },
                  { indent: 2, text: "ScoreAndForward(item)" },
                  { indent: 1, text: "end if" },
                  { indent: 0, text: "end while" },
                  { indent: 0, text: "broadcast_loop drains scored_queue until SHUTDOWN_SENTINEL" },
                  { indent: 0, text: "Flush DB buffers & close WebSocket connections gracefully" },
                ]}
              />
            </section>

            {/* Section 4 */}
            <section id="sec-ws-fanout" className="paper-section">
              <h2 className="paper-section__title">
                <span className="paper-section__num">4.0</span>
                Zero-Copy WebSocket Fanout
              </h2>
              <p className="paper-paragraph">
                The WebSocket broadcast manager maintains an active connection registry.
                To prevent concurrent iteration mutation errors (where disconnecting clients mutate the array during broadcast),
                broadcast creates a shallow snapshot of active sockets and purges dead sockets in a post-pass:
              </p>

              <MathFormula
                math="T_{\text{fanout}} = \sum_{k=1}^{N_{\text{clients}}} t_{\text{send}}(k) \approx \mathcal{O}(N_{\text{clients}})"
                tag="(19)"
                caption="Asynchronous non-blocking network socket delivery"
              />
            </section>

            {/* Section 5 */}
            <section id="sec-live-config" className="paper-section">
              <h2 className="paper-section__title">
                <span className="paper-section__num">5.0</span>
                Live Zero-Restart Sensitivity Recalibration
              </h2>
              <p className="paper-paragraph">
                When a quantitative operator adjusts the sensitivity slider on the live dashboard,
                the frontend issues a <code>POST /api/config &#123; threshold: q &#125;</code> request.
                The backend mutates the running QuantileFilter threshold in-place across all active coin scorers:
              </p>

              <TheoremBox type="property" number="5.1" title="State Preservation Under Threshold Mutation">
                Updating threshold <InlineMath math="q \to q'" /> does not reset the HalfSpaceTree node mass counters <InlineMath math="r_u" />,
                does not reset the MinMaxScaler bounds, and does not wipe the rolling quantile score buffer.
                The recalibrated threshold takes effect on the very next tick (<InlineMath math="\Delta t = 0" />) with zero warmup delay.
              </TheoremBox>
            </section>
          </article>
        </div>
      </main>
    </div>
  );
}

export default SystemArchitecture;
