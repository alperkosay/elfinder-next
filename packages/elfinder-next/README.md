# elfinder-next

**elFinder 2.1 connector backend for Next.js App Router**

[![npm version](https://img.shields.io/npm/v/elfinder-next.svg)](https://www.npmjs.com/package/elfinder-next)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> **v0.2.0 changes the storage defaults.** Files now live outside `public/` and are
> served through the connector. See [Upgrading from 0.1.x](#upgrading-from-01x).
> APIs may still change before 1.0; pin your version in production.

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
- A **persistent, writable directory** on the server for the files. See [Deployment](#deployment) before picking a host.

The package is **backend-only**. It does not bundle the elFinder UI.

---

## Requirements

- **Node.js** 20.3 or later
- **Next.js** 14 or later (App Router, `route.ts` handlers)
- **Runtime:** Node.js (`export const runtime = "nodejs"` in the route file)

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

On Next 14 the key is `experimental.serverComponentsExternalPackages`; 14 warns
about and ignores `serverExternalPackages`. `sharp` is on 14's built-in list
either way, and the connector builds and runs on 14.2 without the setting.

---

## Quick start

### 1. Create the API route

```ts
// app/api/elfinder/route.ts
import { createElfinderHandler } from "elfinder-next";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const { GET, POST } = createElfinderHandler();
```

`runtime` and `dynamic` are written as plain values on purpose. Next reads route
segment config statically, and it cannot see a value destructured from a function
call. `nodejs` is the default runtime today, so re-exporting `runtime` from the
handler happens to work, but only by coincidence.

Defaults:

- Files are stored in `<cwd>/uploads`, outside `public/`
- Previews and thumbnails are served by the connector (`cmd=file`), so they work
  the moment a file is uploaded

### 2. Keep uploads out of version control

The handler creates the directory, plus `.tmb`, `.chunks` and `.tmp` inside it, on
the first request. Add it to `.gitignore`:

```
/uploads
```

### 3. Connect the elFinder frontend

Point the client connector `url` at your route (no trailing slash required by elFinder, but be consistent):

```js
$("#elfinder").elfinder({
  url: "/api/elfinder",
  // ...other elFinder options
});
```

---

## Configuration

Pass an optional options object to `createElfinderHandler`:

```ts
import { createElfinderHandler } from "elfinder-next";

export const { GET, POST } = createElfinderHandler({
  uploadDir: process.env.ELFINDER_DIR, // e.g. /srv/files
  rootName: "media",
  volumeId: "v1_",
});
```

| Option | Default | Description |
|--------|---------|-------------|
| `uploadDir` | `uploads` (resolved from `process.cwd()`) | Filesystem root for the volume. All paths are confined under it. **Use an absolute path in production**; see [Deployment](#deployment). |
| `rootName` | `uploads` | Display name of the volume root in elFinder. |
| `volumeId` | `v1_` | Prefix for volume hashes (elFinder `hash` / `phash` encoding). |
| `publicUrl` | `""` | Static URL prefix for files. Empty means the connector serves them. Set it only when something other than Next's `public/` serves `uploadDir`, such as a CDN or reverse proxy. A trailing `/` is added if missing. |
| `tmbUrl` | `""` | Static URL prefix for `uploadDir/.tmb/`. Empty means the connector serves thumbnails. Same caveat as `publicUrl`. |
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

## Deployment

The connector reads and writes a real directory. Wherever you deploy, that
directory has to be **writable at runtime** and **survive a redeploy**.

| Target | Works? | What you need |
|--------|--------|---------------|
| `next start` on a VM or bare server | Yes | An absolute `uploadDir` outside the project, e.g. `/srv/files` |
| Docker, including `output: "standalone"` | Yes | A mounted volume as `uploadDir`, plus the settings below |
| Vercel, Netlify and other serverless hosts | **No** | The runtime filesystem is read-only and discarded between invocations. There is no storage adapter for S3 or similar yet. |

### Why not `public/`

Next's production server reads the list of files in `public/` once, at startup.
A file added afterwards answers **404 until the server restarts**. Measured on
Next 16.2.6: a file uploaded through the connector under `next start` 404s at
`/uploads/<name>` and answers 200 after a restart.

`public/` is also copied at build time, not read at runtime, so on serverless hosts
and in standalone builds a runtime upload never reaches it at all. That is why the
defaults keep files out of `public/` and serve them through the connector.

If you do serve `uploadDir` statically, use something that reads the disk on every
request, such as nginx or a CDN with an origin, and set `publicUrl` and `tmbUrl` to
its prefixes.

### `output: "standalone"`

Three things go wrong with the defaults:

1. **Uploads land inside the build output.** The generated `server.js` changes the
   working directory to `.next/standalone`, so a relative `uploadDir` resolves
   there. The handler creates the directory itself, so nothing fails; everything
   uploaded is silently deleted by the next build or the next image.
2. **Packages outside the app are not traced.** In a monorepo, Next traces files
   from the app's own directory unless told otherwise, and `sharp`'s native binary
   is a known casualty.
3. **`public/` is not copied** into the standalone output. This no longer matters
   for uploads, but applies to your own static files as usual.

**If the package is linked from source** (a workspace dependency in a monorepo,
rather than installed from npm), Next bundles it and its file-tracer gives up on the
many dynamic paths: `next build` warns that "the whole project was traced", and
**anything under the app directory at build time is copied into the standalone
output — including an `uploads/` folder full of user files.** Installing from npm is
not affected; this was measured on Next 16.2.6 in both setups. Keep `uploadDir`
outside the project, and exclude it from tracing if it must live there:

```ts
outputFileTracingExcludes: { "/api/elfinder": ["./uploads/**/*"] },
```

```ts
// next.config.ts
import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["sharp", "adm-zip"],
  // Monorepos only: the repository root, so packages outside the app are traced.
  outputFileTracingRoot: path.join(__dirname, "../../"),
  outputFileTracingIncludes: { "/api/elfinder": ["node_modules/sharp/**/*"] },
};

export default nextConfig;
```

```ts
// app/api/elfinder/route.ts
export const { GET, POST } = createElfinderHandler({
  uploadDir: process.env.ELFINDER_DIR, // absolute path on a mounted volume
});
```

---

## Upgrading from 0.1.x

0.2.0 changes three defaults:

| Option | 0.1.x | 0.2.0 |
|--------|-------|-------|
| `uploadDir` | `<cwd>/public/uploads` | `<cwd>/uploads` |
| `publicUrl` | `/uploads/` | `""` (served by the connector) |
| `tmbUrl` | `/uploads/.tmb/` | `""` (served by the connector) |

The old defaults never showed previews under `next start` (see
[Why not `public/`](#why-not-public)), and they exposed half-finished chunked
uploads at `/uploads/.chunks/`.

If you relied on the defaults, either move `public/uploads` to `uploads`, or pin
the old location while you migrate:

```ts
createElfinderHandler({
  uploadDir: "public/uploads",
  publicUrl: "",  // keep serving through the connector
  tmbUrl: "",
});
```

With an empty `tmbUrl`, a thumbnail's `tmb` field is now a connector URL
(`?cmd=file&target=<hash>&thumb=1`) rather than a filename. Code that read `tmb`
as a filename should use a non-empty `tmbUrl`, which keeps the old shape.

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

File contents and thumbnails are streamed by the connector itself (`cmd=file`, with HTTP Range support), unless `publicUrl` / `tmbUrl` point the client at a static host.

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
| `dim` | GET | Image dimensions, as `WIDTHxHEIGHT` |
| `upload` | POST | Multipart upload; supports chunked uploads |
| `resize` | GET/POST | Resize, crop or rotate an image in place (`mode=resize|crop|rotate`); sides are capped at 10000 px |

Unknown commands return `{ "error": ["errUnknownCmd"] }`.

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

Command errors come back with **HTTP 200** and elFinder message keys, which the
client translates:

```json
{ "error": ["errExists", "photo.jpg"] }
```

A non-2xx response would make elFinder report a connection failure and discard the
body. Raw filesystem errors are logged on the server and returned as `errUnknown`
or a mapped key, so absolute server paths never reach the client.

The one exception is a request refused by `authorize`, which answers **HTTP 403**.

---

## Limitations

- Single local volume per handler instance
- No cloud storage backends (S3, etc.), so no serverless deployment
- Archivers limited to ZIP via `adm-zip`
- `chmod` and `netmount` are disabled

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

MIT — see [LICENSE](LICENSE).

---

## Links

- [elFinder project](https://github.com/Studio-42/elFinder)
- [elFinder 2.1 client API](https://github.com/Studio-42/elFinder/wiki/Client-configuration-options)
- [Source repository](https://github.com/alperkosay/elfinder-next)
