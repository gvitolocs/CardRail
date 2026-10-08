# Filler references in recognition catalogs

The source marketplace catalog includes printing filler sheets, such as
Pokémon's white/gray `Blank Filler Card`. Their embeddings can closely match
walls, tables, and other background surfaces.

`tools/catalogs/export_ios_catalogs.py` excludes entries whose name or set
contains the specific phrase `filler card` / `filler cards`, ignoring case and
allowing spaces, underscores, or hyphens. The exporter removes metadata and
the corresponding vector rows with the same mask, then regenerates file
hashes, byte sizes, and catalog counts. Playable cards such as Grass Energy,
Go Blank, Blanket of Night, and Training Dummy remain eligible.

The iPhone recognizer also checks cached catalogs. When a filler reference is
the best match, it ignores the frame rather than promoting a weaker real card.
Filler references never appear in candidate review. Invalid vector indexes
no longer generate a fabricated empty card record.

The 2026-10-08 export excluded 70 references from the 19 published catalogs:

| Catalog | Excluded | Remaining |
| --- | ---: | ---: |
| Pokémon Western | 14 | 26,037 |
| Magic | 51 | 113,750 |
| Yu-Gi-Oh! | 2 | 46,292 |
| Lorcana | 3 | 3,691 |

The release is saved under
`/home/nez/data/cardrails-catalogs/v22-20261008-no-filler`. Its files and manifest
were published to the existing API catalog mount. Older hashed files remain
available for in-progress downloads; the previous manifest is backed up at
`/home/nez/data/cardrails-catalogs/index-before-20261008-no-filler.json`.
Source marketplace exports are preserved.

Regression coverage checks vector/metadata alignment after exclusion, an
all-filler catalog, cached filler winners, candidate review, invalid vector
indexes, and continued recognition of playable cards. The complete iOS suite
passed with 54 tests passing and one existing Keychain test skipped; all five
Python exporter tests passed.
