# Anki Glasses

A personal app for Even G2 glasses and the R1 ring, maintained by `kenjimax`.
The repository is public.

- Keep personal collection details out of tracked files: deck names, machine
  addresses, and keys. `anki-glasses.config.json` is ignored for that reason;
  change `anki-glasses.config.example.json` when a field is added.
- Work in session-owned worktrees and preserve unrelated changes.
- After explicitly requested work is tested and reviewed, open its pull request
  and squash merge it. The maintainer set this merge policy on 2026-09-10.
- Run `npm test`, `npm run typecheck`, and `npm run build` for code changes.
  Run the official simulator checks when display or gesture behavior changes.
- Use adversarial review for significant application changes. Fix verified
  qualifying findings before merging.
- Simulator checks are preflight evidence. Do not claim a real G2/R1 hardware
  test until the release has been exercised on those devices.
- Keep Anki access keys in environment variables, outside version control.
- Skipped cards must remain due and ungraded for normal desktop review.
