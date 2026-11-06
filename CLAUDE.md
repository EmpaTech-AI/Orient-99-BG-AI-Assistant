# Orient99 AI Assistant

## Tests (the engineer's decision of 2026-11-06)

- The jest suite is a core of about 100 tests (cut from 192 on 2026-11-06). Keep it that size: a fix changes or replaces the test of its behaviour; it does not add a test per fix round, a phrasing table, a test of a fixture or of the QA tooling. A new behaviour gets at most a few tests, through the existing helpers.
- `npm test` is silent and takes about 15 s: run it before a commit. While working, run the one file you changed (`npx jest src/catalog/search.spec.ts`).
- `test/replay-869fnmpyu.ts` calls OpenAI and costs money: run it only when the engineer asks.

## Process

- Only the stages that prove something run: the change, `npm test`, one /review, the live replay when the agent's answers change, the PR, the second signature, the engineer's merge and live test. Skipped gates go to `.gstack-flightplan/overrides.jsonl` in the engineer's words.
