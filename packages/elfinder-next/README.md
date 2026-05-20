# elfinder-next

**elFinder 2.1 connector backend for Next.js App Router**

[![npm version](https://img.shields.io/npm/v/elfinder-next.svg)](https://www.npmjs.com/package/elfinder-next)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> **v0.1.0 — First public release.**  
> This is the initial version of the package. APIs and defaults may evolve in future releases; pin your version in production and review release notes when upgrading.

---

## Overview

[elFinder](https://github.com/Studio-42/elFinder) is a popular open-source file manager for the web. It expects a **connector** endpoint that speaks the elFinder 2.1 JSON protocol (browse, upload, rename, archive, thumbnails, and more).

**elfinder-next** provides that connector as a small, typed npm library for **Next.js 14+** (App Router). Instead of maintaining a large `route.ts` by hand, you install the package, call `createElfinderHandler()`, and re-export `GET`, `POST`, and `runtime` from your API route.

### What this package does

| Responsibility | Details |
|----------------|---------|
| **Protocol** | Implements elFinder 2.1 connector commands (`open`, `upload`, `paste`, `archive`, …) |
| **Storage** | Reads and writes files on the local filesystem under a configurable root directory |
| **Thumbnails** | Generates image thumbnails with [sharp](https://sharp.pixelplumbing.com/) |
| **Archives** | Creates and extracts ZIP archives via [adm-zip](https://www.npmjs.com/package/adm-zip) |
| **Uploads** | Supports standard and chunked multipart uploads |

### What you still need

- A **Next.js** application with the App Router
- An **elFinder frontend** (jQuery elFinder or a wrapper) pointed at your API route URL
- Files under `public/` (or equivalent static hosting) so `publicUrl` and `tmbUrl` paths are reachable by the browser

The package is **backend-only**. It does not bundle the elFinder UI.

---

## Requirements

- **Node.js** 18+ (20+ recommended)
- **Next.js** 14 or later (App Router, `route.ts` handlers)
- **Runtime:** Node.js (`export const runtime = "nodejs"` is included in the handler exports)

Bundled dependencies: `sharp`, `adm-zip`, `mime-types`.

---

## Installation

```bash
npm install elfinder-next
# or
pnpm add elfinder-next
# or
yarn add elfinder-next
```

Ensure `next` is installed in your project (peer dependency).

For production builds with Next.js, add native/heavy packages to server externals when recommended by your Next version:

```ts
// next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["sharp", "adm-zip"],
};

export default nextConfig;
```

---

## Quick start

### 1. Create the API route

```ts
// app/api/elfinder/route.ts
import { createElfinderHandler } from "elfinder-next";

export const { GET, POST, runtime } = createElfinderHandler();
```

Defaults:

- Files are stored in `<project>/public/uploads`
- Public URLs use `/uploads/` and `/uploads/.tmb/`

### 2. Ensure the upload directory exists

The handler creates `uploads`, `.tmb`, and `.chunks` on first request. For version control, you may add an empty folder:

```
public/
  uploads/
    .gitkeep
```

### 3. Connect the elFinder frontend

Point the client connector `url` at your route (no trailing slash required by elFinder, but be consistent):

```js
$("#elfinder").elfinder({
  url: "/api/elfinder",
  // ...other elFinder options
});
```

Previews and thumbnails require that `publicUrl` and `tmbUrl` match paths actually served from `public/` (or your CDN).

---

## Configuration

Pass an optional options object to `createElfinderHandler`:

```ts
import path from "path";
import { createElfinderHandler } from "elfinder-next";

export const { GET, POST, runtime } = createElfinderHandler({
  uploadDir: path.join(process.cwd(), "public", "media"),
  rootName: "media",
  volumeId: "v1_",
  publicUrl: "/media/",
  tmbUrl: "/media/.tmb/",
});
```

| Option | Default | Description |
|--------|---------|-------------|
| `uploadDir` | `public/uploads` (resolved from `process.cwd()`) | Absolute or relative filesystem root for the volume. All paths are confined under this directory. |
| `rootName` | `uploads` | Display name of the volume root in elFinder. |
| `volumeId` | `v1_` | Prefix for volume hashes (elFinder `hash` / `phash` encoding). |
| `publicUrl` | `/uploads/` | Base URL for file previews (must end with `/`; added automatically if omitted). |
| `tmbUrl` | `/uploads/.tmb/` | Base URL for thumbnail files (must align with files written under `uploadDir/.tmb/`). |

### TypeScript exports

```ts
import {
  createElfinderHandler,
  type ElfinderOptions,
  type ElfinderHandlers,
  type ElfinderFile,
} from "elfinder-next";
```

---

## How it works

```
┌─────────────────┐     GET/POST      ┌──────────────────────┐
│  elFinder UI    │ ────────────────► │  Next.js route       │
│  (browser)      │   /api/elfinder   │  createElfinderHandler│
└─────────────────┘                   └──────────┬───────────┘
                                                 │
                    ┌────────────────────────────┼────────────────────────────┐
                    ▼                            ▼                            ▼
             JSON commands              multipart upload              file download
             (open, tree, …)            (upload, chunks)              (cmd=file)
                    │                            │
                    └──────────────┬─────────────┘
                                   ▼
                          ┌─────────────────┐
                          │  uploadDir/     │
                          │  ├── files…     │
                          │  ├── .tmb/      │
                          │  └── .chunks/   │
                          └─────────────────┘
```

1. elFinder sends `cmd` (and parameters) via query string, form data, or JSON body.
2. The handler validates paths stay inside `uploadDir` (path traversal protection).
3. Responses follow the elFinder 2.1 JSON shape (`cwd`, `files`, `added`, `error`, …).

Static assets under `public/` are served by Next.js; the connector only manages the filesystem and JSON protocol.

---

## Supported connector commands

| Command | Method | Notes |
|---------|--------|-------|
| `open` | GET | List directory; `init=1` returns API version and root options |
| `tree` | GET | Folder tree for navigation |
| `parents` | GET | Parent folders for breadcrumbs |
| `mkdir` | GET/POST | Create folder |
| `mkfile` | GET/POST | Create empty file |
| `rm` | GET/POST | Delete targets |
| `rename` | GET/POST | Rename file or folder |
| `duplicate` | GET/POST | Copy in same directory with `(copy)` suffix |
| `paste` | GET/POST | Copy or cut into destination |
| `file` | GET | Download or inline file content |
| `get` / `put` | GET/POST | Read/write text file content |
| `ls` | GET | Simple name list |
| `info` | GET/POST | Metadata for targets |
| `search` | GET | Recursive name search |
| `size` | GET | Total size of targets |
| `tmb` | GET | Thumbnail map for images |
| `archive` | GET/POST | ZIP selected items into archive |
| `extract` | GET/POST | Extract ZIP |
| `zipdl` | GET/POST | Create ZIP for download workflow |
| `dim` | GET | Returns `unknown` (placeholder) |
| `upload` | POST | Multipart upload; supports chunked uploads |
| `resize` | — | **Not implemented** (returns 400) |

Unknown commands return `400` with `{ error: "Command not implemented: …" }`.

---

## Security considerations

**v0.1.0 is intended for trusted or development environments.** Before exposing a volume in production:

- **Authenticate** requests in middleware or wrap the route so only authorized users reach the connector.
- **Scope** `uploadDir` to a dedicated directory; never point it at project root or sensitive paths.
- **Review** elFinder client options (allowed MIME types, max upload size) on the frontend.
- **Rate-limit** upload and archive endpoints if exposed publicly.

Path traversal is mitigated by resolving all paths under `uploadDir`, but authorization is your responsibility.

---

## Error handling

Errors are returned as JSON:

```json
{ "error": "Access denied" }
```

| HTTP status | Typical cause |
|-------------|----------------|
| `403` | Path escapes `uploadDir` |
| `400` | Invalid command, target, or arguments |
| `500` | Unexpected filesystem or processing error |

---

## Limitations (v0.1.0)

- Single local volume per handler instance
- No `resize` command
- No cloud storage backends (S3, etc.)
- Archivers limited to ZIP via `adm-zip`
- `chmod`, `netmount`, and volume `size` are disabled on the root options object

These may be addressed in later versions.

---

## Development (package maintainers)

From the monorepo root:

```bash
pnpm install
pnpm --filter elfinder-next build
pnpm --filter elfinder-next dev   # watch mode
```

Publish flow:

```bash
cd packages/elfinder-next
pnpm build
npm publish
```

---

## License

MIT

---

## Links

- [elFinder project](https://github.com/Studio-42/elFinder)
- [elFinder 2.1 client API](https://github.com/Studio-42/elFinder/wiki/Client-configuration-options)
- [Repository monorepo](https://github.com/your-org/elfinder-next) — replace with your Git URL when published
