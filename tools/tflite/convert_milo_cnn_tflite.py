#!/usr/bin/env python3
"""Convert Milo CNN v22 to fixed-shape, GPU-compatible LiteRT models.

Environment used for this script:
  Python 3.12.13, onnx2tf 1.28.8, tensorflow 2.21.0, tf_keras 2.21.0,
  onnx 1.23.2, onnxsim 0.7.3, onnx_graphsurgeon 0.6.1, sng4onnx 2.0.1,
  psutil 7.2.2, ai-edge-litert 2.3.0, onnxruntime 1.30.0,
  numpy 2.5.3, pillow 12.3.0
"""

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
from collections import Counter

import numpy as np
import onnx
import onnxruntime as ort
import tensorflow as tf
from onnx import TensorProto, helper, numpy_helper
from PIL import Image

try:
    from ai_edge_litert.interpreter import Interpreter
except ImportError:
    from tflite_runtime.interpreter import Interpreter


INPUT_SIZE = 448
EMBED_DIM = 128
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def fill_clip_bounds(model):
    """Give empty Clip min/max inputs the constants expected by converters."""
    names = {
        "min": numpy_helper.from_array(
            np.array(-3.4e38, dtype=np.float32), "cardrails_clip_min"
        ),
        "max": numpy_helper.from_array(
            np.array(3.4e38, dtype=np.float32), "cardrails_clip_max"
        ),
    }
    used = set()
    for node in model.graph.node:
        if node.op_type != "Clip":
            continue
        inputs = list(node.input) + [""] * (3 - len(node.input))
        for slot, key in ((1, "min"), (2, "max")):
            if not inputs[slot]:
                inputs[slot] = names[key].name
                used.add(key)
        del node.input[:]
        node.input.extend(inputs)
    for key in sorted(used):
        model.graph.initializer.append(names[key])


def wrapped_model(source_path, destination_path):
    model = onnx.load(source_path)
    fill_clip_bounds(model)
    graph = model.graph
    old_input = graph.input[0].name
    internal_input = "cardrails_model_input_nchw"
    raw_input = "image"
    original_output = graph.output[0].name

    for node in graph.node:
        for index, name in enumerate(node.input):
            if name == old_input:
                node.input[index] = internal_input
    graph.input[0].name = internal_input
    graph.input[0].type.tensor_type.shape.dim[0].dim_value = 1
    graph.input[0].type.tensor_type.shape.dim[1].dim_value = 3
    graph.input[0].type.tensor_type.shape.dim[2].dim_value = INPUT_SIZE
    graph.input[0].type.tensor_type.shape.dim[3].dim_value = INPUT_SIZE

    graph.node.insert(
        0,
        helper.make_node(
            "Transpose", [raw_input], ["cardrails_raw_nchw"], perm=[0, 3, 1, 2],
            name="cardrails_nhwc_to_nchw",
        ),
    )
    graph.node.insert(
        1,
        helper.make_node(
            "Div", ["cardrails_raw_nchw", "cardrails_div_255"],
            ["cardrails_scaled"], name="cardrails_scale",
        ),
    )
    graph.node.insert(
        2,
        helper.make_node(
            "Sub", ["cardrails_scaled", "cardrails_mean"],
            ["cardrails_centered"], name="cardrails_center",
        ),
    )
    graph.node.insert(
        3,
        helper.make_node(
            "Div", ["cardrails_centered", "cardrails_std"],
            [internal_input], name="cardrails_normalize",
        ),
    )
    graph.initializer.extend(
        [
            numpy_helper.from_array(np.array(255.0, dtype=np.float32), "cardrails_div_255"),
            numpy_helper.from_array(MEAN.reshape(1, 3, 1, 1), "cardrails_mean"),
            numpy_helper.from_array(STD.reshape(1, 3, 1, 1), "cardrails_std"),
            numpy_helper.from_array(np.array([1], dtype=np.int64), "cardrails_reduce_axis"),
        ]
    )
    graph.input[0].name = raw_input
    graph.input[0].type.tensor_type.shape.dim[1].dim_value = INPUT_SIZE
    graph.input[0].type.tensor_type.shape.dim[2].dim_value = INPUT_SIZE
    graph.input[0].type.tensor_type.shape.dim[3].dim_value = 3

    graph.node.extend(
        [
            helper.make_node(
                "Mul", [original_output, original_output], ["cardrails_squared"],
                name="cardrails_l2_square",
            ),
            helper.make_node(
                "ReduceSum", ["cardrails_squared", "cardrails_reduce_axis"],
                ["cardrails_sum"], keepdims=1, name="cardrails_l2_sum",
            ),
            helper.make_node(
                "Sqrt", ["cardrails_sum"], ["cardrails_norm"],
                name="cardrails_l2_sqrt",
            ),
            helper.make_node(
                "Div", [original_output, "cardrails_norm"], ["cardrails_embedding"],
                name="cardrails_l2_normalize",
            ),
        ]
    )
    graph.output[0].name = "cardrails_embedding"
    graph.output[0].type.tensor_type.shape.dim[0].dim_value = 1
    graph.output[0].type.tensor_type.shape.dim[1].dim_value = EMBED_DIM
    onnx.checker.check_model(model)
    onnx.save(model, destination_path)


