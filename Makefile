NODE ?= node
REPO ?= https://github.com/original-solutions/factory-on-paradev.git
# The highest v* tag on the remote, unless the caller names one.
TAG ?= $(shell git ls-remote --tags --refs $(REPO) 'v*' | sed 's,.*/,,' | sort -V | tail -1)

.PHONY: build release release-finish deploy

# There is no compile step: Node strips the types. Build installs the dependencies and runs the gate.
build:
	npm ci
	npm run check

# A release is a version bump and a tag in one commit on main: `make release VERSION=0.1.0`
# commits "release: v0.1.0" and tags v0.1.0. npm refuses a dirty tree. The package's `version`
# script gives the plugin the same version in that commit (scripts/release-version.ts).
# release-finish then pushes main, syncs the organization's plugin source and pushes the tag last.
release: build
	test -n "$(VERSION)" || { echo "usage: make release VERSION=0.1.0"; exit 2; }
	echo "$(VERSION)" | grep -Eqx '[0-9]+\.[0-9]+\.[0-9]+' || { echo "VERSION is three numbers, such as 0.1.0"; exit 2; }
	test "$$(git rev-parse --abbrev-ref HEAD)" = main || { echo "release from main"; exit 2; }
	git fetch --quiet origin main
	test "$$(git rev-parse HEAD)" = "$$(git rev-parse origin/main)" || { echo "main is not origin/main: pull first"; exit 2; }
	superset plugins validate .
	npm version "$(VERSION)" -m "release: v%s"
	$(MAKE) release-finish VERSION="$(VERSION)"

# The end of a release, and the one command to run again when it failed after `npm version`:
# the only sync of the organization's source and the only tag push (scripts/release-finish.ts).
release-finish:
	test -n "$(VERSION)" || { echo "usage: make release-finish VERSION=0.1.0"; exit 2; }
	$(NODE) scripts/release-finish.ts "$(VERSION)"

# Installs a tagged version, the latest by default: clones the tag, installs its runtime dependencies,
# and runs its own `install`, which places it at ~/.local/share/factory-runner/versions/<version>
# and reloads the LaunchAgent. `make deploy TAG=v0.1.0` installs that one instead, for a rollback;
# take self-update out of the way first (README, "Release and deploy").
deploy:
	test -n "$(TAG)" || { echo "no v* tag on $(REPO); run make release first"; exit 2; }
	tmp=$$(mktemp -d) && trap 'rm -rf "$$tmp"' EXIT && \
	git init -q "$$tmp" && cd "$$tmp" && \
	git fetch -q --depth 1 "$(REPO)" tag "$(TAG)" && git -c advice.detachedHead=false checkout -q FETCH_HEAD && \
	npm ci --omit=dev && $(NODE) src/bin.ts install
