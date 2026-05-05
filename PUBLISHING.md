# Publishing checklist

## GitHub

```bash
cd cmux-pi-extensions
git init
git add .
git commit -m "Initial Pi CMUX extension family package"
gh repo create gtwatts/pi-cmux --public --source=. --remote=origin --push
```

If you do not use the `gtwatts/pi-cmux` repo name, update `package.json` and this file.

## npm and pi.dev catalog

The pi.dev package catalog lists npm packages tagged with `pi-package`.

```bash
npm login
npm pack --dry-run
npm publish --access public
```

Then test from a clean shell:

```bash
pi -e npm:@gtwatts/pi-cmux
pi install npm:@gtwatts/pi-cmux
```

## Versioning

```bash
npm version patch
npm publish --access public
git push --follow-tags
```

## Before publishing

- Decide whether MIT is the intended license.
- Optionally add `pi.image` or `pi.video` gallery metadata to `package.json`.
- Run a local install smoke test.
- Inspect `npm pack --dry-run` output for private files.
