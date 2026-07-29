# email-send — agent guide

Outbound mail uses registered templates (mailer.register_template) and
send() — no inline strings, so wording is reviewable. Suppressed addresses
(unsubscribes, bounces) are NEVER mailed; suppression wins silently and is
recorded. Without SMTP config, mail lands in the outbox.
