GO ?= go
BACKEND_DIR := backend
UI_DIR := ui
CACHE ?= ${TMPDIR:-/tmp}/nintyapi-go-build

.PHONY: test frontend build dev package dbxp

# Run the backend suite with a throwaway build cache.
test:
	cd $(BACKEND_DIR) && GOCACHE=$(CACHE) $(GO) test -mod=readonly ./...

# Build the static frontend bundle.
frontend:
	cd $(UI_DIR) && npm run build

# Backend tests + sidecar binary + frontend bundle, in one shot.
build:
	./scripts/build.sh

# Serve the development host on a loopback port.
dev:
	dbx-plugin dev --path . --port $${PORT:-5190}

# Package an unsigned candidate into OUTPUT_DIR (default: dist).
package:
	dbx-plugin package . --output-dir $${OUTPUT_DIR:-dist}

dbxp: build
	dbx-plugin package . --output-dir $${OUTPUT_DIR:-dist}
