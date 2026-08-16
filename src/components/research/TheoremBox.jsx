/**
 * components/research/TheoremBox.jsx
 * ──────────────────────────────────
 * Formatted academic callout cards for Definitions, Theorems, Lemmas,
 * Properties, and Remarks.
 */

import React from "react";

export function TheoremBox({
  type = "definition", // "definition" | "theorem" | "property" | "remark" | "lemma"
  title,
  number,
  children,
}) {
  const typeLabels = {
    definition: "Definition",
    theorem: "Theorem",
    lemma: "Lemma",
    property: "Property",
    remark: "Remark",
  };

  const cardClass = `theorem-card theorem-card--${type}`;
  const labelText = `${typeLabels[type] || "Note"} ${number ? number + " " : ""}${title ? "— " + title : ""}`;

  return (
    <div className={cardClass}>
      <div className="theorem-card__header">
        <span className="theorem-card__label">{labelText}</span>
      </div>
      <div className="theorem-card__body">{children}</div>
    </div>
  );
}

export default TheoremBox;
