# Security Policy

## Supported Versions

We release patches for security vulnerabilities in the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report them via email to: **[INSERT SECURITY EMAIL]**

You should receive a response within 48 hours. If for some reason you do not, please follow up via email to ensure we received your original message.

Please include the following information in your report:

- Type of issue (e.g., buffer overflow, SQL injection, cross-site scripting, etc.)
- Full paths of source file(s) related to the issue
- The location of the affected source code (tag/branch/commit or direct URL)
- Any special configuration required to reproduce the issue
- Step-by-step instructions to reproduce the issue
- Proof-of-concept or exploit code (if possible)
- Impact of the issue, including how an attacker might exploit it

## Preferred Languages

We prefer all communications to be in English.

## Disclosure Policy

When we receive a security bug report, we will:

1. Confirm the problem and determine affected versions
2. Audit code to find any similar problems
3. Prepare fixes for all supported versions
4. Release new versions and publish the advisory

## Security Update Process

Security updates will be released as patch versions (e.g., 0.1.1, 0.1.2) and announced:

- In the [GitHub Releases](https://github.com/yaront1111/Moe-s-Tavern/releases)
- In the [CHANGELOG.md](CHANGELOG.md) file

## Security Considerations

### Daemon Security

- The daemon listens only on localhost by default
- WebSocket connections are not authenticated (designed for local use)
- File operations are restricted to the `.moe/` directory

### Plugin Security

- The plugin connects only to localhost
- No external network connections are made
- All data stays local to the project

### MCP Protocol

- The MCP proxy uses stdio communication
- No network exposure when used with CLI tools
- Tool calls are logged for audit purposes

## Best Practices for Users

1. **Keep software updated**: Always use the latest version
2. **Localhost only**: Don't expose the daemon to network interfaces
3. **Review plans**: Always review AI-generated plans before approval
4. **Audit logs**: Regularly check `.moe/activity.log` for unexpected activity
