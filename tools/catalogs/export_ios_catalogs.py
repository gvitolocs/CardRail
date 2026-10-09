#!/usr/bin/env python3
"""Export on-device iOS recognition catalogs from a published scan catalog root.

Standard library + numpy only. Runs on nezopt with the system python3.

    python3 export_ios_catalogs.py --src CATALOG_ROOT --out OUT_DIR \
        --onnx-sha256 <64 hex chars>

For every catalog id present in --src it writes, under <out>/<id>/:
  * embeddings-<sha12>.f16 : raw little-endian float16, N x 128, L2-normalized
  * cards-<sha12>.json     : compact {"fields": [...], "rows": [...]}
plus a top-level index.json describing every catalog.
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from datetime import datetime, timezone

import numpy as np

DIM = 128
CHUNK_ROWS = 8192

# (id, game, languages); "*" means every language.
CATALOGS = [
    ("pokemon_western", "pokemon", ["EN", "IT", "FR", "DE", "ES", "PT"]),
    ("pokemon_japanese", "pokemon", ["JP"]),
    ("pokemon_chinese", "pokemon", ["ZH"]),
    ("one_piece_english", "one_piece", ["EN"]),
    ("one_piece_japanese", "one_piece", ["JP"]),
    ("magic_all", "magic", ["*"]),
    ("yugioh_all", "yugioh", ["*"]),
    ("lorcana_all", "lorcana", ["*"]),
    ("riftbound_western", "riftbound", ["*"]),
    ("vanguard_all", "vanguard", ["*"]),
    ("flesh_and_blood_all", "flesh_and_blood", ["*"]),
    ("dragon_ball_super_all", "dragon_ball_super", ["*"]),
    ("digimon_all", "digimon", ["*"]),
    ("star_wars_all", "star_wars", ["*"]),
    ("union_arena_all", "union_arena", ["*"]),
    ("gundam_all", "gundam", ["*"]),
    ("sorcery_all", "sorcery", ["*"]),
    ("palworld_all", "palworld", ["*"]),
    ("cyberpunk_all", "cyberpunk", ["*"]),
]

FIELDS = ["id", "name", "number", "set", "image"]
FILLER_CARD = re.compile(r"\bfiller[\s_-]+cards?\b", re.IGNORECASE)


def is_filler(record):
    return any(FILLER_CARD.search(str(record.get(field) or ""))
               for field in ("name", "set"))


def read_metadata(path):
    with open(path, "r", encoding="utf-8") as fh:
        lines = fh.read().splitlines()
    return [json.loads(line) for line in lines if line.strip() != ""]


def write_embeddings(embeddings, dest_dir):
    """Stream L2-normalized float16 rows to a temp file, name by content hash."""
    tmp_path = os.path.join(dest_dir, ".embeddings.tmp")
    hasher = hashlib.sha256()
    num_bytes = 0
    with open(tmp_path, "wb") as fh:
        for start in range(0, embeddings.shape[0], CHUNK_ROWS):
            chunk = np.array(embeddings[start:start + CHUNK_ROWS], dtype=np.float32)
            norms = np.linalg.norm(chunk, axis=1, keepdims=True)
            np.divide(chunk, norms, out=chunk, where=norms > 0)
            data = chunk.astype("<f2").tobytes()
            fh.write(data)
            hasher.update(data)
            num_bytes += len(data)
    sha = hasher.hexdigest()
    name = f"embeddings-{sha[:12]}.f16"
    os.replace(tmp_path, os.path.join(dest_dir, name))
    return name, sha, num_bytes


def write_cards(records, dest_dir):
    rows = []
    for record in records:
        public_id = record.get("public_id")
        rows.append([
            "" if public_id is None else str(public_id),
            record.get("name"),
            record.get("collector_number"),
            record.get("set"),
            record.get("image_url"),
        ])
    payload = json.dumps(
        {"fields": FIELDS, "rows": rows}, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    sha = hashlib.sha256(payload).hexdigest()
    name = f"cards-{sha[:12]}.json"
    with open(os.path.join(dest_dir, name), "wb") as fh:
        fh.write(payload)
    return name, sha, len(payload)


def export_catalog(src, partial, entry_spec):
    catalog_id, game, languages = entry_spec
    src_dir = os.path.join(src, catalog_id)
    embeddings_path = os.path.join(src_dir, "embeddings.npy")
    metadata_path = os.path.join(src_dir, "metadata.jsonl")

    if not os.path.isfile(metadata_path):
        print(
            f"error: catalog '{catalog_id}': missing {metadata_path}",
            file=sys.stderr,
        )
        return None

    records = read_metadata(metadata_path)
    embeddings = np.load(embeddings_path, mmap_mode="r")
    if embeddings.ndim != 2 or embeddings.shape[1] != DIM:
        print(
            f"error: catalog '{catalog_id}': embeddings must be 2-D with {DIM} "
            f"columns, got shape {tuple(embeddings.shape)}",
            file=sys.stderr,
        )
        return None
    if embeddings.shape[0] != len(records):
        print(
            f"error: catalog '{catalog_id}': {embeddings.shape[0]} embedding rows "
            f"but {len(records)} metadata rows",
            file=sys.stderr,
        )
        return None

    keep = np.array([not is_filler(record) for record in records], dtype=bool)
    excluded = len(records) - int(keep.sum())
    if excluded:
        # Apply the same mask to vectors and metadata; removing only names
        # would silently associate every later vector with the wrong card.
        embeddings = embeddings[keep]
        records = [record for record, retained in zip(records, keep) if retained]
        print(f"{catalog_id}: excluded {excluded} filler card references")

    dest_dir = os.path.join(partial, catalog_id)
    os.makedirs(dest_dir, exist_ok=True)

    emb_name, emb_sha, emb_bytes = write_embeddings(embeddings, dest_dir)
    cards_name, cards_sha, cards_bytes = write_cards(records, dest_dir)

    count = int(embeddings.shape[0])
    print(
        f"{catalog_id}: {count} cards  "
        f"embeddings {emb_bytes / 1e6:.2f} MB  cards {cards_bytes / 1e6:.2f} MB"
    )

    return {
        "id": catalog_id,
        "game": game,
        "languages": languages,
        "count": count,
        "embeddings": {
            "path": f"{catalog_id}/{emb_name}",
            "bytes": emb_bytes,
            "sha256": emb_sha,
        },
        "cards": {
            "path": f"{catalog_id}/{cards_name}",
            "bytes": cards_bytes,
            "sha256": cards_sha,
        },
        "_bytes": emb_bytes + cards_bytes,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--src", required=True, help="published scan catalog root")
    parser.add_argument("--out", required=True, help="output directory")
    parser.add_argument("--onnx-sha256", required=True, dest="onnx_sha256")
    args = parser.parse_args(argv)

    src = args.src
    out = args.out
    if not os.path.isdir(src):
        print(f"error: --src is not a directory: {src}", file=sys.stderr)
        return 1
    if os.path.exists(out):
        print(
            f"error: --out already exists, refusing to overwrite: {out}",
            file=sys.stderr,
        )
        return 2

    partial = out + ".partial"
    if os.path.exists(partial):
        shutil.rmtree(partial)
    os.makedirs(partial)

    success = False
    try:
        entries = []
        total_bytes = 0
        for spec in CATALOGS:
            catalog_id = spec[0]
            if not os.path.isdir(os.path.join(src, catalog_id)):
                print(
                    f"warning: catalog '{catalog_id}' not found in {src}, skipping",
                    file=sys.stderr,
                )
                continue
            entry = export_catalog(src, partial, spec)
            if entry is None:
                return 1
            total_bytes += entry.pop("_bytes")
            entries.append(entry)

        index = {
            "version": 1,
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "source": os.path.basename(os.path.normpath(src)),
            "model": {
                "name": "MiloCNN",
                "onnxSha256": args.onnx_sha256,
                "dim": DIM,
                "size": 448,
                "dtype": "float16",
            },
            "catalogs": entries,
        }
        with open(os.path.join(partial, "index.json"), "w", encoding="utf-8") as fh:
            json.dump(index, fh, indent=2, ensure_ascii=False)
            fh.write("\n")

        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        os.rename(partial, out)
        success = True

        print(f"total: {total_bytes / 1e6:.2f} MB")
        return 0
    finally:
        if not success and os.path.exists(partial):
            shutil.rmtree(partial)


if __name__ == "__main__":
    sys.exit(main())
