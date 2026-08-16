/**
 * components/research/MathFormula.jsx
 * ────────────────────────────────────
 * Renders LaTeX formulas using KaTeX with displayMode support,
 * optional equation numbering, and fallback rendering.
 */

import React, { useMemo } from "react";
import katex from "katex";

export function MathFormula({ math, display = true, tag, caption }) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(math, {
        displayMode: display,
        throwOnError: false,
        strict: false,
      });
    } catch (e) {
      console.warn("KaTeX rendering error:", e);
      return `<span class="katex-error">${math}</span>`;
    }
  }, [math, display]);

  if (!display) {
    return <span className="inline-math" dangerouslySetInnerHTML={{ __html: html }} />;
  }

  return (
    <div>
      <div className="formula-block">
        <div className="formula-block__content" dangerouslySetInnerHTML={{ __html: html }} />
        {tag && <div className="formula-block__tag">{tag}</div>}
      </div>
      {caption && <div className="formula-caption">{caption}</div>}
    </div>
  );
}

export function InlineMath({ math }) {
  return <MathFormula math={math} display={false} />;
}

export default MathFormula;
