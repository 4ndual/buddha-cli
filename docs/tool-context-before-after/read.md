# read: model context before and after

Old source: commit `89c4b8dff5`. New source: current working-tree capture. [Tool implementation](../../packages/coding-agent/src/tools/read.ts). The descriptors and schemas were read from instantiated tools in isolated source checkouts.

| Measured surface | Before | After | Tokens saved |
| --- | ---: | ---: | ---: |
| Description | 913 | 56 | +857 |
| Provider tool definition (name + description + JSON Schema) | 961 | 115 | +846 |
| Full system-prompt inventory entry | 967 | 92 | +875 |

Counts use OMP's strict Tokenizer with its o200k fallback. The provider total is a local content count, not provider framing or billable usage. Inventory is rendered one tool at a time, including its examples when present. Native tool mode and prompt-inventory mode are alternatives, not additive.

## Before: description

```text
Read files, directories, archives, SQLite, images, documents, internal resources, and web URLs via `path`.

<instruction>
- SHOULD parallelize independent reads.
- SHOULD use `read` (not browser) for web content; browser only when `read` can't deliver.
</instruction>

## Selectors — append `:<sel>` to `path` (e.g. `src/foo.ts:50-200`, `src/foo.ts:raw`, `db.sqlite:users:42`)

- `:50` / `:50-` — from line 50 | `:50-200` — inclusive | `:50+150` — 150 lines from 50 | `:-60` — last 60 lines | `:5-16,960-973` — multiple ranges
- `:raw` — verbatim, no anchors/prefixes | `:2-4:raw` / `:raw:2-4` — range + verbatim
- `:conflicts` — one line per unresolved git merge conflict block
- `:img` — rasterize a local `.svg`/`.svgz` as a PNG image; use when visual layout matters
- `?q=<question>` — image only (also `.svg:img?q=`, `attachment://N?q=`, `local://…?q=`): vision-model answer as text instead of pixels
- Videos (`.mp4`, `.mov`, `.mkv`, `.webm`, `.m4v`, `.avi`, `.wmv`) need system `ffmpeg`/`ffprobe`: bare read returns a preview grid plus metadata (resolution, codecs, duration, fps); `:412` extracts frame 412, `:1h5m42s`/`:90s`/`:01:23` seeks to a timestamp

## Source kinds

- Parseable code, no selector → structural summary (declarations only, body elided). Footer names recovery selector — re-issue ONLY those ranges.
- File + selector → `[foo.ts#1A2B]` snapshot header + numbered lines. Copy `[FILENAME#TAG]` for anchored edits; NEVER fabricate the tag.
- Directory → depth-limited dirent listing.
- SQLite (`.sqlite`, `.sqlite3`, `.db`, `.db3`): `file.db` (tables), `file.db:table` (schema+rows), `file.db:table:key` (by PK), `?limit=`/`?where=`/`?q=SELECT`.
- Archives (`.zip` family incl. `.jar`/`.apk`/`.whl`, `.tar` incl. `.tar.{gz,bz2,xz,zst}`, `.rar`, `.7z`, `.iso`, `.cab`, `.deb`/`.rpm`/`.cpio`/`.ar`/`.a`, `.lzh`/`.arj`, `.asar`; single-stream `.gz`/`.bz2`/`.xz`/`.zst`): `archive.ext:path/inside/archive` reads a member.
- Documents → extracted text. Notebooks → editable cells. Images → decoded inline; `img.png?q=<question>` asks a vision model and returns text (spares context; works on any model). Videos → preview grid plus metadata. SVGs read as text unless `:img` is specified. `:raw` bypasses converters.
- URLs → reader-mode clean text/markdown; `:raw` → untouched HTML. Bare `host:port` needs trailing slash.
- Internal URIs — all schemes take selectors. `artifact://<id>` recovers spilled output; page with `:N-M`/`:raw:N-M`.
- `ssh://host/<path>` reads remote file/dir (UTF-8, ≤1 MiB); bare `ssh://` lists hosts; writable with `write` and searchable with `grep`.
  Literal `:`, `?`, `#` → percent-encode (`%3A`/`%3F`/`%23`). Requires a verified POSIX shell on the remote host. For Windows or other unsupported hosts, use `bash` with a remote SSH command or mount with `sshfs`.

<critical>
Summary footer names elided ranges? Re-issue ONLY those ranges. NEVER guess `..`/`…` content.
</critical>
```

## After: description

```text
Read a file, URL, or internal URI with path selectors for ranges (default 3000 lines). ssh://host/path is writable with `write` and searchable with `grep`; unsupported hosts: use `bash` with a remote SSH command or mount with `sshfs`.
```

## Before: input JSON Schema

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Local path, internal URI (e.g. skill://), or URL. Inline selectors are supported."
    }
  },
  "required": [
    "path"
  ],
  "additionalProperties": false
}
```

