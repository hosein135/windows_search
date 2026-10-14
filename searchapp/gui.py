"""Tkinter window for searching the CSV files."""

from __future__ import annotations

import queue
import sys
import threading
from collections import OrderedDict

try:
    import tkinter as tk
    from tkinter import ttk
except ImportError:  # pragma: no cover - setup installs a Python that includes Tk
    tk = None
    ttk = None

from .catalog import scan_csv_files
from .engine import SearchEngine
from .normalize import QUERY_LABELS
from .sources import DISPLAY_FIELDS

ALWAYS_COLUMNS = frozenset({"full_name", "national_code", "source_label", "file_name"})

RESULT_COLUMNS = (("n", "#"), ("score", "Score"), *DISPLAY_FIELDS)

COLUMN_WIDTHS = {
    "n": 44,
    "score": 64,
    "full_name": 180,
    "father_name": 130,
    "national_code": 120,
    "birth_date": 100,
    "mobile": 120,
    "phone": 120,
    "card": 150,
    "account": 130,
    "city": 100,
    "province": 110,
    "birth_city": 110,
    "birth_province": 120,
    "address": 240,
    "source_label": 120,
    "file_name": 170,
}

BG = "#101418"
PANEL = "#171d24"
FIELD = "#1d242d"
TEXT = "#dbe2ea"
MUTED = "#8a97a5"
ACCENT = "#4f9cff"
OK = "#39c26e"
BAD = "#e05656"

EMPTY_STATUS = "Enter a name, national code, mobile, or card number. Pick a file to search one CSV."


def format_bytes(size: int) -> str:
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    return f"{size / 1024 / 1024:.1f} MB"


def source_choices(catalog: dict) -> list[tuple[str, str]]:
    """Display label and the source id or `source:filename` tag passed to search."""
    files = catalog.get("files") or []
    groups: OrderedDict[str, dict] = OrderedDict()
    for item in files:
        if not item.get("known"):
            continue
        group = groups.setdefault(item["source_id"], {"label": item["source_label"], "files": []})
        group["files"].append(item)
    choices = [("All CSV files", "")]
    for source_id, group in groups.items():
        choices.append((f"All {group['label']}", source_id))
        for item in group["files"]:
            choices.append((f"{group['label']} / {item['name']}", item.get("source_tag") or ""))
    for item in files:
        if item.get("known"):
            continue
        folder = item.get("folder") or "CSV"
        choices.append((f"{folder} / {item['name']}", item.get("source_tag") or ""))
    return choices


def visible_columns(rows: list[dict]) -> list[tuple[str, str]]:
    columns = [("n", "#"), ("score", "Score")]
    for key, label in DISPLAY_FIELDS:
        if key in ALWAYS_COLUMNS or any(row.get(key) for row in rows):
            columns.append((key, label))
    return columns


def status_text(result: dict | None) -> str:
    if result is None or result.get("query", {}).get("type") == "empty":
        return EMPTY_STATUS
    if result.get("query", {}).get("type") == "browse":
        shown = int(result.get("shown") or 0)
        matches = int(result.get("matches") or 0)
        if matches and shown != matches:
            return f"Showing {shown} of {matches} rows from the selected file"
        return f"Showing {shown} rows from the selected file"
    if result.get("error"):
        return str(result["error"])
    kind = QUERY_LABELS.get(result["query"]["type"], result["query"]["type"])
    matches = int(result.get("matches") or 0)
    shown = int(result.get("shown") or 0)
    if matches == 0:
        count = "No matching rows"
    elif matches != shown:
        count = f"showing {shown} of {matches}"
    elif matches == 1:
        count = "1 match"
    else:
        count = f"{matches} matches"
    files = int(result.get("files") or 0)
    text = f"{kind} search · {count} · {float(result.get('took_ms') or 0):.0f} ms · {files} CSV file"
    if files != 1:
        text += "s"
    warnings = [item for item in (result.get("warnings") or []) if item]
    if warnings:
        text += " · " + "; ".join(warnings)
    return text


