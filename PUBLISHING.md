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
- Confirm `pi.image` points to the intended GitHub raw social preview image, or replace it with `pi.video` if you create an MP4 preview.
- In GitHub repository settings, upload `assets/social-preview.jpg` under **Social preview** so LinkedIn unfurls use the custom image.
- Run a local install smoke test.
- Inspect `npm pack --dry-run` output for private files.
