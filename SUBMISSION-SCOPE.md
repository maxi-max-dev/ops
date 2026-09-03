# OPS submission scope

This repository contains private runtime history and local canary evidence. Do
not submit the Git repository, its `.git` directory, a full working-tree copy,
or any private deployment configuration.

The public competition surface is limited to:

1. `npm run build:pages` output from `dist-pages/`. This build uses
   `public-submission/`, synthetic data, the OPS display name, and no server
   bindings.
2. The public `max-ops-agent-template` repository, after its tests and
   validators pass.
3. If source code is explicitly required, a `git archive` made from a reviewed
   commit. `.gitattributes` excludes private evidence, legacy media, and
   local-only project material from that archive.

Never include `.env*`, `.wrangler/`, `dist/`, logs, source maps, receipts,
screenshots from a signed-in Feishu session, runtime configuration, or `.git`.
The internal compatibility identifiers `MAXOPS_*`, `max-ops-*`, existing API
routes, storage keys, and repository URLs intentionally remain unchanged.
