# env-config — agent guide

All runtime configuration loads once at startup via app_config.load
with a declared spec ({NAME: {type, default, required}}). os.environ reads
scattered in endpoints fail review (secrets go through secrets-manager).
Missing required config crashes at BOOT — that is the point.
