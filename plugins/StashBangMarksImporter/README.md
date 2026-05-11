# Bang Marks Importer

Bang Marks Importer is a Stash plugin that imports Bang.com video chapters as Stash scene markers.

The plugin reads a Bang.com video page URL from a Stash scene, extracts Bang's internal video ID, fetches the WEBVTT chapters endpoint, and creates scene markers from the chapter data.

## Features

- Imports Bang.com chapters as Stash scene markers.
- Works from a single scene detail page.
- Supports bulk import for selected scenes.
- Uses existing Stash tags only.
- Matches chapter names to the nearest existing tag.
- Uses tag names and aliases for matching.
- Skips low-confidence tag matches.
- Skips duplicate markers.
- Uses native Stash toast notifications.
- Does not create tags.
- Does not save downloaded HTML or WEBVTT files to disk.

## Expected URL format

The scene should contain a regular Bang.com video page URL

