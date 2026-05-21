# Building Linux releases (AppImage + deb)

AppImage requires Linux-only tooling (`mksquashfs`) that can't run on
Windows, so cross-builds from `npm run release` only produce the Windows
installer. There are two ways to ship Linux artifacts.

## Option A — let GitHub Actions build it for you

The workflow in `docs/release-linux-workflow.yml` runs on `ubuntu-22.04`
whenever a `v*` tag is pushed. It builds AppImage + deb and attaches them
to the existing GitHub release.

**One-time setup:**

1. Either generate a new Personal Access Token with the `workflow` scope
   (in addition to `repo`), or commit the workflow file via the GitHub
   web UI:

   - Open https://github.com/techvibedz/anime-desktop
   - Click **Add file → Create new file**
   - Path: `.github/workflows/release-linux.yml`
   - Paste the contents of `docs/release-linux-workflow.yml`
   - Commit to `main`

2. Now every time you tag a release locally + push the tag, the workflow
   will run and add Linux artifacts to that release.

**Day-to-day:**

```bash
# After bumping version + npm run release (which publishes Windows):
git tag v0.1.5
git push origin v0.1.5
# GitHub Actions kicks in, ~3 min later AppImage + deb appear in the release
```

## Option B — build locally on a Linux machine

If you have a Linux box (or WSL):

```bash
cd pantoufa-desktop
npm ci
GH_TOKEN=<your-token> npm run release:linux
```

That builds + uploads AppImage + deb to the latest matching GitHub release.
