# Security

Report vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/RobertKoval/pi-persistent-subagents/security/advisories/new). Do not include tokens or private session transcripts in public issues.

This extension and its workers run with Pi's OS permissions. They are not sandboxed. Workers can access their configured working directory and inherited environment; give them tasks and permissions accordingly.

The extension does not copy OAuth credentials into worker arguments or its registry. Named account selections are not credentials. Task text, results and Pi session files may still contain private information; keep the Pi agent directory private and do not publish it.

Review third-party Pi extensions and provider configuration before loading them. Dependency and runtime updates should pass the offline and installed-Pi checks before use.
