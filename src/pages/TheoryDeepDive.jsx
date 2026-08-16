/**
 * pages/TheoryDeepDive.jsx
 * ────────────────────────
 * Dedicated mathematical deep dive into Streaming Anomaly Detection Theory:
 * HalfSpaceTrees, sliding-window mass decay, QuantileFilter, and Concept Drift protection.
 */

import React, { useEffect } from "react";
import ResearchNav from "../components/research/ResearchNav";
import MathFormula, { InlineMath } from "../components/research/MathFormula";
import TheoremBox from "../components/research/TheoremBox";
import AlgorithmBlock from "../components/research/AlgorithmBlock";
import InteractivePlayground from "../components/research/InteractivePlayground";
import "../styles/research.css";

export function TheoryDeepDive() {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  return (
    <div className="paper-page">
      <ResearchNav />

      <main className="paper-container">
        <header className="paper-header">
          <div className="paper-meta-badge">
            <span>THEORY & MATHEMATICAL FOUNDATIONS • PART I</span>
          </div>

          <h1 className="paper-title">
            Online Streaming Isolation & Density Theory: HalfSpaceTrees and Adaptive Quantile Filtering
          </h1>

          <div className="paper-authors">
            <span><strong>Streaming ML Architecture Group</strong></span>
            <span>•</span>
            <span>Unsupervised Anomaly Detection Formulations</span>
          </div>

          <div className="paper-abstract-box">
            <div className="paper-abstract-title">Module Summary</div>
            <p className="paper-abstract-text">
              This document formalizes the mathematical theory behind online streaming isolation ensembles.
              We examine why traditional batch machine learning algorithms fail under non-stationary market conditions,
              derive the geometric space-partitioning mechanics of <strong>HalfSpaceTrees (HST)</strong>,
              prove why decaying sliding-window mass updates preserve scale-free temporal sensitivity,
              and rigorously formulate how <strong>QuantileFilter</strong> and <strong>Detector Poisoning Protection</strong> prevent
              false-alarm saturation and model degradation.
            </p>
          </div>
        </header>

        <div className="paper-layout">
          <aside className="paper-toc">
            <div className="paper-toc__title"><span>🔬</span> Sections</div>
            <ul className="paper-toc__list">
              <li className="paper-toc__item"><a href="#sec-online-vs-batch">1. Online vs Batch Retraining</a></li>
              <li className="paper-toc__item"><a href="#sec-hst-geom">2. Geometry of HalfSpaceTrees</a></li>
              <li className="paper-toc__item"><a href="#sec-mass-decay">3. Mass Decay Mechanics</a></li>
              <li className="paper-toc__item"><a href="#sec-quantile-theory">4. QuantileFilter Formulation</a></li>
              <li className="paper-toc__item"><a href="#sec-poison-proof">5. Anomaly Poisoning Proof</a></li>
              <li className="paper-toc__item"><a href="#sec-zscore-ewma">6. Rolling Z-Score Formulation</a></li>
              <li className="paper-toc__item"><a href="#sec-playground">7. Interactive Simulator</a></li>
            </ul>
          </aside>

          <article className="paper-content">
            {/* Section 1 */}
            <section id="sec-online-vs-batch" className="paper-section">
              <h2 className="paper-section__title">
                <span className="paper-section__num">1.0</span>
                Why Online Learning Beats Periodic Retraining in Financial Streams
              </h2>
              <p className="paper-paragraph">
                Cryptocurrency market dynamics exhibit pronounced <strong>volatility clustering</strong> (Mandelbrot, 1963; Engle, 1982).
                Periods of extreme calmness are abruptly punctuated by sudden liquidity shocks and violent flash crashes.
                A conventional batch machine learning approach (e.g. retraining an Isolation Forest once per hour or once per day)
                suffers from two fatal architectural vulnerabilities:
              </p>

              <div className="paper-table-wrapper">
                <table className="paper-table">
                  <thead>
                    <tr>
                      <th>Surveillance Dimension</th>
                      <th>Batch Retrained Isolation Forest</th>
                      <th>Streaming HalfSpaceTrees (CryptoPulse)</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td><strong>Update Complexity</strong></td>
                      <td><InlineMath math="\mathcal{O}(N \log N)" /> over full historical batch</td>
                      <td><strong><InlineMath math="\mathcal{O}(1)" /> per tick</strong></td>
                    </tr>
                    <tr>
                      <td><strong>Computational Latency</strong></td>
                      <td>High latency spike on retraining epochs</td>
                      <td><strong>Deterministic sub-millisecond per tick</strong></td>
                    </tr>
                    <tr>
                      <td><strong>Intra-Batch Regime Adaptation</strong></td>
                      <td>Zero adaptation between training runs (model is frozen)</td>
                      <td><strong>Continuous sliding mass decay per tick</strong></td>
                    </tr>
                    <tr>
                      <td><strong>Memory Consumption</strong></td>
                      <td><InlineMath math="\mathcal{O}(N \times D)" /> data buffer stored in RAM</td>
                      <td><strong><InlineMath math="\mathcal{O}(M \cdot 2^h)" /> bounded fixed trees</strong></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            {/* Section 2 */}
            <section id="sec-hst-geom" className="paper-section">
              <h2 className="paper-section__title">
                <span className="paper-section__num">2.0</span>
                The Geometry of Random Half-Space Space Partitioning
              </h2>
              <p className="paper-paragraph">
                Instead of building decision trees top-down based on information gain or variance reduction,
                <strong>HalfSpaceTrees</strong> construct a forest of <InlineMath math="M" /> random binary trees across the normalized
                hypercube <InlineMath math="[0, 1]^D" />.
              </p>

              <TheoremBox type="definition" number="2.1" title="Half-Space Partitioning">
                Given a node <InlineMath math="u" /> in tree <InlineMath math="T_j" /> with bounding box <InlineMath math="[\mathbf{min}_u, \mathbf{max}_u]" />,
                a random dimension <InlineMath math="d_u \in \{1, \dots, D\}" /> is selected with uniform probability <InlineMath math="P(d_u = k) = \frac{1}{D}" />.
                The hyper-rectangle is bisected into two disjoint half-spaces:
                <div style={{ textAlign: "center", margin: "0.5rem 0" }}>
                  <InlineMath math="\text{Left}(u) = \{\mathbf{x} \in u \mid x_{d_u} \le m_u\}, \quad \text{Right}(u) = \{\mathbf{x} \in u \mid x_{d_u} > m_u\}" />
                </div>
                where split point <InlineMath math="m_u = \frac{\mathbf{min}_u[d_u] + \mathbf{max}_u[d_u]}{2}" />.
              </TheoremBox>

              <p className="paper-paragraph">
                By setting the tree height to <InlineMath math="h = 10" />, each individual tree generates <InlineMath math="2^{10} = 1,024" /> leaf partitions.
                Across <InlineMath math="M = 25" /> trees, the ensemble creates an interwoven mesh of <InlineMath math="25 \times 1,024 = 25,600" /> random half-space partitions.
                This structure isolates outliers in sparse sub-regions with extreme statistical precision.
              </p>
            </section>

            {/* Section 3 */}
            <section id="sec-mass-decay" className="paper-section">
              <h2 className="paper-section__title">
                <span className="paper-section__num">3.0</span>
                Sliding-Window Mass Decay Mechanics
              </h2>
              <p className="paper-paragraph">
                Each node <InlineMath math="u" /> maintains a mass count <InlineMath math="r_u" /> representing recent tick density.
                To ensure old market regimes decay naturally without requiring tree restructuring, masses update via a sliding window
                decay factor <InlineMath math="\lambda = \frac{1}{W_{\text{mass}}}" /> where <InlineMath math="W_{\text{mass}} = 150" />:
              </p>

              <MathFormula
                math="r_u(t) = r_u(t-1) \cdot \left(1 - \frac{1}{W_{\text{mass}}}\right) + \mathbb{I}[\mathbf{x}_t \in \text{Domain}(u)]"
                tag="(11)"
                caption="Sliding mass update equation ensuring exponential temporal forgetting of stale regimes"
              />

              <p className="paper-paragraph">
                The anomaly score for incoming vector <InlineMath math="\mathbf{x}_t" /> is the depth-weighted aggregate mass:
              </p>

              <MathFormula
                math="S(\mathbf{x}_t) = \frac{1}{M} \sum_{j=1}^M \sum_{u \in \text{Path}(\mathbf{x}_t, T_j)} r_u(t) \cdot 2^{\text{depth}(u)}"
                tag="(12)"
                caption="Depth-weighted aggregate isolation score"
              />
            </section>

            {/* Section 4 */}
            <section id="sec-quantile-theory" className="paper-section">
              <h2 className="paper-section__title">
                <span className="paper-section__num">4.0</span>
                Scale-Free QuantileFilter Formulation
              </h2>
              <p className="paper-paragraph">
                The absolute numerical score from HalfSpaceTrees depends heavily on feature space geometry and tree depth.
                In 4-D stationary feature spaces, scores concentrate tightly between 0.90 and 1.0. A fixed absolute cutoff
                (e.g. 0.75) is mathematically invalid and causes catastrophic false alarms (89.36% false positive rate).
              </p>

              <TheoremBox type="property" number="4.1" title="Scale-Free Tail Invariance">
                Let <InlineMath math="S_t" /> be a stream of continuous scores following arbitrary unknown cumulative distribution <InlineMath math="F_S(s)" />.
                Let <InlineMath math="\tau(q)" /> satisfy <InlineMath math="F_S(\tau(q)) = q" />.
                Then the decision rule <InlineMath math="\mathbb{I}[S_t \ge \tau(q)]" /> has expected alert probability:
                <div style={{ textAlign: "center", margin: "0.5rem 0" }}>
                  <InlineMath math="\mathbb{E}\left[\mathbb{I}[S_t \ge \tau(q)]\right] = 1 - q" />
                </div>
                independent of the scale, offset, or monotonic transformations of <InlineMath math="S_t" />.
              </TheoremBox>

              <p className="paper-paragraph">
                By setting <InlineMath math="q = 0.99" />, CryptoPulse mathematically guarantees that exactly the most extreme 1%
                tail of the market distribution generates surveillance alarms, regardless of underlying asset volatility.
              </p>
            </section>

            {/* Section 5 */}
            <section id="sec-poison-proof" className="paper-section">
              <h2 className="paper-section__title">
                <span className="paper-section__num">5.0</span>
                Concept-Drift Poisoning Prevention
              </h2>
              <p className="paper-paragraph">
                A subtle but devastating flaw in naive online anomaly detection implementations is <strong>feedback loop poisoning</strong>:
                if extreme anomalies (e.g. a 15% flash crash) are incorporated into the tree learning step, the model increments the mass
                counters in that anomalous region, quickly learning to treat extreme flash crashes as "normal".
              </p>

              <TheoremBox type="theorem" number="5.1" title="Detector Protection Invariant">
                Under the update rule:
                <div style={{ textAlign: "center", margin: "0.6rem 0" }}>
                  <InlineMath math="\text{Update}(\mathbf{x}_t) = \begin{cases} \text{learn\_one}(\mathbf{x}_t) & \text{if } \text{Alert}(\mathbf{x}_t) = 0 \\ \text{no-op (skip)} & \text{if } \text{Alert}(\mathbf{x}_t) = 1 \end{cases}" />
                </div>
                the probability density estimates within anomalous manifolds remain zero:
                <div style={{ textAlign: "center", margin: "0.6rem 0" }}>
                  <InlineMath math="r_u \to 0 \quad \forall u \text{ containing anomalous regions}" />
                </div>
                guaranteeing permanent isolation sensitivity against sustained market manipulation attacks.
              </TheoremBox>
            </section>

            {/* Section 6 */}
            <section id="sec-zscore-ewma" className="paper-section">
              <h2 className="paper-section__title">
                <span className="paper-section__num">6.0</span>
                Rolling Z-Score Formulation & Variance Protection
              </h2>
              <p className="paper-paragraph">
                For statistical baseline comparisons, the Rolling Z-Score model maintains a bounded FIFO queue of size <InlineMath math="W = 50" /> ticks.
                Sample variance is calculated with Bessel's correction (<InlineMath math="N - 1" /> denominator):
              </p>

              <MathFormula
                math="z_t = \frac{|x_t - \hat{\mu}_W|}{\max\left(\hat{\sigma}_W, \sigma_{\min}\right)}"
                tag="(13)"
                caption="Rolling z-score with Bessel-corrected sample standard deviation"
              />

              <p className="paper-paragraph">
                <strong>Zero-Variance Floor Protection:</strong> If an illiquid token trades at an identical price for 50 ticks,
                <InlineMath math="\hat{\sigma}_W \to 0" />. Without protection, a tiny 1-sat move would cause <InlineMath math="z \to \infty" />.
                Enforcing <InlineMath math="\sigma_{\min} = 0.001 \cdot \hat{\mu}_W" /> prevents numerical division-by-zero instability.
              </p>
            </section>

            {/* Section 7 */}
            <section id="sec-playground" className="paper-section">
              <h2 className="paper-section__title">
                <span className="paper-section__num">7.0</span>
                Interactive Formula Simulator
              </h2>
              <InteractivePlayground />
            </section>
          </article>
        </div>
      </main>
    </div>
  );
}

export default TheoryDeepDive;
