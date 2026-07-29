# admin-console — agent guide

Admin capabilities self-register as sections ({id, title, endpoint});
the console composes whatever the app actually composed (roles when rbac is
present, flags when feature-flags is, errors when error-reporter is). Hide the
console entirely from non-admins — rbac decides, not CSS.
