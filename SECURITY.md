# Security Policy

## Reporting a vulnerability

Email security findings privately to the maintainer via GitHub Security Advisories:
https://github.com/vighriday/Veris/security/advisories/new

Please do **not** open public issues for vulnerabilities.

## Scope

Veris runs entirely on the user's machine. There is no remote service to attack.
The threat model is:

- **Untrusted source repositories** analyzed by Veris. Veris executes `git` and reads files. It does **not** execute user code.
- **Plugins** loaded from `.veris/plugins/*.js`. Plugins run in-process. Trust model is identical to any other `require()`. Set `VERIS_PLUGINS_DISABLED=1` to disable.
- **MCP clients** (Claude Code, Cursor, etc.). The MCP server speaks over stdio and never opens network sockets.

## Hardenings already in place

- Git ref input validated against a strict allowlist regex (`/^[A-Za-z0-9][A-Za-z0-9._/-~^]{0,254}$/`). Shell metacharacters rejected.
- All shell calls use `execFileSync` with argument arrays — no shell interpolation.
- Dashboard JSON payload is serialized with `</script` escaping and U+2028/U+2029 escaping so embedded user data cannot break out of the script tag.
- All HTML output is escaped with a strict whitelist.
- SQLite state writes are parameterized; no string-built SQL.
- Local SQLite WAL is the only persistence. `VERIS_STATE_DISABLED=1` disables writes entirely.

## Out of scope

- Plugins behaving badly. Plugins are user-supplied trusted code.
- Decisions made by autonomous agents acting on Veris output. Veris produces directives, not actions.

## Response time

I aim to acknowledge security reports within 72 hours.
