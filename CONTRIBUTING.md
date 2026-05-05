# Contributing

Thanks for improving the CMUX Pi extension family.

## Development loop

```bash
pi -e ./cmux-pi-extensions
npm pack --dry-run
```

Keep the four extensions compatible as a family. If a change affects shared state, bridge events, lock semantics, or cmux command construction, update the README and add a manual verification note in the pull request.

## Pull request checklist

- [ ] No secrets, machine-specific paths, or private state files are committed.
- [ ] `package.json` still includes the `pi-package` keyword.
- [ ] `npm pack --dry-run` includes only intended package files.
- [ ] Local smoke test with `pi -e ./cmux-pi-extensions` succeeds.
- [ ] Risky shell/browser behaviors are documented and guarded.
