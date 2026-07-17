# Scoop manifest maintenance

The manifest in this directory installs the official 64-bit Word Hunter
portable ZIP from GitHub Releases. It is usable as a local manifest while a
small dedicated Scoop bucket is being prepared.

For each stable release:

1. update `version`, the immutable release URL, and the SHA-256 in
   `wordhunter.json`;
2. keep the `checkver` tag expression and `autoupdate` URL in sync with the
   `WordHunter<version>` release-tag convention;
3. let the package-store GitHub Actions workflow verify Scoop `checkver`, the
   archive checksum, and required files;
4. after a dedicated bucket exists, use Scoop's `checkver.ps1 -Update` there to
   generate the version bump and test the resulting manifest on CI.

The official Extras request currently cannot be submitted honestly because its
request form requires the app to be reasonably well-known (for example, at
least 100 GitHub stars or 50 forks). Recheck the live form before proposing the
package:

- https://github.com/ScoopInstaller/Extras/issues/new?template=package-request.yml
- https://github.com/ScoopInstaller/Scoop/wiki/App-Manifests
- https://github.com/ScoopInstaller/Scoop/wiki/App-Manifest-Autoupdate
