NODE ?= node
REPO ?= https://github.com/original-solutions/factory-on-paradev.git
# The highest v* tag on the remote, unless the caller names one.
TAG ?= $(shell git ls-remote --tags --refs $(REPO) 'v*' | sed 's,.*/,,' | sort -V | tail -1)

.PHONY: build release deploy

# There is no compile step: Node strips the types. Build installs the dependencies and runs the gate.
build:
	npm ci
	npm run check

# A release is a version bump and a tag in one commit on main: `make release VERSION=0.1.0`
# commits "release: v0.1.0", tags v0.1.0, and pushes both. npm refuses a dirty tree.
release: build
	test -n "$(VERSION)" || { echo "usage: make release VERSION=0.1.0"; exit 2; }
	test "$$(git rev-parse --abbrev-ref HEAD)" = main || { echo "release from main"; exit 2; }
	npm version "$(VERSION)" -m "release: v%s"
	git push origin main "v$(VERSION)"

# Installs a tagged version, the latest by default: clones the tag, installs its runtime dependencies,
# and runs its own `install`, which places it at ~/.local/share/factory-runner/versions/<version>
# and reloads the LaunchAgent. `make deploy TAG=v0.1.0` installs that one instead, for a rollback;
# take self-update out of the way first (README, "Release and deploy").
deploy:
	test -n "$(TAG)" || { echo "no v* tag on $(REPO); run make release first"; exit 2; }
	tmp=$$(mktemp -d) && trap 'rm -rf "$$tmp"' EXIT && \
	git clone -q --depth 1 --branch "$(TAG)" "$(REPO)" "$$tmp" && \
	cd "$$tmp" && npm ci --omit=dev && $(NODE) src/bin.ts install