def convert(saved_model, output_path, fp16):
    converter = tf.lite.TFLiteConverter.from_saved_model(saved_model)
    if fp16:
        converter.optimizations = [tf.lite.Optimize.DEFAULT]
        converter.target_spec.supported_types = [tf.float16]
    return converter.convert()


def ops_summary(path):
    interpreter = Interpreter(model_path=path)
    interpreter.allocate_tensors()
    details = interpreter._get_ops_details()
    ops = [item["op_name"] for item in details]
    counts = Counter(ops)
    flex = [op for op in ops if op.startswith("Flex")]
    if flex:
        raise RuntimeError(f"{path} contains unsupported Flex ops: {flex}")
    input_detail = interpreter.get_input_details()[0]
    output_detail = interpreter.get_output_details()[0]
    if tuple(input_detail["shape"]) != (1, INPUT_SIZE, INPUT_SIZE, 3):
        raise RuntimeError(f"{path} has unexpected input shape {input_detail['shape']}")
    if tuple(output_detail["shape"]) != (1, EMBED_DIM):
        raise RuntimeError(f"{path} has unexpected output shape {output_detail['shape']}")
    summary = ", ".join(f"{name}={count}" for name, count in sorted(counts.items()))
    return summary


def normalized_nchw(image):
    array = np.asarray(image, dtype=np.float32) / 255.0
    array = (array - MEAN) / STD
    return np.ascontiguousarray(array.transpose(2, 0, 1)[None])


def l2(vector):
    vector = np.asarray(vector, dtype=np.float32).reshape(-1)
    norm = np.linalg.norm(vector)
    return vector / norm if norm else vector


def parity(onnx_path, model_paths, images):
    onnx_model = onnx.load(onnx_path)
    input_name = onnx_model.graph.input[0].name
    session = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
    interpreters = []
    for path in model_paths:
        interpreter = Interpreter(model_path=path)
        interpreter.allocate_tensors()
        interpreters.append(
            (interpreter, interpreter.get_input_details()[0], interpreter.get_output_details()[0])
        )
    ok = True
    for image_path in images:
        image = Image.open(image_path).convert("RGB").resize(
            (INPUT_SIZE, INPUT_SIZE), Image.Resampling.BILINEAR
        )
        reference = l2(session.run(None, {input_name: normalized_nchw(image)})[0])
        scores = []
        raw = np.asarray(image, dtype=np.float32)[None]
        for interpreter, input_detail, output_detail in interpreters:
            interpreter.set_tensor(input_detail["index"], raw)
            interpreter.invoke()
            scores.append(float(np.dot(reference, l2(interpreter.get_tensor(output_detail["index"])))))
        print(f"{os.path.basename(image_path)} fp32={scores[0]:.4f} fp16={scores[1]:.4f}")
        ok = ok and scores[0] >= 0.999 and scores[1] >= 0.995
    return ok


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--onnx", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--check", nargs="+", default=[])
    args = parser.parse_args(argv)
    os.makedirs(args.out_dir, exist_ok=True)
    work_dir = tempfile.mkdtemp(prefix=".milo_tflite-", dir=args.out_dir)
    try:
        wrapped_path = os.path.join(work_dir, "wrapped.onnx")
        saved_model = os.path.join(work_dir, "saved_model")
        wrapped_model(args.onnx, wrapped_path)
        np.save(
            os.path.join(work_dir, "calibration_image_sample_data_20x128x128x3_float32.npy"),
            np.zeros((20, INPUT_SIZE, INPUT_SIZE, 3), dtype=np.float32),
        )
        env = os.environ.copy()
        env["PATH"] = os.path.dirname(sys.executable) + os.pathsep + env.get("PATH", "")
        subprocess.run(
            [
                os.path.join(os.path.dirname(sys.executable), "onnx2tf"),
                "-i", wrapped_path, "-o", saved_model, "-b", "1",
                "-kat", "image", "-osd",
            ],
            check=True,
            cwd=work_dir,
            env=env,
        )
        results = []
        for filename, fp16 in (("milo_cnn_fp32.tflite", False), ("milo_cnn_fp16.tflite", True)):
            output_path = os.path.join(args.out_dir, filename)
            with open(output_path, "wb") as stream:
                stream.write(convert(saved_model, output_path, fp16))
            summary = ops_summary(output_path)
            results.append(output_path)
            print(f"{filename}: bytes={os.path.getsize(output_path)} sha256={sha256_file(output_path)}")
            print(f"{filename} ops: {summary}")
        if args.check and not parity(args.onnx, results, args.check):
            print("error: parity check failed", file=sys.stderr)
            return 1
        if not args.check:
            print("no --check images given, skipping parity check")
        return 0
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
