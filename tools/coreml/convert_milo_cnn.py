#!/usr/bin/env python3
"""Convert the Milo CNN ONNX embedder to a float16 Core ML mlpackage.

Run with the dedicated venv:

    ~/.venvs/coreml/bin/python convert_milo_cnn.py \
        --onnx milo_cnn.onnx --out MiloCNN.mlpackage \
        [--check card1.jpg card2.jpg ...]

The model contract is: float32 NCHW (1, 3, 448, 448), ImageNet-normalized
(pixels / 255, then mean [0.485, 0.456, 0.406] / std [0.229, 0.224, 0.225]),
output (1, 128). The exported Core ML model takes raw RGB pixels in [0, 255]
and bakes in the normalization and the final L2 normalization.
"""

import argparse
import hashlib
import os
import shutil
import sys

import coremltools as ct
import numpy as np
import onnx
import onnx2torch
import onnxruntime as ort
import torch
import torch.nn as nn
import torch.nn.functional as F
from PIL import Image

INPUT_SIZE = 448
EMBED_DIM = 128
IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)


class MiloWrapper(nn.Module):
    """Raw [0, 255] NCHW RGB -> ImageNet norm -> ONNX model -> L2 norm."""

    def __init__(self, model: nn.Module) -> None:
        super().__init__()
        self.model = model
        self.register_buffer(
            "mean", torch.tensor(IMAGENET_MEAN, dtype=torch.float32).view(1, 3, 1, 1)
        )
        self.register_buffer(
            "std", torch.tensor(IMAGENET_STD, dtype=torch.float32).view(1, 3, 1, 1)
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = x / 255.0
        x = (x - self.mean) / self.std
        out = self.model(x)
        return F.normalize(out, dim=1)


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def dir_total_size(path: str) -> int:
    total = 0
    for dirpath, _dirnames, filenames in os.walk(path):
        for name in filenames:
            total += os.path.getsize(os.path.join(dirpath, name))
    return total


def sha256_dir(path: str) -> str:
    files = []
    for dirpath, _dirnames, filenames in os.walk(path):
        for name in filenames:
            full = os.path.join(dirpath, name)
            files.append((os.path.relpath(full, path), full))
    files.sort()
    h = hashlib.sha256()
    for rel, full in files:
        h.update(rel.encode("utf-8"))
        with open(full, "rb") as fh:
            for block in iter(lambda: fh.read(1 << 20), b""):
                h.update(block)
    return h.hexdigest()


def onnx_input_name(onnx_model: onnx.ModelProto) -> str:
    return onnx_model.graph.input[0].name


def _normalized_nchw(pil_image: Image.Image) -> np.ndarray:
    arr = np.asarray(pil_image, dtype=np.float32) / 255.0
    mean = np.asarray(IMAGENET_MEAN, dtype=np.float32)
    std = np.asarray(IMAGENET_STD, dtype=np.float32)
    arr = (arr - mean) / std
    return np.ascontiguousarray(arr.transpose(2, 0, 1)[None, ...])


def _l2(vec: np.ndarray) -> np.ndarray:
    vec = np.asarray(vec, dtype=np.float32).reshape(-1)
    norm = float(np.linalg.norm(vec))
    if norm > 0:
        vec = vec / norm
    return vec


def run_parity(mlmodel, onnx_path: str, input_name: str, check_images) -> bool:
    session = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
    ok = True
    for path in check_images:
        image = Image.open(path).convert("RGB").resize(
            (INPUT_SIZE, INPUT_SIZE), Image.BILINEAR
        )
        ref = session.run(None, {input_name: _normalized_nchw(image)})[0]
        ref = _l2(ref)

        pred = _l2(mlmodel.predict({"image": image})["embedding"])

        cosine = float(np.dot(ref, pred))
        print(f"{os.path.basename(path)}  cosine={cosine:.4f}")
        if cosine < 0.995:
            ok = False
    return ok


def fill_clip_bounds(model) -> None:
    """onnx2torch needs constant Clip bounds; ReLU6 exports leave min or max empty."""
    from onnx import numpy_helper

    names = {
        "": None,
        "min": numpy_helper.from_array(np.array(-3.4e38, dtype=np.float32), "cardrails_clip_min"),
        "max": numpy_helper.from_array(np.array(3.4e38, dtype=np.float32), "cardrails_clip_max"),
    }
    used = set()
    for node in model.graph.node:
        if node.op_type != "Clip":
            continue
        inputs = list(node.input) + [""] * (3 - len(node.input))
        for slot, key in ((1, "min"), (2, "max")):
            if inputs[slot] == "":
                inputs[slot] = names[key].name
                used.add(key)
        del node.input[:]
        node.input.extend(inputs)
    for key in sorted(used):
        model.graph.initializer.append(names[key])


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--onnx", required=True, help="input ONNX model path")
    parser.add_argument("--out", required=True, help="output .mlpackage path")
    parser.add_argument(
        "--check", nargs="+", default=[], help="images for the parity check"
    )
    args = parser.parse_args(argv)

    sha = sha256_file(args.onnx)
    onnx_model = onnx.load(args.onnx)
    input_name = onnx_input_name(onnx_model)

    fill_clip_bounds(onnx_model)
    torch_module = onnx2torch.convert(onnx_model)

    wrapper = MiloWrapper(torch_module).eval()
    example = torch.rand(1, 3, INPUT_SIZE, INPUT_SIZE) * 255.0
    with torch.no_grad():
        traced = torch.jit.trace(wrapper, example, strict=False)

    mlmodel = ct.convert(
        traced,
        inputs=[
            ct.ImageType(
                name="image",
                shape=(1, 3, INPUT_SIZE, INPUT_SIZE),
                color_layout=ct.colorlayout.RGB,
                scale=1.0,
            )
        ],
        outputs=[ct.TensorType(name="embedding")],
        convert_to="mlprogram",
        minimum_deployment_target=ct.target.iOS17,
        compute_precision=ct.precision.FLOAT16,
    )

    mlmodel.author = "Card Rails"
    mlmodel.short_description = "Milo CNN v22 card embedder, 448x448 RGB -> 128-d L2"
    mlmodel.user_defined_metadata.update(
        {"onnx_sha256": sha, "dim": str(EMBED_DIM), "size": str(INPUT_SIZE)}
    )

    if os.path.exists(args.out):
        if os.path.isdir(args.out):
            shutil.rmtree(args.out)
        else:
            os.remove(args.out)
    mlmodel.save(args.out)

    total_bytes = dir_total_size(args.out)
    package_sha = sha256_dir(args.out)
    print(f"output: {args.out}")
    print(f"bytes: {total_bytes}")
    print(f"sha256: {package_sha}")

    if args.check:
        if not run_parity(mlmodel, args.onnx, input_name, args.check):
            print("error: parity check failed (cosine < 0.995)", file=sys.stderr)
            return 1
    else:
        print("no --check images given, skipping parity check")

    return 0


if __name__ == "__main__":
    sys.exit(main())
