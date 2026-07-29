# screen-router — agent guide

Screen switching goes through the router: nav links use
href="#screen-<name>", the router resolves the hash (unknown -> first screen)
and toggles ONLY style.display. Never remove screens from the DOM — hidden
screens keep their state.
