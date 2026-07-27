# approval-flow — agent guide

Anything leaving the app for a human decision flows through here:
submit() creates a pending item; approve()/reject() record actor + reason and
audit automatically. Endpoints live under /workflow/* — never mount approval
routes elsewhere. Illegal transitions (approving twice) are 409s, not
silent no-ops.
