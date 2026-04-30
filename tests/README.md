# OrPAD E2E Smoke Tests

Playwright test suite covering 15 critical paths in the desktop (Electron) and web builds.

## Running tests

```bash
# Install browsers once
npx playwright install chromium

# All tests (electron + web)
npm test

# Electron tests only (tests 1–14)
npm run test:electron

# Web test only (test 15) — requires docs/ to be built first
npm run build:web:min && npm run test:web

# Orchestration Machine kernel/fixture tests
npm run test:machine

# Interactive UI mode (local dev)
npm run test:ui
```

## Structure

```
tests/
  e2e/              – 15 *.spec.ts files (one per feature)
  fixtures/         – small static files committed to the repo
  orchestration-machine/
                    – Node built-in test runner coverage for Machine kernel fixtures
  helpers.ts        – launchElectron() and startStaticServer() utilities
  README.md         – this file
```

## Known issues

### Windows Defender flakiness (_electron.launch)

On machines with Windows Defender real-time scanning enabled, `_electron.launch()`
can time out on first run while the scanner inspects the Electron binary.
CI is configured with `retries: 2` to absorb this. If you see consistent
timeouts locally, add the `node_modules/.bin/` directory to Windows Defender
exclusions or pre-warm by running `npm start` once.

### Mermaid rendering timeout

Mermaid renders diagrams asynchronously and can be slow on low-end CI runners.
`markdown-mermaid.spec.ts` uses a 20 s timeout; if this is still flaky, pass
`--timeout=60000` on that spec file.

### Web test requires built docs/

`web-open.spec.ts` serves the `docs/` directory. Since `docs/` is not tracked
in git, the test skips automatically when `docs/index.html` is absent.
The `e2e.yml` CI workflow runs `npm run build:web:min` before the test.
