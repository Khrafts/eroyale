## Status
- Step: 3-5 of 6 (live server, relayer behind CHAIN, signed orders) committed; replay test next.
- Last gate: `bash gates/engine.sh` -> GATE PASS engine (seed 42: 6 finalists).
- Live: `CHAIN=off npm run dev -- --bots 20 --preset stage` ran a full match to `final` over WS.
- Next: test `--resume` after a mid-match kill, finish NOTES.
- Blockers: none.

# Engine notes
