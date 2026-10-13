"""Search CSV files from the command line, or open the Tkinter window.

Examples:
  python -m searchapp
  python -m searchapp search "علی" --source mellat
  python -m searchapp search 09120000000 --json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .engine import SearchEngine
from .gui import run_gui
from .normalize import QUERY_LABELS
from .paths import DATABASES_DIR

_COMPACT = (
    ("full_name", "name"),
    ("father_name", "father"),
    ("national_code", "national"),
    ("mobile", "mobile"),
    ("phone", "phone"),
    ("card", "card"),
    ("account", "account"),
    ("city", "city"),
    ("file_name", "file"),
)


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = _parse(argv)
    engine = SearchEngine(args.databases)
    try:
        if args.command == "search":
            return _print_search(engine, args)
        return run_gui(engine)
    finally:
        if args.command == "search":
            engine.close()


def _parse(argv: list[str] | None) -> argparse.Namespace:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] not in {"search", "-h", "--help"} and not argv[0].startswith("-"):
        argv = ["search", *argv]
    parser = argparse.ArgumentParser(description="Search CSV files with DuckDB")
    parser.add_argument("--databases", type=Path, default=DATABASES_DIR, help="folder of CSV files")
    sub = parser.add_subparsers(dest="command")

    search = sub.add_parser("search", help="print matches and exit")
    search.add_argument("query")
    search.add_argument("--source", default=None, help="source id (mellat) or tag (mellat:file.csv)")
    search.add_argument("--limit", type=int, default=50)
    search.add_argument("--json", action="store_true")

    args = parser.parse_args(argv)
    if not args.command:
        args.command = "gui"
    return args


def _print_search(engine: SearchEngine, args: argparse.Namespace) -> int:
    result = engine.search(args.query, source=args.source, limit=args.limit)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
        return 1 if result.get("error") else 0
    if result.get("error"):
        print(result["error"], file=sys.stderr)
        return 1
    kind = QUERY_LABELS.get(result["query"]["type"], result["query"]["type"])
    print(f"{kind} · {result['matches']} match(es) · showing {result['shown']} · {result['took_ms']:.0f} ms")
    for warning in result["warnings"]:
        print("warning:", warning, file=sys.stderr)
    if not result["rows"]:
        return 0
    for index, row in enumerate(result["rows"], start=1):
        bits = [f"{index}."]
        for key, label in _COMPACT:
            value = row.get(key)
            if value:
                bits.append(f"{label} {value}")
        print("  ".join(bits))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