def _empty_result() -> dict:
    return {
        "query": {"type": "empty"},
        "rows": [],
        "error": None,
        "warnings": [],
        "matches": 0,
        "shown": 0,
        "took_ms": 0,
        "files": 0,
    }


class SearchApp:
    def __init__(self, engine: SearchEngine):
        if tk is None or ttk is None:
            raise RuntimeError("Tkinter is not available. Run search.cmd so Python can be installed.")
        _enable_dpi()
        self.engine = engine
        self._choices: list[tuple[str, str]] = [("All CSV files", "")]
        self.root = tk.Tk()
        self.root.title("Person Search")
        self.root.geometry("1180x760")
        self.root.minsize(900, 560)
        self.root.configure(bg=BG)
        self.query_var = tk.StringVar()
        self._searching = False
        self._selected_source = ""
        self._file_tags: dict[str, str] = {}
        self._suppress_select = 0
        self._build_style()
        self._build()
        # Fill the file list on this thread. DuckDB row counts arrive later.
        # Updating Tk from the loader thread never reaches the window.
        self.apply_catalog({
            "files": [item.as_dict() for item in scan_csv_files(self.engine.databases_dir)],
            "warnings": [],
        })
        self._jobs: queue.Queue = queue.Queue()
        self._events: queue.Queue = queue.Queue()
        self._worker: threading.Thread | None = None

    def run(self) -> None:
        self._worker = threading.Thread(target=self._worker_loop, daemon=True)
        self._worker.start()
        self._jobs.put(("catalog",))
        if not self.query_var.get().strip():
            self._set_status("Reading CSV files…")
        self._poll()
        try:
            self.root.mainloop()
        finally:
            self._jobs.put(("stop",))

    def refresh_catalog(self) -> None:
        self.apply_catalog(self.engine.catalog())

    def apply_catalog(self, catalog: dict) -> None:
        current = self._source_value()
        self._choices = source_choices(catalog)
        self.source["values"] = [label for label, _value in self._choices]
        selected = next((index for index, (_label, value) in enumerate(self._choices) if value == current), 0)
        self._suppress_select += 1
        try:
            self.source.current(selected)
            file_list = catalog.get("files") or []
            self._fill_files(file_list)
        finally:
            self._suppress_select = max(0, self._suppress_select - 1)
        known = len(file_list)
        rows = sum(int(item.get("rows") or 0) for item in file_list)
        suffix = "" if known == 1 else "s"
        self.chip.configure(text=f"DuckDB · {known} file{suffix} · {rows} rows")
        warnings = [item for item in (catalog.get("warnings") or []) if item]
        if warnings and not self.query_var.get().strip():
            self._set_status("; ".join(warnings), error=True)

    def search_now(self) -> dict:
        """Run the query on the calling thread and fill the results table."""
        query = self.query_var.get().strip()[:200]
        if not query:
            result = _empty_result()
            self.show_result(result)
            return result
        source = self._source_value() or None
        try:
            result = self.engine.search(query, source=source, limit=50)
        except Exception as exc:
            result = _empty_result() | {"error": str(exc).splitlines()[0]}
        self.show_result(result)
        return result

    def show_result(self, result: dict) -> None:
        try:
            self._set_status(status_text(result), error=bool(result.get("error")))
            rows = result.get("rows") or []
            shown = [("n", "#"), ("score", "Score"), *DISPLAY_FIELDS]
            self.results["displaycolumns"] = [key for key, _label in shown]
            for key, label in RESULT_COLUMNS:
                self.results.heading(key, text=label)
            children = self.results.get_children()
            if children:
                self.results.delete(*children)
            if rows:
                for index, row in enumerate(rows, start=1):
                    values = []
                    for key, _label in RESULT_COLUMNS:
                        if key == "n":
                            values.append(str(index))
                            continue
                        value = row.get(key)
                        values.append("" if value is None else str(value))
                    self.results.insert("", "end", values=values)
            elif result.get("query", {}).get("type") not in (None, "empty"):
                placeholder = [""] * len(RESULT_COLUMNS)
                placeholder[2] = "No matching rows"
                self.results.insert("", "end", values=placeholder)
        finally:
            self._search_done()

    def _search_done(self) -> None:
        self._searching = False
        if self.search_btn is not None:
            self.search_btn.configure(text="Search")
            self.search_btn.state(["!disabled"])

    def _build_style(self) -> None:
        style = ttk.Style(self.root)
        style.theme_use("clam")
        style.configure(".", background=BG, foreground=TEXT, font=("Segoe UI", 10))
        style.configure("TFrame", background=BG)
        style.configure("Header.TFrame", background=PANEL)
        style.configure("Header.TLabel", background=PANEL, foreground=TEXT, font=("Segoe UI", 16, "bold"))
        style.configure("Chip.TLabel", background=PANEL, foreground=OK, font=("Segoe UI", 10))
        style.configure("Muted.TLabel", background=BG, foreground=MUTED)
        style.configure("Error.TLabel", background=BG, foreground=BAD)
        style.configure("Section.TLabel", background=BG, foreground=TEXT, font=("Segoe UI", 12, "bold"))
        style.configure("TButton", background=ACCENT, foreground="#041018", padding=(14, 8), font=("Segoe UI", 10, "bold"))
        style.map("TButton", background=[("disabled", "#2a3441"), ("active", "#79b4ff")])
        style.configure("TEntry", fieldbackground=FIELD, foreground=TEXT, insertcolor=TEXT, padding=6)
        style.configure("TCombobox", fieldbackground=FIELD, background=FIELD, foreground=TEXT, arrowcolor=TEXT, padding=4)
        style.map("TCombobox", fieldbackground=[("readonly", FIELD)], foreground=[("readonly", TEXT)])
        style.configure("Treeview", background=PANEL, fieldbackground=PANEL, foreground=TEXT, borderwidth=0, rowheight=26, font=("Segoe UI", 10))
        style.configure("Treeview.Heading", background=FIELD, foreground=MUTED, relief="flat", font=("Segoe UI", 9))
        style.map("Treeview", background=[("selected", "#1e3a5f")], foreground=[("selected", TEXT)])
        style.configure("Vertical.TScrollbar", background=FIELD, troughcolor=BG, arrowcolor=TEXT)
        style.configure("Horizontal.TScrollbar", background=FIELD, troughcolor=BG, arrowcolor=TEXT)

    def _build(self) -> None:
        header = ttk.Frame(self.root, style="Header.TFrame")
        header.pack(fill="x")
        ttk.Label(header, text="Person Search", style="Header.TLabel").pack(side="left", padx=16, pady=12)
        self.chip = ttk.Label(header, text="DuckDB", style="Chip.TLabel")
        self.chip.pack(side="right", padx=16)

        bar = ttk.Frame(self.root)
        bar.pack(fill="x", padx=16, pady=12)
        self.source = ttk.Combobox(bar, state="readonly", width=42)
        self.source.pack(side="left")
        self.source["values"] = ["All CSV files"]
        self.source.current(0)
        self.source.bind("<<ComboboxSelected>>", self._on_combo_picked)
        entry = ttk.Entry(bar, textvariable=self.query_var)
        entry.pack(side="left", fill="x", expand=True, padx=10)
        entry.bind("<Return>", lambda _event: self.on_search())
        entry.focus_set()
        self.search_btn = ttk.Button(bar, text="Search", command=self.on_search)
        self.search_btn.pack(side="left")

        self.status = ttk.Label(self.root, text=EMPTY_STATUS, style="Muted.TLabel", wraplength=1100, justify="left")
        self.status.pack(fill="x", padx=16, pady=(0, 8))

        ttk.Label(self.root, text="Results", style="Section.TLabel").pack(anchor="w", padx=16)
        results_frame = ttk.Frame(self.root)
        results_frame.pack(fill="both", expand=True, padx=16, pady=(0, 8))
        results_frame.rowconfigure(0, weight=1)
        results_frame.columnconfigure(0, weight=1)
        self.results = ttk.Treeview(
            results_frame,
            columns=[key for key, _label in RESULT_COLUMNS],
            show="headings",
            selectmode="browse",
            height=12,
        )
        for key, label in RESULT_COLUMNS:
            self.results.heading(key, text=label)
            self.results.column(key, width=COLUMN_WIDTHS.get(key, 110), minwidth=44, stretch=key in {"full_name", "address"}, anchor="w")
        y_scroll = ttk.Scrollbar(results_frame, orient="vertical", command=self.results.yview)
        x_scroll = ttk.Scrollbar(results_frame, orient="horizontal", command=self.results.xview)
        self.results.configure(yscrollcommand=y_scroll.set, xscrollcommand=x_scroll.set)
        self.results.grid(row=0, column=0, sticky="nsew")
        y_scroll.grid(row=0, column=1, sticky="ns")
        x_scroll.grid(row=1, column=0, sticky="ew")

        ttk.Label(self.root, text="CSV files", style="Section.TLabel").pack(anchor="w", padx=16)
        ttk.Label(
            self.root,
            text="Click a CSV to search only that file. Choose All CSV files to search every file.",
            style="Muted.TLabel",
        ).pack(anchor="w", padx=16, pady=(0, 4))
        files_frame = ttk.Frame(self.root)
        files_frame.pack(fill="x", padx=16, pady=(0, 14))
        self.files = ttk.Treeview(
            files_frame,
            columns=("folder", "file", "layout", "rows", "size"),
            show="headings",
            height=8,
            selectmode="browse",
        )
        for key, label, width in (
            ("folder", "Folder", 160),
            ("file", "File", 280),
            ("layout", "Layout", 160),
            ("rows", "Rows", 80),
            ("size", "Size", 90),
        ):
            self.files.heading(key, text=label)
            self.files.column(key, width=width, anchor="w")
        files_scroll = ttk.Scrollbar(files_frame, orient="vertical", command=self.files.yview)
        self.files.configure(yscrollcommand=files_scroll.set)
        self.files.pack(side="left", fill="both", expand=True)
        files_scroll.pack(side="right", fill="y")
        self.files.bind("<<TreeviewSelect>>", self._on_file_picked)
        self.files.bind("<MouseWheel>", self._scroll_files)

    def on_search(self) -> None:
        if self._searching:
            return
        query = self.query_var.get().strip()[:200]
        if not query:
            self.show_result(_empty_result())
            return
        self._searching = True
        self.search_btn.state(["disabled"])
        self.search_btn.configure(text="Searching…")
        self._set_status("Searching…")
        self.root.update_idletasks()
        source = self._source_value()
        if self._worker is None:
            self.show_result(self._run_search(query, source))
            return
        self._jobs.put(("search", query, source))

    def _run_search(self, query: str, source: str) -> dict:
        try:
            return self.engine.search(query, source=source or None, limit=50)
        except Exception as exc:
            return _empty_result() | {"error": str(exc).splitlines()[0]}

    def _run_preview(self, source: str) -> dict:
        try:
            return self.engine.preview(source or None, limit=50)
        except Exception as exc:
            return _empty_result() | {"error": str(exc).splitlines()[0]}

    def _worker_loop(self) -> None:
        while True:
            job = self._jobs.get()
            kind = job[0]
            if kind == "stop":
                return
            if kind == "catalog":
                try:
                    payload = self.engine.catalog()
                except Exception as exc:
                    payload = {"files": [], "warnings": [str(exc).splitlines()[0]]}
                self._events.put(("catalog", payload))
            elif kind == "search":
                self._events.put(("search", self._run_search(job[1], job[2])))
            elif kind == "preview":
                self._events.put(("search", self._run_preview(job[1])))

    def _poll(self) -> None:
        try:
            while True:
                kind, payload = self._events.get_nowait()
                try:
                    if kind == "catalog":
                        if payload.get("files"):
                            self.apply_catalog(payload)
                        if not self._searching and not self.query_var.get().strip():
                            if payload.get("warnings"):
                                self._set_status("; ".join(payload["warnings"]), error=True)
                            else:
                                self._set_status(EMPTY_STATUS)
                    elif kind == "search":
                        self.show_result(payload)
                except Exception as exc:
                    self._set_status(str(exc).splitlines()[0], error=True)
                    self._search_done()
        except queue.Empty:
            pass
        try:
            self.root.after(100, self._poll)
        except tk.TclError:
            return

    def _fill_files(self, files: list[dict]) -> None:
        self._suppress_select += 1
        try:
            children = self.files.get_children()
            if children:
                self.files.delete(*children)
            self._file_tags = {}
            self.files.configure(height=min(max(len(files), 1), 12))
            if not files:
                folder = self.engine.databases_dir
                self.files.insert("", "end", values=("", str(folder), "No CSV files in this folder", "", ""))
                return
            selected_iid = ""
            for index, item in enumerate(files):
                iid = f"file-{index}"
                tag = item.get("source_tag") or ""
                self._file_tags[iid] = tag
                layout = item["source_label"] if item.get("known") else item.get("folder") or "CSV"
                self.files.insert("", "end", iid=iid, values=(
                    item.get("folder") or "",
                    item.get("name") or "",
                    layout,
                    str(int(item.get("rows") or 0)),
                    format_bytes(int(item.get("size_bytes") or 0)),
                ))
                if tag and tag == self._selected_source:
                    selected_iid = iid
            if selected_iid:
                self.files.selection_set(selected_iid)
                self.files.see(selected_iid)
        finally:
            self._suppress_select = max(0, self._suppress_select - 1)

    def _on_file_picked(self, _event=None) -> None:
        if self._suppress_select or self._searching:
            return
        selected = self.files.selection()
        if not selected:
            return
        self._set_source(self._file_tags.get(selected[0], ""))
        if not self.query_var.get().strip():
            self._browse_selected()

    def _on_combo_picked(self, _event=None) -> None:
        if self._suppress_select or self._searching:
            return
        chosen = ""
        label = self.source.get()
        for text, value in self._choices:
            if text == label:
                chosen = value
                break
        self._set_source(chosen)
        if not self.query_var.get().strip() and chosen:
            self._browse_selected()

    def _set_source(self, tag: str) -> None:
        self._selected_source = tag or ""
        self._suppress_select += 1
        try:
            for index, (_label, value) in enumerate(self._choices):
                if value == self._selected_source:
                    self.source.current(index)
                    break
            for iid, file_tag in self._file_tags.items():
                if file_tag == self._selected_source:
                    self.files.selection_set(iid)
                    self.files.see(iid)
                    break
            else:
                if not self._selected_source:
                    self.files.selection_remove(self.files.selection())
        finally:
            self._suppress_select = max(0, self._suppress_select - 1)

    def _browse_selected(self) -> None:
        if self._searching:
            return
        source = self._selected_source
        if not source:
            return
        self._searching = True
        self.search_btn.state(["disabled"])
        self.search_btn.configure(text="Searching…")
        self._set_status("Reading the selected file…")
        self.root.update_idletasks()
        if self._worker is None:
            self.show_result(self._run_preview(source))
            return
        self._jobs.put(("preview", source))

    def _scroll_files(self, event):
        self.files.yview_scroll(int(-1 * (event.delta / 120)), "units")

    def _source_value(self) -> str:
        return self._selected_source or ""

    def _set_status(self, text: str, error: bool = False) -> None:
        self.status.configure(text=text, style="Error.TLabel" if error else "Muted.TLabel")


def _enable_dpi() -> None:
    if sys.platform != "win32" or tk is None:
        return
    try:
        import ctypes
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except Exception:
        return


def run_gui(engine: SearchEngine) -> int:
    if tk is None:
        print("Tkinter is not available. Run search.cmd so Python can be installed.", file=sys.stderr)
        engine.close()
        return 1
    try:
        SearchApp(engine).run()
    finally:
        engine.close()
    return 0
