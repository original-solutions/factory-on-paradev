# Reliability

Asks: **when something fails or runs twice, does this change lose, repeat or hide work?**

Your lens is jobs, queues, schedules, retries, timeouts, webhooks and error handling. None changed and no error path touched, nothing to review.

- **Missing timeouts.** Outbound calls, locks and waits with no bound.
- **Retry storms.** Retries with no backoff or cap, retries of calls that are not idempotent, a webhook the sender retries handled twice.
- **Double runs.** A job or schedule that can run twice at once or twice in a row (overlap, a retry after partial success, two schedulers) and repeats a send, a charge or a write.
- **Dropped work.** An error path that logs and returns success, a swallowed exception, a job that fails without retry or alert, a message acknowledged before the work is done.
- **Health that lies.** A status, heartbeat or health endpoint that reports healthy while the work it stands for fails.

The scenario names the failure (the dependency that times out, the second delivery, the crash between two writes) and what is lost, repeated or hidden.
