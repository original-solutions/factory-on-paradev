# factory-on-paradev

The open-source runner for Factory by Original Solutions. Label a GitHub issue `factory:ready`, and the runner has a coding agent build it in a [Paradev](https://github.com/ParadevAI/Paradev) workspace, checks the result with your own tests on a fresh checkout, and opens a draft pull request.

**Status: pre-alpha.** Nothing here runs yet. The first milestone is a spike against a live Paradev to pin down the exact CLI responses the runner depends on.

## How it works

The runner is a small process on a machine where Paradev is signed in: your Mac, a Mac mini, or a Linux box added to Paradev as a host. It watches the repos you choose, or every repo in an account, for issues labelled `factory:ready`. For each one it:

1. Claims the issue and picks where the agent runs: this machine, another of your Paradev hosts, or Paradev Cloud.
2. Starts an isolated Paradev workspace with an agent running the `/factory` skill.
3. Waits for the agent's result line (`FACTORY-DONE: <PR URL>` or `FACTORY-STOP: <reason>`).
4. Runs the repo's gate commands on a fresh checkout of the pull request, and sends failures back to the same agent.
5. Marks the draft pull request ready for review, or posts the agent's questions on the issue.

It drives Paradev through the signed-in `superset` CLI, so your Paradev and agent logins stay on that machine. The runner works on its own, with no account anywhere. The hosted Factory dashboard by Original Solutions is a separate, optional product.

The repo will also be a Paradev plugin marketplace, so `superset plugins install factory@factory-on-paradev` gives every agent the skills it needs.

## Not affiliated with Paradev

Paradev is a product of Superset Inc. This project uses Paradev's public CLI and is not made or endorsed by them.

## License

MIT. See [LICENSE](LICENSE).
