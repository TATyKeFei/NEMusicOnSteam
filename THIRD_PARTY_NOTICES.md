# UnblockNeteaseMusic

The optional Linux audio matcher bundles the unmodified `@unblockneteasemusic/server` version 0.28.0 (LGPL-3.0-only), published by the UnblockNeteaseMusic project and its contributors, with its JavaScript dependencies.

- Project and source: https://github.com/UnblockNeteaseMusic/server/tree/enhanced
- Exact published source: https://registry.npmjs.org/@unblockneteasemusic/server/-/server-0.28.0.tgz
- The plugin archive includes `dist/UnblockNeteaseMusic-COPYING` and `dist/UnblockNeteaseMusic-COPYING.LESSER`.
- Dependency license texts are included in `dist/UnblockNeteaseMusic-NOTICES.txt`.
- The dependency versions and integrity hashes are recorded in `package-lock.json`. Bundle license comments are preserved in `dist/unblock_helper.cjs`.

To rebuild or replace the library, install dependencies with `npm ci`, edit or replace `node_modules/@unblockneteasemusic/server`, and run `npm run build`. `scripts/build-unblock.mjs` builds the bundled helper; `backend/unblock_helper.cjs` contains this plugin's service adapter. The library is used to match individual songs, without enabling its forward proxy or installing certificates.
