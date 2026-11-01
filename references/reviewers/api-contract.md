# API contract

Asks: **will anything that calls this code from outside break?**

Your lens is the contract other code relies on: routes, request and response shapes, events, published package signatures, public schemas. None changed, nothing to review.

- **Breaking changes.** A route renamed or removed, a method changed, a request field newly required, a response field removed, renamed or retyped, an event payload reshaped, a public signature or return type changed.
- **Silent removal.** A field dropped from a resource or serializer with no deprecation, so a consumer reads null instead of failing.
- **Missing versioning.** A breaking change shipped in place where the repo versions its API, or with no note where the repo documents its contract.
- **Consumers in this repo.** Search for callers of the changed contract (client fetches, typed clients, listeners, tests) and name which break.

A breaking change to an external contract without versioning is a blocker. An internal-only signature change is a nit unless callers in this diff break.
