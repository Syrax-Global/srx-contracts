# Contributing

This is a private repository belonging to Syrax Global FZCO. Contributions come from
the internal team and from people specifically engaged to work on it. See `NOTICE`
for the terms under which access is granted.

## Before you start

- **GitLab is the source of truth; GitHub is a mirror.** Push to GitLab. A push made
  directly to GitHub can be silently overwritten the next time the mirror runs.
- Work on a branch. The default branch is not written to directly.
- Read the repository's `README.md` for how to run and test it.

## Pull requests

- One logical change per pull request; keep it reviewable.
- The description says **what changed and why**, and how it was verified. "Tests pass"
  is not verification unless you say which tests and what they prove.
- Every pull request needs a review before it is merged.
- Continuous integration must be green.

## Commit messages

- Write a short imperative subject line, then a body explaining the reasoning.
- ⛔ **Do not add tool-generated attribution trailers of any kind.** An automated check
  rejects them.

## Money, keys and data

- Amounts are integers or decimal types — **never floating point**, and they are stored
  as strings.
- ⛔ Private keys, recovery phrases, tokens and passwords never appear in source code,
  in logs, in tests, in fixtures or in a commit message.
- Never commit a `.env` file, a log file, a build output directory, or a dependency
  directory. If one is already committed, raise it rather than deleting it quietly.

## Security

See `SECURITY.md`.
