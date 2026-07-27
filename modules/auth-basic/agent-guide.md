# auth-basic — agent guide

Identity comes from this module only. To protect an endpoint, read the
`Authorization: Bearer <token>` header and resolve it with
`from ext_auth import current_user` — never invent your own token scheme,
never store passwords (this module is deliberately password-less v0: internal
apps behind firm SSO perimeter). If a slice needs per-user data, key rows by
the username `current_user` returns.
