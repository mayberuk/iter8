# Security policy

## Reporting a vulnerability

Report it privately through GitHub: open the Security tab of this repository and choose "Report a vulnerability". Please do not open a public issue for a security problem.

## Supported versions

Only the latest release is supported. Fixes ship in a new release; older ones are not patched.

## Threat summary

- The service and its proxies bind loopback only.
- Every overlay call carries the page's capability token.
- Hooks hand the agent session only a pointer to a round, never note text.
