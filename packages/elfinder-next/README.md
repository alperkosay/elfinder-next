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

- **Node.js** 20.3 or later
- **Next.js** 14 or later (App Router, `route.ts` handlers)
- **Runtime:** Node.js (`export const runtime = "nodejs"` is included in the handler exports)

Bundled dependencies: `sharp`, `adm-zip`, `mime-types`.

The Node floor is not arbitrary, so please do not lower it: upload handling tests
`instanceof File`, and `File` only became a global in Node 20, while `sharp`
declares `^18.17.0 || ^20.3.0 || >=21.0.0`. The overlap starts at 20.3.

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
| `authorize` | none | Gates each request and returns the session. Returning `null` answers HTTP 403. **Omitting it leaves the volume open.** See [Authorization](#authorization). |
| `permissions` | none | Per-path `read` / `write` / `locked`, given the session. Omitted flags stay permissive. |
| `maxArchiveEntries` | `10000` | Largest entry count `extract` will unpack. |
| `maxArchiveBytes` | 1 GiB | Largest total uncompressed size `extract` will unpack. |
| `chunkTtlMs` | 24 hours | How long an abandoned chunked upload's parts survive before being swept. |

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

## Authorization

**Without an `authorize` hook the connector is open**: anyone who can reach the route can read and write the whole volume. Nothing else in the package makes that decision for you.

### Gating the request

`authorize` runs once per request, before any command. Return anything truthy to allow it, and `null` to refuse. Refusal answers **HTTP 403**, so proxies and monitoring can see it and the app can redirect an expired session to sign-in.

```ts
export const { GET, POST, runtime } = createElfinderHandler({
  uploadDir: "/srv/files",
  authorize: async (request) => {
    const user = await getUser(request);
    return user ? { id: user.id, role: user.role } : null;
  },
});
```

A callback that forgets to return a value denies the request. That is deliberate: the failure mode of a mistake should be a locked door.

### Scoping what a caller may do

`permissions` is asked about one path at a time, relative to the volume root, with the session `authorize` returned. Whatever it omits stays permissive.

```ts
createElfinderHandler({
  uploadDir: "/srv/files",
  authorize: async (request) => (await getUser(request)) ?? null,
  permissions: (relativePath, session) => ({
    read: !relativePath.startsWith("private/"),
    write: session.role === "editor",
    locked: relativePath === "system",
  }),
});
```

| Flag | Denying it refuses | Default |
|------|--------------------|---------|
| `read` | `open`, `ls`, `tree`, `get`, `file`, `search`, `size`, and use as a copy source | `true` |
| `write` | `mkdir`, `mkfile`, `put`, `upload`, `paste` into it, `duplicate`, `archive`, `extract` | `true` |
| `locked` | `rm`, `rename` and moving the entry, even where `write` is granted | `false` |

Two behaviours are worth knowing:

- **Creating or deleting an entry also needs `write` on its parent directory**, the way a POSIX unlink does. Revoking `write` on one folder is therefore enough to freeze everything inside it, without enumerating the contents.
- **Each path is asked about independently.** There is no inheritance, so match on the prefix to cover a subtree.

The result is memoized per request, so a listing asks about each path once. Denials inside a command come back as `errAccess` in a **200** response, where elFinder renders them; only a failed `authorize` produces a 403.

Every entry also carries its flags in the listing, so the client greys out what it cannot use rather than offering an action that will fail.

### Still your responsibility

- **Scope** `uploadDir` to a dedicated directory; never point it at the project root.
- **Review** elFinder client options (allowed MIME types, max upload size) on the frontend.
- **Rate-limit** upload and archive endpoints if exposed publicly.

Path traversal, symlink escape and archive-extraction limits are handled by the package.

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
