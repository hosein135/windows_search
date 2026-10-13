"""Find CSV files under the databases directory."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .sources import resolve_source


@dataclass(frozen=True)
class CsvFile:
    path: Path
    name: str
    folder: str
    size_bytes: int
    source_id: str | None
    source_label: str
    known: bool

    @property
    def source_tag(self) -> str | None:
        if not self.source_id:
            return None
        return f"{self.source_id}:{self.name}"


def scan_csv_files(databases_dir: Path) -> list[CsvFile]:
    root = Path(databases_dir)
    if not root.is_dir():
        return []
    found: list[CsvFile] = []
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix.lower() != ".csv":
            continue
        source = resolve_source(path.parent.name, path.name)
        try:
            size = path.stat().st_size
        except OSError:
            size = 0
        found.append(CsvFile(
            path=path,
            name=path.name,
            folder=path.parent.name,
            size_bytes=size,
            source_id=source.id if source else None,
            source_label=source.label if source else "Unrecognized layout",
            known=source is not None,
        ))
    found.sort(key=lambda item: str(item.path).lower())
    return found
