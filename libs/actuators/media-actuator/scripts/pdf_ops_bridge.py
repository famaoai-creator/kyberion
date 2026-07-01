#!/usr/bin/env python3
"""Kyberion media-actuator PDF operations bridge (pypdf backend).

A single entry point for several page-level PDF manipulations that complement
`pdf_split` (see pdf_split_bridge.py). Each invocation runs one --command.

Passwords are read as a JSON object on stdin so they never appear on argv:
    {"password": "...", "user_password": "...", "owner_password": "..."}
- `password`        : used to DECRYPT an encrypted input (any command).
- `user_password`   : open password to set on the OUTPUT (encrypt command).
- `owner_password`  : permissions password to set on the OUTPUT (encrypt command).
All keys are optional; absent => empty / no password.

Page selectors (`--pages`, `--order`, `--delete`) accept 1-based specs like
"1-3,7,10-" (open-ended ranges allowed) or the literal "all".

stdout: a single JSON object.
    success -> {"ok": true, ...command-specific fields...}
    failure -> {"ok": false, "error": "<message>", "code": "<machine code>"}
exit: 0 on success, non-zero on failure.
"""

import argparse
import json
import os
import sys


def _fail(code, message, status):
    sys.stdout.write(json.dumps({"ok": False, "error": message, "code": code}))
    sys.stdout.flush()
    sys.exit(status)


def _read_stdin_passwords():
    raw = sys.stdin.read() if not sys.stdin.isatty() else ""
    if not raw.strip():
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        # Backward-friendly: a bare line is treated as the decrypt password.
        return {"password": raw.split("\n", 1)[0].rstrip("\r")}


def _parse_page_spec(spec, total):
    """Parse a 1-based page spec into a 0-based index list (order preserved)."""
    if spec is None or str(spec).strip().lower() == "all":
        return list(range(total))
    out = []
    for token in str(spec).split(","):
        token = token.strip()
        if not token:
            continue
        if "-" in token:
            start_s, end_s = token.split("-", 1)
            start = int(start_s) if start_s.strip() else 1
            end = int(end_s) if end_s.strip() else total
        else:
            start = end = int(token)
        if start < 1 or end < 1 or start > total or end > total or start > end:
            raise ValueError(f"page selector out of range (1..{total}): '{token}'")
        out.extend(range(start - 1, end))
    return out


def _open_reader(path, password):
    from pypdf import PdfReader

    if not os.path.isfile(path):
        _fail("input_not_found", f"input PDF not found: {path}", 2)
    try:
        reader = PdfReader(path)
    except Exception as exc:  # noqa: BLE001
        _fail("parse_error", f"failed to read PDF ({path}): {exc}", 5)
    if reader.is_encrypted:
        try:
            if not reader.decrypt(password or ""):
                _fail("bad_password", f"incorrect password for: {path}", 4)
        except Exception as exc:  # noqa: BLE001
            _fail("decrypt_error", f"decryption failed ({path}): {exc}", 4)
    return reader


def _write(writer, out_path):
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "wb") as handle:
        writer.write(handle)


def cmd_merge(args, pw):
    from pypdf import PdfWriter

    inputs = [p for p in (args.inputs or "").split(os.pathsep) if p]
    if len(inputs) < 2:
        _fail("bad_args", "merge requires at least two --inputs (os.pathsep-separated)", 1)
    writer = PdfWriter()
    total = 0
    for path in inputs:
        reader = _open_reader(path, pw.get("password"))
        for page in reader.pages:
            writer.add_page(page)
            total += 1
    _write(writer, args.out)
    return {"ok": True, "command": "merge", "count": total, "out": args.out, "inputs": inputs}


def _subset_writer(reader, indices):
    from pypdf import PdfWriter

    writer = PdfWriter()
    for i in indices:
        writer.add_page(reader.pages[i])
    return writer


def cmd_extract_range(args, pw):
    reader = _open_reader(args.input, pw.get("password"))
    indices = _parse_page_spec(args.pages, len(reader.pages))
    if not indices:
        _fail("empty_selection", "no pages selected", 6)
    writer = _subset_writer(reader, indices)
    _write(writer, args.out)
    return {"ok": True, "command": "extract_range", "count": len(indices), "out": args.out,
            "pages": [i + 1 for i in indices]}


def cmd_delete_pages(args, pw):
    reader = _open_reader(args.input, pw.get("password"))
    total = len(reader.pages)
    drop = set(_parse_page_spec(args.delete, total))
    keep = [i for i in range(total) if i not in drop]
    if not keep:
        _fail("empty_result", "deleting these pages would leave an empty PDF", 6)
    writer = _subset_writer(reader, keep)
    _write(writer, args.out)
    return {"ok": True, "command": "delete_pages", "count": len(keep), "out": args.out,
            "deleted": [i + 1 for i in sorted(drop)]}


def cmd_reorder(args, pw):
    reader = _open_reader(args.input, pw.get("password"))
    indices = _parse_page_spec(args.order, len(reader.pages))
    if not indices:
        _fail("empty_selection", "reorder needs a non-empty --order", 6)
    writer = _subset_writer(reader, indices)
    _write(writer, args.out)
    return {"ok": True, "command": "reorder", "count": len(indices), "out": args.out,
            "order": [i + 1 for i in indices]}


