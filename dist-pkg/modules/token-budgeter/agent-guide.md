# token-budgeter — agent guide

Wrap every model call: budgeter.spend(conversation_id, estimated_usd)
BEFORE invoking; on BudgetExceeded reply with the standard budget message
instead of calling the model. Caps are configuration (APP_CONVO_BUDGET_USD),
never inline numbers.
