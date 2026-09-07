# Contributing to zagent

Thanks for your interest! zagent is an unofficial, non-commercial-intent, GLM-native
terminal client. Contributions are welcome.

## Ground rules
- **Never commit secrets** — keys, tokens, account profiles, `~/.zcode` config, or
  credential stores. Redact prompts, workspace paths, and billing data from examples.
- Keep changes focused; one concern per PR. Conventional Commit messages appreciated
  (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
- This project drives **your own** installed ZCode runtime with **your own** account.
  Do not add code that redistributes upstream binaries or targets accounts you don't own.

## Dev
```bash
npm install
npm test        # packs, installs into a disposable prefix, runs the offline smoke
```
Node.js >= 22.5. The package is runtime- and account-free to test (the smoke runs offline).

## Reporting bugs / ideas
Use the issue templates for bugs and feature requests; use
[Discussions](https://github.com/agent-next/zagent/discussions) for questions and ideas.

## License
By contributing you agree your contributions are licensed under the project's
[MIT license](LICENSE).
