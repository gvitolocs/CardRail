# Card Rails

Independent card inventory, scan photos and stock book. React/Vite SPA with first-party server APIs and private Vercel Blob persistence.

- Full dark/red scan desk with visible QR/code pairing, sale/collection mode, batch defaults, flags, piles, duplicate merging and public catalog search.
- Pokémon capture flow: capture → public recognition → saved scan rows → edit → add batch to inventory and allocate shelf positions.
- First-party, one-use QR phone pairing into the same Card Rails inventory.
- Verified CardTrader token connection, real listing mapping, fresh-read delta delivery and signed sale webhook.
- eBay OAuth/token connection, actual business policy selection and publication from the saved scan bytes.
- Atomic sales, deduplicated order lines, ordered outbox and visible delivery errors.

Pokoin seller sync and Cardmarket linking still require an upstream Card Rails-scoped seller grant service. The app does not substitute Pokoin login/session tokens or private seller APIs. See [implementation](docs/implementation.md) for current behavior, configuration, tests and remaining prerequisites.

```sh
npm install
npm run dev
npm test
npm run lint
npm run build
```

Local handlers need `BLOB_READ_WRITE_TOKEN` and the stable `CARDRAILS_ENCRYPTION_KEY` in `.env.local`. Pull configured values with `vercel env pull .env.local`. Run Node on the Linux host when developing through the macOS SMB mount.

Production: https://cardrails.vercel.app · existing Vercel project `prj_eofbIozZRQIgdkjROo3AqSZZSdEK` (confirm `.vercel/project.json` before deployment).
