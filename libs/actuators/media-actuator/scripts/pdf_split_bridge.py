#!/usr/bin/env python3
"""Kyberion media-actuator PDF split bridge.

Splits a (optionally password-protected) PDF into one file per page using pypdf.
Decryption and per-page copying are done in-process — the password is read from
stdin, never passed on argv (so it cannot leak via the process list).

Contract (driven by media-actuator `pdf_split` op):
  argv:  --input <abs.pdf> --out-dir <abs dir> --prefix <name> --pad <int>
  stdin: the password (single line; empty / absent => no password)
  stdout: a single JSON object:
    success -> {"ok": true, "count": N, "out_dir": "...", "pages": ["...", ...]}
    failure -> {"ok": false, "error": "<message>", "code": "<machine code>"}
  exit code: 0 on success, non-zero on failure (code field carries the reason).
"""

import argparse
import json
import os
import sys


def _fail(code: str, message: str, status: int) -> "NoReturn":  # type: ignore[name-defined]
    sys.stdout.write(json.dumps({"ok": False, "error": message, "code": code}))
    sys.stdout.flush()
    sys.exit(status)


def main() -> None:
    parser = argparse.ArgumentParser(description="Split a PDF into one file per page.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--prefix", default="page")
    parser.add_argument("--pad", type=int, default=3)
    args = parser.parse_args()

    try:
        from pypdf import PdfReader, PdfWriter  # type: ignore
    except ImportError:
        _fail(
            "pypdf_missing",
            "pypdf is not installed in the selected Python runtime. Set KYBERION_PYTHON_BIN / KYBERION_PYTHON to a runtime with pypdf available.",
            3,
        )

    if not os.path.isfile(args.input):
        _fail("input_not_found", f"input PDF not found: {args.input}", 2)

    # Password arrives on stdin so it never appears in argv / the process list.
    password = sys.stdin.read()
    password = password.split("\n", 1)[0].rstrip("\r") if password else ""

    try:
        reader = PdfReader(args.input)
    except Exception as exc:  # noqa: BLE001 - surface any parse error to the caller
        _fail("parse_error", f"failed to read PDF: {exc}", 5)

    if reader.is_encrypted:
        try:
            # PdfReader.decrypt returns a PasswordType (truthy) on success, 0/falsey on failure.
            if not reader.decrypt(password):
                _fail(
                    "bad_password",
                    "incorrect password or the PDF could not be decrypted",
                    4,
                )
        except Exception as exc:  # noqa: BLE001
            _fail("decrypt_error", f"decryption failed: {exc}", 4)

    total = len(reader.pages)
    if total == 0:
        _fail("empty_pdf", "the PDF has no pages", 6)

    os.makedirs(args.out_dir, exist_ok=True)
    pad = max(args.pad, len(str(total)))
    pages = []
    for index, page in enumerate(reader.pages, start=1):
        writer = PdfWriter()
        writer.add_page(page)
        out_path = os.path.join(args.out_dir, f"{args.prefix}-{index:0{pad}d}.pdf")
        with open(out_path, "wb") as handle:
            writer.write(handle)
        pages.append(out_path)

    sys.stdout.write(
        json.dumps({"ok": True, "count": total, "out_dir": args.out_dir, "pages": pages})
    )
    sys.stdout.flush()


if __name__ == "__main__":
    main()
