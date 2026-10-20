# Security

Asks: **can someone get access, data or power this change should not give them?**

Your lens is the trust boundary: authentication, authorization, middleware, permissions, public routes, input validation, secrets and config. No boundary touched, nothing to review.

- **Authorization gaps.** A state-changing action or a read of someone else's data with no policy check; a check skipped by another route or HTTP method; a query not scoped to the user or tenant.
- **Untrusted input.** Request data, file contents, headers or webhook bodies reaching SQL, a shell, a file path, HTML, a template or a redirect unvalidated or unescaped. Mass assignment of fields the user must not set.
- **Secret leakage.** Credentials or tokens in code, config, logs, error messages, URLs, PR text or anything sent to the client.
- **Loosened defaults.** A middleware removed, a route made public, CORS or cookies widened, a permission granted by default, a new outbound host.

Prove the path from entry point to sink. Where existing middleware, policies or scoping make it unreachable, it is not a finding. A reachable path is a blocker in domain `security`; a hygiene lapse with no reachable path is a nit.
