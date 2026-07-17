# Scoop manifest maintenance

The manifest in this directory installs the official 64-bit Word Hunter
portable ZIP from GitHub Releases. The canonical public copy is published in
the [official Word Hunter Scoop bucket](https://github.com/Ironship/scoop-wordhunter);
this source copy keeps release validation close to the application version.

Install the public package with:

```powershell
scoop bucket add wordhunter https://github.com/Ironship/scoop-wordhunter
scoop install wordhunter/wordhunter
```

For each stable release:

1. update `version`, the immutable release URL, and the SHA-256 in
   `wordhunter.json`;
2. keep the `checkver` tag expression and `autoupdate` URL in sync with the
   `WordHunter<version>` release-tag convention;
3. let the package-store GitHub Actions workflow verify Scoop `checkver`, the
   archive checksum, and required files;
4. let the bucket's pinned Excavator workflow update and test its public copy,
   and review the generated commit before announcing the new package version.

The official Extras request currently cannot be submitted honestly because its
request form requires the app to be reasonably well-known (for example, at
least 100 GitHub stars or 50 forks). Recheck the live form before proposing the
package:

- https://github.com/ScoopInstaller/Extras/issues/new?template=package-request.yml
- https://github.com/ScoopInstaller/Scoop/wiki/App-Manifests
- https://github.com/ScoopInstaller/Scoop/wiki/App-Manifest-Autoupdate
