/**
 * pages/FeatureStationarity.jsx
 * ─────────────────────────────
 * Dedicated mathematical and theoretical deep dive into Feature Engineering
 * and Stationarity transformations for cryptocurrency time-series.
 */

import React, { useEffect } from "react";
import ResearchNav from "../components/research/ResearchNav";
import MathFormula, { InlineMath } from "../components/research/MathFormula";
import TheoremBox from "../components/research/TheoremBox";
import AlgorithmBlock from "../components/research/AlgorithmBlock";
import InteractivePlayground from "../components/research/InteractivePlayground";
import "../styles/research.css";

export function FeatureStationarity() {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  return (
    <div className="paper-page">
      <ResearchNav />

      <main className="paper-container">
        <header className="paper-header">
          <div className="paper-meta-badge">
            <span>THEORY & MATHEMATICAL FOUNDATIONS • PART II</span>
          </div>

          <h1 className="paper-title">
            Stationary Feature Engineering on Non-Stationary Cryptocurrency Market Streams
          </h1>

          <div className="paper-authors">
            <span><strong>Quantitative Feature Engineering Division</strong></span>
            <span>•</span>
            <span>Scale Invariance & Microstructure Manifolds</span>
          </div>

          <div className="paper-abstract-box">
            <div className="paper-abstract-title">Module Summary</div>
            <p className="paper-abstract-text">
              Nominal asset price series <InlineMath math="\{P_t\}" /> violate weak and strong stationarity assumptions due to
              integrated unit-root stochastic drifts <InlineMath math="I(1)" />. Machine learning models trained directly on raw price levels
              misinterpret sustained macroeconomic trends as permanent anomalies. This paper derives the exact mathematical
              transformations utilized in CryptoPulse to convert multi-currency raw feeds into a strictly stationary,
              scale-invariant 4-dimensional feature vector consisting of continuously-compounded log returns,
              realized volatility estimators, volatility-standardized velocity, and logarithmic volume surprise ratios.
            </p>
          </div>
        </header>

        <div className="paper-layout">
          <aside className="paper-toc">
            <div className="paper-toc__title"><span>📐</span> Sections</div>
            <ul className="paper-toc__list">
              <li className="paper-toc__item"><a href="#sec-unit-root">1. The Unit Root Problem</a></li>
              <li className="paper-toc__item"><a href="#sec-log-returns">2. Log-Returns Derivation</a></li>
              <li className="paper-toc__item"><a href="#sec-realized-vol">3. Realized Volatility Estimator</a></li>
              <li className="paper-toc__item"><a href="#sec-z-ret">4. Vol-Adjusted Z-Return</a></li>
              <li className="paper-toc__item"><a href="#sec-vol-surprise">5. Logarithmic Volume Surprise</a></li>
              <li className="paper-toc__item"><a href="#sec-matrix-summary">6. Feature Summary Table</a></li>
              <li className="paper-toc__item"><a href="#sec-playground">7. Interactive Simulator</a></li>
            </ul>
          </aside>

          <article className="paper-content">
            {/* Section 1 */}
            <section id="sec-unit-root" className="paper-section">
              <h2 className="paper-section__title">
                <span className="paper-section__num">1.0</span>
                The Unit-Root Dilemma in Streaming Surveillance
              </h2>
              <p className="paper-paragraph">
                Let <InlineMath math="P_t" /> denote the nominal spot price of a cryptocurrency at timestamp <InlineMath math="t" />.
                Empirical econometric tests (such as the Augmented Dickey-Fuller and KPSS tests) consistently demonstrate that
                cryptocurrency nominal prices are integrated of order one, <InlineMath math="P_t \sim I(1)" />:
              </p>

              <MathFormula
                math="P_t = P_{t-1} + \mu_t + \epsilon_t, \quad \epsilon_t \sim (0, \sigma_t^2)"
                tag="(14)"
                caption="Random walk stochastic price process with time-varying drift and volatility"
              />

              <p className="paper-paragraph">
                <strong>The Pathology of Direct Price Modeling:</strong> If an anomaly detector (such as an Isolation Forest or MinMaxScaler)
                is fed raw price levels <InlineMath math="P_t" />, when an asset enters an exponential bull-run and establishes new All-Time Highs (ATH),
                the input values continuously exceed the historical min-max boundaries. The model flags 100% of ticks as "abnormal",
                rendering surveillance useless.
              </p>
            </section>

            {/* Section 2 */}
            <section id="sec-log-returns" className="paper-section">
              <h2 className="paper-section__title">
                <span className="paper-section__num">2.0</span>
                Continuously-Compounded Log-Returns
              </h2>
              <p className="paper-paragraph">
                To eliminate absolute price levels, CryptoPulse computes the first difference of the natural logarithm of prices:
              </p>

              <MathFormula
                math="r_t = \ln\left(\frac{P_t}{P_{t-1}}\right) = \ln(P_t) - \ln(P_{t-1}) \approx \frac{P_t - P_{t-1}}{P_{t-1}}"
                tag="(15)"
                caption="Logarithmic return removes trend level and provides temporal additivity"
              />

              <TheoremBox type="property" number="2.1" title="Time Additivity & Stationarity">
                Log returns are stationary <InlineMath math="r_t \sim I(0)" /> with mean <InlineMath math="\mathbb{E}[r_t] \approx 0" />.
                Furthermore, multi-period cumulative log returns over <InlineMath math="k" /> consecutive ticks satisfy exact additive decomposition:
                <div style={{ textAlign: "center", margin: "0.5rem 0" }}>
                  <InlineMath math="r_{t, t-k} = \sum_{j=0}^{k-1} r_{t-j} = \ln(P_t) - \ln(P_{t-k})" />
                </div>
                preventing compounding asymmetry inherent to simple arithmetic percentage returns.
              </TheoremBox>
            </section>

            {/* Section 3 */}
            <section id="sec-realized-vol" className="paper-section">
              <h2 className="paper-section__title">
                <span className="paper-section__num">3.0</span>
                Sliding Realized Volatility Estimator (<InlineMath math="\hat{\sigma}_t" />)
              </h2>
              <p className="paper-paragraph">
                Cryptocurrency returns exhibit severe <strong>autoregressive conditional heteroskedasticity (ARCH)</strong>:
                variance is not constant over time. To capture instantaneous market turbulence, CryptoPulse computes
                the unbiased sample standard deviation of log returns over a rolling window <InlineMath math="W_{\sigma}" /> (<InlineMath math="N = 30" /> ticks):
              </p>

              <MathFormula
                math="\hat{\sigma}_t = \sqrt{\frac{1}{N - 1} \sum_{k=0}^{N-1} \left(r_{t-k} - \bar{r}_t\right)^2}, \quad \bar{r}_t = \frac{1}{N}\sum_{k=0}^{N-1} r_{t-k}"
                tag="(16)"
                caption="Unbiased rolling realized volatility estimator over window N = 30 ticks"
              />
            </section>

            {/* Section 4 */}
            <section id="sec-z-ret" className="paper-section">
              <h2 className="paper-section__title">
                <span className="paper-section__num">4.0</span>
                Volatility-Standardized Return Velocity (<InlineMath math="z_{\text{ret}, t}" />)
              </h2>
              <p className="paper-paragraph">
                A raw 1% price displacement has completely different economic meaning depending on the prevailing volatility regime.
                During an ultra-quiet consolidation regime where <InlineMath math="\hat{\sigma}_t = 0.1\%" />, a 1% jump is a massive 10-sigma anomaly.
                During a high-volatility cascade where <InlineMath math="\hat{\sigma}_t = 2.5\%" />, a 1% jump is ordinary noise.
              </p>

              <MathFormula
                math="z_{\text{ret}, t} = \frac{r_t}{\max\left(\hat{\sigma}_t, \sigma_{\min}\right)}"
                tag="(17)"
                caption="Dynamic volatility standardization: measures move magnitude in units of current volatility"
              />

              <p className="paper-paragraph">
                This standardization makes the return velocity feature scale-free across both calm and turbulent market regimes.
              </p>
            </section>

            {/* Section 5 */}
            <section id="sec-vol-surprise" className="paper-section">
              <h2 className="paper-section__title">
                <span className="paper-section__num">5.0</span>
                Logarithmic Volume Surprise Metric (<InlineMath math="\delta_{v, t}" />)
              </h2>
              <p className="paper-paragraph">
                Many market manipulation schemes (such as wash trading, liquidity extraction, or spoofing pre-pumps)
                generate abnormal volume surges without immediately shifting the mid-market spot price.
                CryptoPulse captures volume anomalies via logarithmic surprise relative to a baseline moving average window <InlineMath math="W_v" />:
              </p>

              <MathFormula
                math="\delta_{v, t} = \ln\left(\frac{V_t}{\bar{V}_{W, t} + \epsilon}\right) = \ln(V_t) - \ln\left(\frac{1}{|W_v|}\sum_{j=1}^{|W_v|} V_{t-j} + \epsilon\right)"
                tag="(18)"
                caption="Logarithmic volume surprise: positive values indicate multiples of normal volume"
              />
            </section>

            {/* Section 6 */}
            <section id="sec-matrix-summary" className="paper-section">
              <h2 className="paper-section__title">
                <span className="paper-section__num">6.0</span>
                Summary of 4-D Stationary Feature Vector
              </h2>

              <div className="paper-table-wrapper">
                <table className="paper-table">
                  <thead>
                    <tr>
                      <th>Feature Symbol</th>
                      <th>Mathematical Definition</th>
                      <th>Economic Interpretation</th>
                      <th>Stationary <InlineMath math="I(0)" />?</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td><code>ret</code> (<InlineMath math="r_t" />)</td>
                      <td><InlineMath math="\ln(P_t / P_{t-1})" /></td>
                      <td>Continuously compounded price velocity</td>
                      <td><strong>Yes (Unit root removed)</strong></td>
                    </tr>
                    <tr>
                      <td><code>vol</code> (<InlineMath math="\hat{\sigma}_t" />)</td>
                      <td>Rolling sample std over 30 ticks</td>
                      <td>Instantaneous realized volatility regime</td>
                      <td><strong>Yes (Bounded variance)</strong></td>
                    </tr>
                    <tr>
                      <td><code>z_ret</code> (<InlineMath math="z_{\text{ret}, t}" />)</td>
                      <td><InlineMath math="r_t / \hat{\sigma}_t" /></td>
                      <td>Vol-normalized standard deviation shock</td>
                      <td><strong>Yes (Regime normalized)</strong></td>
                    </tr>
                    <tr>
                      <td><code>vol_delta</code> (<InlineMath math="\delta_{v, t}" />)</td>
                      <td><InlineMath math="\ln(V_t / \bar{V}_W)" /></td>
                      <td>Log volume surprise / liquidity shock</td>
                      <td><strong>Yes (Ratio standardized)</strong></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            {/* Section 7 */}
            <section id="sec-playground" className="paper-section">
              <h2 className="paper-section__title">
                <span className="paper-section__num">7.0</span>
                Interactive Feature Explorer
              </h2>
              <InteractivePlayground />
            </section>
          </article>
        </div>
      </main>
    </div>
  );
}

export default FeatureStationarity;
