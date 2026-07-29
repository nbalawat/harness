# state-machine — agent guide

Declare {state: {event: next_state}} once per entity and call
advance() everywhere a status changes. An event not declared for the current
state raises — endpoints translate that to 409. Never mutate status fields
directly.
