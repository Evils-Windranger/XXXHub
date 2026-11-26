.PHONY: check test-rust test-web test-tv test-smoke i18n docs budget release-check purity

# The verification of record is GitHub Actions. These targets are the same
# commands CI runs, so a local run (when requested) and CI cannot drift.
check: test-rust test-web i18n docs budget release-check purity

test-rust:
	cargo check --manifest-path src-tauri/Cargo.toml --all-targets
	cargo test --manifest-path src-tauri/Cargo.toml --lib

test-web:
	pnpm build

test-tv:
	node scripts/check-version-sync.mjs --target tv
	VITE_APP_EDITION=tv pnpm build

test-smoke:
	pnpm test:smoke

budget:
	node scripts/check-size-budgets.mjs

i18n:
	node scripts/check-i18n.mjs

docs:
	node scripts/check-doc-links.mjs

release-check:
	node scripts/check-version-sync.mjs

purity:
	node scripts/check-shell-purity.mjs
