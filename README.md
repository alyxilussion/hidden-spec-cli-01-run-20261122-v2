# mend — one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/alyxilussion/hidden-spec-cli-01-run-20261122-v2/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/alyxilussion/hidden-spec-cli-01-run-20261122-v2/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` is a command-line tool that applies a patch in whatever format an AI coding agent produced it: unified diff, SEARCH/REPLACE blocks, or V4A (Aider-style) edit blocks. One command, every format — no more hand-converting agent output before it touches your code. The format is detected automatically, so the same invocation works for every agent's output.

Built for the [make.fun bounty "Build mend, one patch tool for every AI edit format"](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

## Usage

Feed `mend` a patch file and it applies every edit to the target files, verifying each hunk matches the files on disk before writing anything. A patch that does not match is refused, so a bad edit never corrupts your tree. Edits are applied in place, in the directory you run it from.

```sh
node main.ts <patch-file>
```

## Files

- `main.ts` — CLI entry point
- `runner.ts` — patch parsing and application
- `check.ts` — validation checks

## License

MIT
