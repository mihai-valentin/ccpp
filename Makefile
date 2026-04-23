# ccpp — CI-portable entrypoints.
#
# These goals wrap the npm scripts so a CI runner (GitHub Actions, Bitbucket
# Pipelines, self-hosted) can invoke one of {ci, verify, release-dry, release}
# without knowing the project's internals. Every goal is idempotent; anything
# that depends on `dist/` runs `build` first.
#
# Common invocations:
#   make ci              what a CI pipeline runs — install, build, typecheck, test, pack-check
#   make verify          local-dev full check — ci + smoke + audit
#   make smoke           build + bash scripts/smoke.sh (end-to-end sanity)
#   make pack-check      dry-run `npm pack` to inspect the shipped tarball
#   make release-dry     rehearse a publish without uploading
#   make release         actually publish (guards against dirty tree + placeholder URL)
#   make help            list targets
#
# CI detection: when the `CI` env var is set (GitHub / Bitbucket / GitLab all
# export it), `install` uses `npm ci` for reproducibility. Locally, `npm install`
# is used so dependency adds don't require a clean checkout.

.DEFAULT_GOAL := help
SHELL := bash
.SHELLFLAGS := -euo pipefail -c
MAKEFLAGS += --no-print-directory

NPM_INSTALL ?= $(if $(CI),npm ci,npm install)

## help: List every target.
.PHONY: help
help:
	@awk 'BEGIN {FS = ":.*?## "} /^## [a-zA-Z0-9_.-]+:/ { \
		sub(/^## /, "", $$0); \
		split($$0, a, ":"); \
		printf "  \033[1;36m%-14s\033[0m %s\n", a[1], substr($$0, index($$0, ":") + 2) \
	}' $(MAKEFILE_LIST)

## install: Install dependencies (npm ci under CI, npm install locally).
.PHONY: install
install:
	@$(NPM_INSTALL)

## build: Compile dist/ via tsup.
.PHONY: build
build:
	@npm run build

## test: Run the full vitest suite once (non-interactive).
.PHONY: test
test:
	@npx vitest run

## typecheck: tsc --noEmit over src/.
.PHONY: typecheck
typecheck:
	@npm run typecheck

## lint: biome check. Advisory — NOT in the CI gate (pre-existing style drift).
.PHONY: lint
lint:
	@npm run lint

## smoke: Build + bash scripts/smoke.sh (end-to-end against a local git fixture).
.PHONY: smoke
smoke: build
	@bash scripts/smoke.sh

## pack-check: npm pack --dry-run. Confirms the published tarball's shape.
.PHONY: pack-check
pack-check: build
	@npm pack --dry-run

## audit: npm audit against production dependencies. Strict — fails on any finding.
.PHONY: audit
audit:
	@npm audit --omit=dev --audit-level=low

## ci: What a CI pipeline runs. Fast, deterministic, no external I/O beyond git.
.PHONY: ci
ci: install build typecheck test pack-check
	@echo "✓ ci: all gates green"

## verify: Superset of ci — adds bash smoke and an npm audit.
.PHONY: verify
verify: ci smoke audit
	@echo "✓ verify: full local gate green"

## release-dry: Rehearse a publish end-to-end without uploading to the registry.
.PHONY: release-dry
release-dry: verify
	@npm publish --dry-run

## release: Publish to npm. Refuses if the tree is dirty or the placeholder URL remains.
.PHONY: release
release: verify
	@if [ -n "$$(git status --porcelain)" ]; then \
		echo "✗ working tree is dirty — commit or stash before releasing"; \
		exit 1; \
	fi
	@if grep -q "REPLACE_WITH_REMOTE_URL" package.json; then \
		echo "✗ package.json still has REPLACE_WITH_REMOTE_URL — set the remote first"; \
		exit 1; \
	fi
	@npm publish

## clean: Remove build artifacts (dist/, generated tarballs). Keeps node_modules.
.PHONY: clean
clean:
	@rm -rf dist *.tgz

## distclean: clean + remove node_modules for a fully fresh state.
.PHONY: distclean
distclean: clean
	@rm -rf node_modules
