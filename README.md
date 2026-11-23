# mend — hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/q2457286086-sys/makefun-hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/q2457286086-sys/makefun-hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies AI-written edits in four formats — unified diff, SEARCH/REPLACE
blocks, V4A patches and JSON tool calls — to one written spec, run as
`node main.ts [options] [PATCH]`. Node 22, the standard library alone.

`SPEC.md` is the spec this implements. `main.ts` is the CLI (the kit starter
did sections 1–4, 9 and 10; sections 5–8 are written here). `runner.ts` is the
kit's trial runner, kept as it is. `check.ts` is the local practice runner
(`node check.ts <practice.json>`); it is not part of the entry.

Options: `--format=auto|unified|search-replace|v4a|json`, `--check` (report
without writing), `--strict` (exact matches only). Exit 0 applies every edit,
1 reports the edits that failed (nothing is written), 2 is a usage, parse or
format error. Output lists one line per changed file (`A`, `D`, `M`, or
`R <old> -> <new>` for a move), then `ok: N file(s)`.
