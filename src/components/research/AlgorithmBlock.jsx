/**
 * components/research/AlgorithmBlock.jsx
 * ──────────────────────────────────────
 * Publication-ready Algorithm Pseudocode Block with line numbering,
 * input/output metadata, and syntax highlighting.
 */

import React from "react";

export function AlgorithmBlock({
  number = "1",
  title,
  inputs = [],
  outputs = [],
  lines = [],
}) {
  return (
    <div className="algo-block">
      <div className="algo-block__header">
        <span>Algorithm {number}: {title}</span>
        <span className="algo-block__badge">O(1) Streaming</span>
      </div>

      {(inputs.length > 0 || outputs.length > 0) && (
        <div className="algo-block__meta">
          {inputs.length > 0 && (
            <div className="algo-block__meta-item">
              <span className="algo-block__meta-label">Input:</span>
              <span>{inputs.join("; ")}</span>
            </div>
          )}
          {outputs.length > 0 && (
            <div className="algo-block__meta-item">
              <span className="algo-block__meta-label">Output:</span>
              <span>{outputs.join("; ")}</span>
            </div>
          )}
        </div>
      )}

      <div className="algo-block__body">
        {lines.map((line, idx) => {
          const indentLevel = line.indent || 0;
          return (
            <div
              key={idx}
              className="algo-line"
              style={{ paddingLeft: `calc(1rem + ${indentLevel * 1.25}rem)` }}
            >
              <span className="algo-line__num">{idx + 1}:</span>
              <span className="algo-line__content">{line.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default AlgorithmBlock;
