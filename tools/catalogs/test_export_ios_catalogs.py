"""Unit tests for export_ios_catalogs.py.

Run from the repo root (needs numpy):

    python3 -m unittest tools/catalogs/test_export_ios_catalogs.py -v
"""

import hashlib
import importlib.util
import json
import os
import shutil
import tempfile
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "export_ios_catalogs.py")


def load_module():
    spec = importlib.util.spec_from_file_location("export_ios_catalogs", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


EXPORT = load_module()
ONNX_SHA = "ab" * 32


def write_catalog(root, catalog_id, n_rows, label, zero_row=None, null_field=None):
    catalog_dir = os.path.join(root, catalog_id)
    os.makedirs(catalog_dir)
    rng = np.random.RandomState(1234)
    embeddings = rng.randn(n_rows, 128).astype(np.float32)
    if zero_row is not None:
        embeddings[zero_row] = 0.0
    np.save(os.path.join(catalog_dir, "embeddings.npy"), embeddings)

    lines = []
    for i in range(n_rows):
        record = {
            "public_id": f"{label}-{i}",
            "name": f"Card {i}",
            "collector_number": str(i + 1),
            "set": "Test Set",
            "image_url": f"https://img.example/{label}/{i}.jpg",
        }
        if null_field is not None and i == 0:
            record[null_field] = None
        lines.append(json.dumps(record))
    with open(
        os.path.join(catalog_dir, "metadata.jsonl"), "w", encoding="utf-8"
    ) as fh:
        fh.write("\n".join(lines) + "\n")


class TestExport(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="catalogs-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.src = os.path.join(self.tmp, "catalogs-src")
        self.out = os.path.join(self.tmp, "out")

    def build_src(self):
        os.makedirs(self.src)
        write_catalog(
            self.src,
            "pokemon_western",
            5,
            "pw",
            zero_row=0,
            null_field="name",
        )
        write_catalog(self.src, "magic_all", 3, "mg")

    def export(self):
        return EXPORT.main(
            [
                "--src",
                self.src,
                "--out",
                self.out,
                "--onnx-sha256",
                ONNX_SHA,
            ]
        )

    def test_index_and_files(self):
        self.build_src()
        self.assertEqual(self.export(), 0)
        self.assertTrue(os.path.isdir(self.out))
        self.assertFalse(os.path.exists(self.out + ".partial"))

        with open(os.path.join(self.out, "index.json"), encoding="utf-8") as fh:
            index = json.load(fh)

        catalogs = index["catalogs"]
        self.assertEqual(
            [c["id"] for c in catalogs], ["pokemon_western", "magic_all"]
        )
        self.assertEqual([c["count"] for c in catalogs], [5, 3])
        self.assertEqual(
            catalogs[0]["languages"], ["EN", "IT", "FR", "DE", "ES", "PT"]
        )
        self.assertEqual(catalogs[1]["languages"], ["*"])
        self.assertEqual(index["model"]["onnxSha256"], ONNX_SHA)
        self.assertEqual(index["model"]["dim"], 128)
        self.assertEqual(index["source"], os.path.basename(self.src))
        self.assertEqual(index["version"], 1)

        for catalog in catalogs:
            self.check_embeddings(catalog)
            self.check_cards(catalog)

    def check_embeddings(self, catalog):
        path = os.path.join(self.out, catalog["embeddings"]["path"])
        self.assertEqual(
            os.path.basename(path),
            "embeddings-%s.f16" % catalog["embeddings"]["sha256"][:12],
        )
        with open(path, "rb") as fh:
            data = fh.read()
        self.assertEqual(len(data), catalog["count"] * 128 * 2)
        self.assertEqual(hashlib.sha256(data).hexdigest(), catalog["embeddings"]["sha256"])
        self.assertEqual(catalog["embeddings"]["bytes"], len(data))

        rows = np.frombuffer(data, dtype="<f2").reshape(catalog["count"], 128)
        rows = rows.astype(np.float32)
        norms = np.linalg.norm(rows, axis=1)
        for i, norm in enumerate(norms):
            if catalog["id"] == "pokemon_western" and i == 0:
                self.assertLess(float(norm), 1e-6)
            else:
                self.assertAlmostEqual(float(norm), 1.0, delta=2e-3)

    def check_cards(self, catalog):
        path = os.path.join(self.out, catalog["cards"]["path"])
        self.assertEqual(
            os.path.basename(path),
            "cards-%s.json" % catalog["cards"]["sha256"][:12],
        )
        with open(path, "rb") as fh:
            raw = fh.read()
        self.assertEqual(
            hashlib.sha256(raw).hexdigest(), catalog["cards"]["sha256"]
        )
        self.assertEqual(catalog["cards"]["bytes"], len(raw))

        cards = json.loads(raw.decode("utf-8"))
        self.assertEqual(
            cards["fields"], ["id", "name", "number", "set", "image"]
        )

        meta_path = os.path.join(self.src, catalog["id"], "metadata.jsonl")
        with open(meta_path, encoding="utf-8") as fh:
            metadata = [json.loads(line) for line in fh if line.strip()]

        self.assertEqual(len(cards["rows"]), len(metadata))
        for row, record in zip(cards["rows"], metadata):
            self.assertIsInstance(row[0], str)
            self.assertEqual(row[0], str(record["public_id"]))
            self.assertEqual(row[1], record.get("name"))
            self.assertEqual(row[2], record.get("collector_number"))
            self.assertEqual(row[3], record.get("set"))
            self.assertEqual(row[4], record.get("image_url"))

        if catalog["id"] == "pokemon_western":
            self.assertIsNone(cards["rows"][0][1])

    def test_refuses_existing_out(self):
        self.build_src()
        self.assertEqual(self.export(), 0)
        self.assertEqual(self.export(), 2)

    def test_mismatched_rows_exits_1(self):
        os.makedirs(self.src)
        write_catalog(self.src, "pokemon_western", 5, "pw")
        metadata_path = os.path.join(
            self.src, "pokemon_western", "metadata.jsonl"
        )
        with open(metadata_path, "w", encoding="utf-8") as fh:
            fh.write(
                "\n".join(
                    json.dumps({"public_id": f"pw-{i}", "name": f"Card {i}"})
                    for i in range(4)
                )
                + "\n"
            )
        self.assertEqual(self.export(), 1)
        self.assertFalse(os.path.exists(self.out))
        self.assertFalse(os.path.exists(self.out + ".partial"))

    def test_filler_vectors_and_metadata_removed_together(self):
        os.makedirs(self.src)
        write_catalog(self.src, "pokemon_western", 6, "pw")
        path = os.path.join(self.src, "pokemon_western", "metadata.jsonl")
        records = EXPORT.read_metadata(path)
        names = ["Blank Filler Card", "Grass Energy", "Discard Filler Card",
                 "Go Blank", "WCD 1996", "Training Dummy"]
        for record, name in zip(records, names):
            record["name"] = name
        records[4]["set"] = "Filler Cards"
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(json.dumps(record) for record in records))

        self.assertEqual(self.export(), 0)
        with open(os.path.join(self.out, "index.json"), encoding="utf-8") as fh:
            catalog = json.load(fh)["catalogs"][0]
        self.assertEqual(catalog["count"], 3)
        with open(os.path.join(self.out, catalog["cards"]["path"]), encoding="utf-8") as fh:
            rows = json.load(fh)["rows"]
        self.assertEqual([row[0] for row in rows], ["pw-1", "pw-3", "pw-5"])
        self.assertEqual([row[1] for row in rows], ["Grass Energy", "Go Blank", "Training Dummy"])

        source = np.load(os.path.join(self.src, "pokemon_western", "embeddings.npy"))
        expected = source[[1, 3, 5]].astype(np.float32)
        expected /= np.linalg.norm(expected, axis=1, keepdims=True)
        actual = np.fromfile(os.path.join(self.out, catalog["embeddings"]["path"]),
                             dtype="<f2").reshape(3, 128)
        np.testing.assert_array_equal(actual, expected.astype("<f2"))

    def test_all_filler_catalog_has_no_candidates(self):
        os.makedirs(self.src)
        write_catalog(self.src, "pokemon_western", 1, "pw")
        path = os.path.join(self.src, "pokemon_western", "metadata.jsonl")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"public_id": "pw-0", "name": "Blank Filler Card"}, fh)
        self.assertEqual(self.export(), 0)
        with open(os.path.join(self.out, "index.json"), encoding="utf-8") as fh:
            catalog = json.load(fh)["catalogs"][0]
        self.assertEqual(catalog["count"], 0)
        self.assertEqual(catalog["embeddings"]["bytes"], 0)


if __name__ == "__main__":
    unittest.main()