## After: input JSON Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "path": {
      "description": "File path, skill:// URI, URL; path selectors select a range.",
      "type": "string"
    }
  },
  "required": [
    "path"
  ],
  "additionalProperties": false
}
```

## Before: complete inventory entry

```text
## functions

namespace functions {

// Read files, directories, archives, SQLite, images, documents, internal resources, and web URLs via `path`.
//
// <instruction>
// - SHOULD parallelize independent reads.
// - SHOULD use `read` (not browser) for web content; browser only when `read` can't deliver.
// </instruction>
//
// ## Selectors — append `:<sel>` to `path` (e.g. `src/foo.ts:50-200`, `src/foo.ts:raw`, `db.sqlite:users:42`)
//
// - `:50` / `:50-` — from line 50 | `:50-200` — inclusive | `:50+150` — 150 lines from 50 | `:-60` — last 60 lines | `:5-16,960-973` — multiple ranges
// - `:raw` — verbatim, no anchors/prefixes | `:2-4:raw` / `:raw:2-4` — range + verbatim
// - `:conflicts` — one line per unresolved git merge conflict block
// - `:img` — rasterize a local `.svg`/`.svgz` as a PNG image; use when visual layout matters
// - `?q=<question>` — image only (also `.svg:img?q=`, `attachment://N?q=`, `local://…?q=`): vision-model answer as text instead of pixels
// - Videos (`.mp4`, `.mov`, `.mkv`, `.webm`, `.m4v`, `.avi`, `.wmv`) need system `ffmpeg`/`ffprobe`: bare read returns a preview grid plus metadata (resolution, codecs, duration, fps); `:412` extracts frame 412, `:1h5m42s`/`:90s`/`:01:23` seeks to a timestamp
//
// ## Source kinds
//
// - Parseable code, no selector → structural summary (declarations only, body elided). Footer names recovery selector — re-issue ONLY those ranges.
// - File + selector → `[foo.ts#1A2B]` snapshot header + numbered lines. Copy `[FILENAME#TAG]` for anchored edits; NEVER fabricate the tag.
// - Directory → depth-limited dirent listing.
// - SQLite (`.sqlite`, `.sqlite3`, `.db`, `.db3`): `file.db` (tables), `file.db:table` (schema+rows), `file.db:table:key` (by PK), `?limit=`/`?where=`/`?q=SELECT`.
// - Archives (`.zip` family incl. `.jar`/`.apk`/`.whl`, `.tar` incl. `.tar.{gz,bz2,xz,zst}`, `.rar`, `.7z`, `.iso`, `.cab`, `.deb`/`.rpm`/`.cpio`/`.ar`/`.a`, `.lzh`/`.arj`, `.asar`; single-stream `.gz`/`.bz2`/`.xz`/`.zst`): `archive.ext:path/inside/archive` reads a member.
// - Documents → extracted text. Notebooks → editable cells. Images → decoded inline; `img.png?q=<question>` asks a vision model and returns text (spares context; works on any model). Videos → preview grid plus metadata. SVGs read as text unless `:img` is specified. `:raw` bypasses converters.
// - URLs → reader-mode clean text/markdown; `:raw` → untouched HTML. Bare `host:port` needs trailing slash.
// - Internal URIs — all schemes take selectors. `artifact://<id>` recovers spilled output; page with `:N-M`/`:raw:N-M`.
// - `ssh://host/<path>` reads remote file/dir (UTF-8, ≤1 MiB); bare `ssh://` lists hosts; writable with `write` and searchable with `grep`.
//   Literal `:`, `?`, `#` → percent-encode (`%3A`/`%3F`/`%23`). Requires a verified POSIX shell on the remote host. For Windows or other unsupported hosts, use `bash` with a remote SSH command or mount with `sshfs`.
//
// <critical>
// Summary footer names elided ranges? Re-issue ONLY those ranges. NEVER guess `..`/`…` content.
// </critical>
type read = (_: {
// Local path, internal URI (e.g. skill://), or URL. Inline selectors are supported.
path: string,
});

} // namespace functions
```

## After: complete inventory entry

```text
## functions

namespace functions {

// Read a file, URL, or internal URI with path selectors for ranges (default 3000 lines). ssh://host/path is writable with `write` and searchable with `grep`; unsupported hosts: use `bash` with a remote SSH command or mount with `sshfs`.
type read = (_: {
// File path, skill:// URI, URL; path selectors select a range.
path: string,
});

} // namespace functions
```

The TypeScript source is **not** sent to the model. OMP sends one of the generated surfaces above, depending on provider and session configuration.
