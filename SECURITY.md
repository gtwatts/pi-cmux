# Security

Pi packages run with the user's local permissions. The CMUX extension family can interact with local cmux sockets, terminal panes, browser surfaces, files, and shell commands.

## Reporting issues

Please report security issues privately to the maintainer before opening a public issue. If you publish under a different repo or organization, update this file with the preferred contact channel.

## Operator guidance

- Review extension source before installing.
- Prefer `pi -e ./path` for one-run local testing before permanent install.
- Avoid running orchestration tasks from untrusted prompts.
- Treat tools that execute shell commands, publish packages, deploy code, change production systems, or manipulate credentials as high risk.
- Use explicit human approval before persistent/destructive/externally visible actions.
