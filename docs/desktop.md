# Desktop builds

The tray client is packaged with `electron-builder`. Build commands run the
Electron/Vite production build first and place artifacts in
`apps/desktop/dist/`.

From the repository root:

```sh
# Unpacked app for the current operating system and architecture
pnpm --filter @clipboard-mate/desktop package:dir

# Windows x64 NSIS installer (run on Windows)
pnpm --filter @clipboard-mate/desktop package:win

# macOS Intel and Apple Silicon DMG and ZIP artifacts (run on macOS)
pnpm --filter @clipboard-mate/desktop package:mac
```

Windows installers are per-user, offer an installation directory, and add a
Start Menu shortcut without adding a desktop shortcut. macOS produces both DMG
and ZIP files for each supported architecture.

## Signing boundary

The repository contains no signing identities, certificates, notarization
credentials, or publishing tokens. Local builds are therefore unsigned. This
is suitable for development, but Windows SmartScreen and macOS Gatekeeper will
warn users. Add signing and Apple notarization through CI secrets before public
distribution; do not commit those credentials or an `electron-builder.env`
file.

Build the Windows installer on Windows and the macOS artifacts on macOS. The
macOS script creates both architectures, but it does not create a universal
binary. Publishing and automatic updates are deliberately not configured yet.
