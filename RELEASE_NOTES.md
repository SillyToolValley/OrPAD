# OrPAD v1.0.0-beta.5

OrPAD v1.0.0-beta.5 expands source and text file handling across the desktop
app, PWA file handler, and editor language detection.

## Changes

- Added desktop file associations for common source, stylesheet, script,
  config, diff, and SVG formats.
- Expanded the web app manifest file handlers so launched source/text files
  open through the PWA flow.
- Added CodeMirror language detection and async language loading for supported
  source file extensions.
- Updated quick-open format aliases for source, shell, diff, SVG, and related
  text formats.
- Added regression coverage for opening and saving editable source/text files
  on desktop and through the web launch flow.
