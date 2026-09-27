# elfinder-next (monorepo)

A monorepo for **[elfinder-next](packages/elfinder-next)** — an npm package that brings the [elFinder](https://github.com/Studio-42/elFinder) 2.1 connector protocol to **Next.js App Router** API routes.

> **Status: v0.1.0 — first release.**  
> The published package and this repository are in their initial version. Feature set and configuration options are stable enough for adoption, but breaking changes may occur before v1.0.0. See the [package README](packages/elfinder-next/README.md) for full usage documentation.

---

## Why this project exists

Building a file manager in Next.js usually means either:

1. **Rewriting** a large connector script inside `app/api/.../route.ts`, or  
2. **Adapting** legacy PHP/Java connectors that do not fit the App Router model.

**elfinder-next** extracts a production-ready elFinder 2.1 backend into a reusable library: install it, configure storage paths, export `GET` / `POST` from a route, and wire your existing elFinder UI to that URL.

The package handles filesystem operations, thumbnails, ZIP archives, and chunked uploads — so you focus on auth, UI, and deployment.

---

## Repository structure

```
elfinder-next/
├── packages/
│   └── elfinder-next/     # Publishable npm package (@see packages/elfinder-next/README.md)
├── apps/
│   └── playground/        # Next.js demo app with /api/elfinder
├── pnpm-workspace.yaml
└── README.md              # This file
```

| Path | Purpose |
|------|---------|
| [`packages/elfinder-next`](packages/elfinder-next) | Library source (`createElfinderHandler`), built to `dist/` |
| [`apps/playground`](apps/playground) | Local Next.js app to try the connector |

---

## Quick start (consumers)

Install from npm (once published) or link from this monorepo:

```bash
npm install elfinder-next
```

```ts
// app/api/elfinder/route.ts
import { createElfinderHandler } from "elfinder-next";

export const { GET, POST, runtime } = createElfinderHandler();
```

Full installation steps, configuration table, security notes, and command reference:

**→ [packages/elfinder-next/README.md](packages/elfinder-next/README.md)**

---

## Quick start (contributors)

**Prerequisites:** Node.js 20.3+, [pnpm](https://pnpm.io/) 10+

```bash
git clone <repository-url>
cd elfinder-next
pnpm install
```

Build the library:

```bash
pnpm --filter elfinder-next build
```

Run the playground:

```bash
pnpm --filter playground dev
```

Open [http://localhost:3000](http://localhost:3000) and test the connector at `http://localhost:3000/api/elfinder` (e.g. `?cmd=open&init=1`).

Production build for the demo app:

```bash
pnpm build:playground
```

---

## Playground API route

The example integration lives at:

[`apps/playground/app/api/elfinder/route.ts`](apps/playground/app/api/elfinder/route.ts)

```ts
import { createElfinderHandler } from "elfinder-next";

export const { GET, POST, runtime } = createElfinderHandler();
```

Uploads are written to `apps/playground/public/uploads/` by default.

---

## Scripts (root)

| Command | Description |
|---------|-------------|
| `pnpm build` | Build the `elfinder-next` package |
| `pnpm dev` | Start the playground Next.js dev server |
| `pnpm build:playground` | Build package + playground for production |

---

## Package summary

| | |
|---|---|
| **npm name** | `elfinder-next` |
| **Version** | `0.1.0` (initial release) |
| **Peer dependency** | `next` >= 14 |
| **Runtime** | Node.js only (`runtime: "nodejs"`) |
| **License** | MIT |

---

## Roadmap (informal)

Planned or possible improvements after v0.1.0:

- Image `resize` command
- Optional authentication hooks
- Additional archive formats or cloud volume adapters
- Stable v1.0 API surface

Contributions and issue reports are welcome as the project matures toward v1.0.0.

---

## Documentation

- **Package usage (primary):** [packages/elfinder-next/README.md](packages/elfinder-next/README.md)
- **elFinder upstream:** [Studio-42/elFinder](https://github.com/Studio-42/elFinder)

---

## License

MIT — see package metadata for details.
