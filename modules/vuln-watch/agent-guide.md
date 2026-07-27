# vuln-watch — agent guide

scan() compares requirements.txt pins against the advisory list the
platform team ships (advisories.json — refreshed by certifiers, not fetched at
runtime). HIGH findings should fail the app's own CI. Never auto-upgrade;
surface and let owners decide.
