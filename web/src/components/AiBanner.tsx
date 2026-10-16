/** Persistent notice that this is machine interpretation (G7, docs/GUARDRAILS.md regulated settings). */
export function AiBanner() {
  return (
    <p role="note" className="ai-banner">
      <strong>AI interpretation, not a qualified human interpreter.</strong> Not for clinical, legal or other critical
      decisions. Demo — synthetic data only; no audio is saved.
    </p>
  )
}
