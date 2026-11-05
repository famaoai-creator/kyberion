"""Local MediaPipe Tasks inference; data and .task bundles are explicit local files.
No webcam, model resolver, hub client, or implicit download path is used.
Invoked only through the governed TypeScript tracking adapter.
"""
import argparse
import contextlib
import json
import math
import os
import sys

# Bound raster decompression before OpenCV is imported.
os.environ["OPENCV_IO_MAX_IMAGE_PIXELS"] = "16777216"
os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "protocol_whitelist;file,crypto,data|format_whitelist;mov,matroska,webm,avi"


def local_file(value):
    if not os.path.isfile(value) or os.path.islink(value):
        raise ValueError("input/model must be a local regular file")
    return value


def points(landmarks):
    return [{"x": float(p.x), "y": float(p.y), "z": float(p.z),
             **({"visibility": float(p.visibility)} if getattr(p, "visibility", None) is not None else {})}
            for p in landmarks]


def infer(args):
    try:
        import cv2
        import mediapipe as mp
        from mediapipe.tasks import python
        from mediapipe.tasks.python import vision
    except ImportError as exc:
        raise RuntimeError("Install mediapipe and opencv-python in the selected Python environment") from exc
    video = os.path.splitext(args.input)[1].lower() in {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"}
    mode = vision.RunningMode.VIDEO if video or args.stream else vision.RunningMode.IMAGE
    frames = []
    warnings = []
    with contextlib.ExitStack() as stack:
        face = pose = gesture = None
        if args.face_model:
            face = stack.enter_context(vision.FaceLandmarker.create_from_options(
                vision.FaceLandmarkerOptions(base_options=python.BaseOptions(model_asset_path=args.face_model),
                    running_mode=mode, num_faces=1, output_face_blendshapes=True,
                    output_facial_transformation_matrixes=True)))
        if args.pose_model:
            pose = stack.enter_context(vision.PoseLandmarker.create_from_options(
                vision.PoseLandmarkerOptions(base_options=python.BaseOptions(model_asset_path=args.pose_model),
                    running_mode=mode, num_poses=1)))
        if args.gesture_model:
            gesture = stack.enter_context(vision.GestureRecognizer.create_from_options(
                vision.GestureRecognizerOptions(base_options=python.BaseOptions(model_asset_path=args.gesture_model),
                    running_mode=mode, num_hands=2)))

        def process(rgb, at_ms):
            height, width = rgb.shape[:2]
            if max(width, height) > 1280:
                scale = 1280.0 / max(width, height)
                rgb = cv2.resize(rgb, (max(1, round(width * scale)), max(1, round(height * scale))))
            image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            out = {"time_sec": at_ms / 1000.0, "faces": [], "poses": [], "gestures": []}
            if face is not None:
                result = face.detect_for_video(image, at_ms) if video or args.stream else face.detect(image)
                for index, landmarks in enumerate(result.face_landmarks):
                    item = {"landmarks": points(landmarks),
                            "blendshapes": {c.category_name: float(c.score) for c in result.face_blendshapes[index]}}
                    if index < len(result.facial_transformation_matrixes):
                        item["transform"] = result.facial_transformation_matrixes[index].flatten().tolist()
                    out["faces"].append(item)
            if pose is not None:
                result = pose.detect_for_video(image, at_ms) if video or args.stream else pose.detect(image)
                out["poses"] = [{"landmarks": points(p)} for p in result.pose_landmarks]
            if gesture is not None:
                result = gesture.recognize_for_video(image, at_ms) if video or args.stream else gesture.recognize(image)
                for index, categories in enumerate(result.gestures):
                    for category in categories[:1]:
                        handedness = result.handedness[index]
                        out["gestures"].append({"label": category.category_name, "confidence": float(category.score),
                            "handedness": handedness[0].category_name if handedness else "unknown",
                            "landmarks": points(result.hand_landmarks[index])})
            if args.stream:
                print(json.dumps({"provider": "mediapipe-local", "frames": [out], "warnings": []}, allow_nan=False, separators=(",", ":")), file=sys.__stdout__, flush=True)
            else:
                frames.append(out)

        if args.stream:
            previous = -1
            count = 0
            while count < args.max_frames:
                line = sys.stdin.readline(8193)
                if not line:
                    break
                if len(line) > 8192 or not line.endswith("\n"):
                    raise ValueError("stream request exceeded line limit")
                request = json.loads(line)
                if not isinstance(request, dict) or set(request) != {"path", "time_sec"}:
                    raise ValueError("stream request must contain path and time_sec")
                timestamp = request["time_sec"]
                if not isinstance(timestamp, (float, int)) or isinstance(timestamp, bool) or not math.isfinite(timestamp) or timestamp < 0 or timestamp > 86400:
                    raise ValueError("invalid stream timestamp")
                at_ms = round(timestamp * 1000)
                if at_ms <= previous:
                    raise ValueError("stream timestamps must increase by at least one millisecond")
                bgr = cv2.imread(local_file(request["path"]))
                if bgr is None:
                    raise ValueError("stream image could not be decoded")
                process(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), at_ms)
                previous = at_ms
                count += 1
        elif not video:
            bgr = cv2.imread(args.input)
            if bgr is None:
                raise ValueError("image could not be decoded")
            process(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), 0)
        else:
            capture = cv2.VideoCapture(args.input, cv2.CAP_FFMPEG)
            stack.callback(capture.release)
            if not capture.isOpened():
                raise ValueError("video could not be decoded")
            next_ms = 0
            previous_ms = -1
            decoded = 0
            last_decoded_ms = -1
            while len(frames) < args.max_frames:
                ok, bgr = capture.read()
                if not ok:
                    break
                decoded += 1
                if decoded > 300000:
                    raise ValueError("video exceeds decode frame budget")
                timestamp = capture.get(cv2.CAP_PROP_POS_MSEC)
                if not math.isfinite(timestamp) or timestamp < 0:
                    raise ValueError("decoder returned an invalid presentation timestamp")
                if timestamp <= last_decoded_ms:
                    raise ValueError("decoder did not provide increasing presentation timestamps")
                last_decoded_ms = timestamp
                if timestamp < next_ms:
                    continue
                at_ms = round(timestamp)
                if at_ms <= previous_ms:
                    raise ValueError("decoder did not return increasing presentation timestamps")
                if at_ms > 86400000:
                    raise ValueError("video exceeds 24-hour timestamp limit")
                process(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), at_ms)
                previous_ms = at_ms
                next_ms = at_ms + args.every_ms
            if len(frames) == args.max_frames:
                warnings.append("frame budget reached; output may cover only the beginning of the video")
            if not frames:
                raise ValueError("video produced no decodable frames")
    return {"provider": "mediapipe-local", "frames": frames, "warnings": warnings}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=local_file)
    parser.add_argument("--stream", action="store_true")
    parser.add_argument("--face-model", type=local_file)
    parser.add_argument("--pose-model", type=local_file)
    parser.add_argument("--gesture-model", type=local_file)
    parser.add_argument("--max-frames", type=int, default=60)
    parser.add_argument("--every-ms", type=int, default=200)
    args = parser.parse_args()
    if not 1 <= args.max_frames <= 300 or not 1 <= args.every_ms <= 60000:
        parser.error("frame/time budget out of range")
    if not args.stream and not args.input:
        parser.error("--input or --stream is required")
    if args.stream:
        args.input = ""
    if not (args.face_model or args.pose_model or args.gesture_model):
        parser.error("at least one local .task model is required")
    try:
        # Native model loaders may print progress; protocol stdout is exactly JSON.
        with contextlib.redirect_stdout(sys.stderr):
            output = infer(args)
        if not args.stream:
            print(json.dumps(output, allow_nan=False, separators=(",", ":")))
    except Exception as exc:
        print("Local MediaPipe tracking failed: " + str(exc)[:1000], file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