def cmd_rotate(args, pw):
    reader = _open_reader(args.input, pw.get("password"))
    if args.angle % 90 != 0:
        _fail("bad_args", "rotate --angle must be a multiple of 90", 1)
    targets = set(_parse_page_spec(args.pages, len(reader.pages)))
    writer = _subset_writer(reader, range(len(reader.pages)))
    for i, page in enumerate(writer.pages):
        if i in targets:
            page.rotate(args.angle)
    _write(writer, args.out)
    return {"ok": True, "command": "rotate", "count": len(reader.pages), "out": args.out,
            "rotated": [i + 1 for i in sorted(targets)], "angle": args.angle}


def cmd_remove_password(args, pw):
    reader = _open_reader(args.input, pw.get("password"))
    writer = _subset_writer(reader, range(len(reader.pages)))  # no encryption on write
    _write(writer, args.out)
    return {"ok": True, "command": "remove_password", "count": len(reader.pages), "out": args.out}


def cmd_encrypt(args, pw):
    reader = _open_reader(args.input, pw.get("password"))
    writer = _subset_writer(reader, range(len(reader.pages)))
    user_pw = pw.get("user_password", "")
    owner_pw = pw.get("owner_password") or user_pw
    if not user_pw and not owner_pw:
        _fail("bad_args", "encrypt requires user_password (and/or owner_password) on stdin", 1)
    writer.encrypt(user_password=user_pw, owner_password=owner_pw, algorithm="AES-256")
    _write(writer, args.out)
    return {"ok": True, "command": "encrypt", "count": len(reader.pages), "out": args.out}


def cmd_metadata(args, pw):
    reader = _open_reader(args.input, pw.get("password"))
    current = {k: str(v) for k, v in (reader.metadata or {}).items()}
    updates = {}
    if args.set:
        try:
            parsed = json.loads(args.set)
            if not isinstance(parsed, dict):
                raise ValueError
        except ValueError:
            _fail("bad_args", "--set must be a JSON object of {\"/Key\": \"value\"}", 1)
        # Normalize keys to the PDF "/Key" convention.
        updates = {(k if k.startswith("/") else f"/{k}"): str(v) for k, v in parsed.items()}
    if updates and args.out:
        writer = _subset_writer(reader, range(len(reader.pages)))
        writer.add_metadata(updates)
        _write(writer, args.out)
        merged = {**current, **updates}
        return {"ok": True, "command": "metadata", "out": args.out, "metadata": merged}
    return {"ok": True, "command": "metadata", "metadata": current, "count": len(reader.pages)}


def cmd_stamp(args, pw):
    reader = _open_reader(args.input, pw.get("password"))
    stamp_reader = _open_reader(args.stamp, pw.get("password"))
    stamp_page = stamp_reader.pages[0]
    targets = set(_parse_page_spec(args.pages, len(reader.pages)))
    writer = _subset_writer(reader, range(len(reader.pages)))
    for i, page in enumerate(writer.pages):
        if i in targets:
            page.merge_page(stamp_page)
    _write(writer, args.out)
    return {"ok": True, "command": "stamp", "count": len(reader.pages), "out": args.out,
            "stamped": [i + 1 for i in sorted(targets)]}


COMMANDS = {
    "merge": cmd_merge,
    "extract_range": cmd_extract_range,
    "delete_pages": cmd_delete_pages,
    "reorder": cmd_reorder,
    "rotate": cmd_rotate,
    "remove_password": cmd_remove_password,
    "encrypt": cmd_encrypt,
    "metadata": cmd_metadata,
    "stamp": cmd_stamp,
}


def main():
    parser = argparse.ArgumentParser(description="PDF page operations via pypdf.")
    parser.add_argument("--command", required=True, choices=sorted(COMMANDS.keys()))
    parser.add_argument("--input")
    parser.add_argument("--inputs")  # merge: os.pathsep-separated paths
    parser.add_argument("--out")
    parser.add_argument("--pages")   # extract_range / rotate / stamp selector
    parser.add_argument("--delete")  # delete_pages selector
    parser.add_argument("--order")   # reorder selector
    parser.add_argument("--angle", type=int, default=90)
    parser.add_argument("--stamp")   # stamp overlay PDF
    parser.add_argument("--set")     # metadata: JSON object
    args = parser.parse_args()

    try:
        from pypdf import PdfReader, PdfWriter  # noqa: F401  (import probe)
    except ImportError:
        _fail("pypdf_missing", "pypdf is not installed. Install it with: python3 -m pip install pypdf", 3)

    pw = _read_stdin_passwords()

    handler = COMMANDS[args.command]
    try:
        result = handler(args, pw)
    except SystemExit:
        raise
    except ValueError as exc:
        _fail("bad_args", str(exc), 1)
    except Exception as exc:  # noqa: BLE001
        _fail("op_error", f"{args.command} failed: {exc}", 7)

    sys.stdout.write(json.dumps(result))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
