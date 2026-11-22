# Swift Site

A faster drop-in for makefun-site 1.0.0: it builds the same static site, byte
for byte, in less CPU time. Single-pass Markdown rendering, bulk HTML
escaping, memoised slugs, and templates parsed once and walked with an output
buffer — no dependencies.

[![make.fun bounty](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/DarelHarteraVBY2C/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/DarelHarteraVBY2C/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

Built for the [make.fun bounty](https://make.fun/bounty/site-generator-speed-01-run-20261122):
write a faster drop-in for makefun-site 1.0.0 that answers exactly as it does
on every case.

## Layout

- `solve.js` — the entry: `run(input)` returns the output tree for one case.
- `main.ts` — the driver the harness runs: reads `/input/cases.json`, answers
  each case with `run`, writes `/output/answers.json`.
