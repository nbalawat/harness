# Internal Audit & Regulator Expectations — Onboarding Systems

(Source: regulator-audit-requirements.md)

Any system supporting KYC decisions must provide:

1. An immutable, append-only trail of every case action: who, what, when,
   and the before/after of any changed field. Deletion or edit of trail
   entries must be technically impossible through the application.
2. Attribution: every approval or rejection tied to a named individual with a
   role valid for that decision tier at decision time.
3. Reproducibility: for any past case, the exact risk score inputs, the
   matrix version applied, and the memo text as approved must be retrievable.
4. The AI-drafted memo must be clearly labeled as machine-drafted, must cite
   the policy provisions it relies on, and the approving human owns its
   content upon approval.
5. Export: auditors can export any case file, including the full trail, in a
   reviewable format (CSV acceptable).
6. Access is least-privilege by role; auditors are read-only.
