"""DuckDB search over the CSV files.

Each query reads the files directly. Matching rows are not copied into a
separate database, so replacing a CSV is picked up on the next search.
"""

from __future__ import annotations

import threading
from pathlib import Path

import duckdb

from .catalog import CsvFile, scan_csv_files
from .normalize import classify_query, mobile_forms
from .paths import DATABASES_DIR
from .sources import ID_FIELDS, PHONE_FIELDS, Source, resolve_source

PERSON_COLUMNS = (
    "source_id", "source_label", "file_name", "source_tag",
    "national_code", "full_name", "first_name", "last_name", "father_name",
    "id_number", "birth_date", "city", "province", "birth_city", "birth_province",
    "address", "po_box", "mobile", "phone", "card", "account", "email",
    "define_number", "define_num_old", "branch",
    "mobile_key", "name_key", "search_blob",
)

_ID_COLUMNS = (
    "national_code", "mobile", "mobile_key", "card", "account", "id_number", "phone",
)

_PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹"
_ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩"


def sql_str(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def like_pattern(token: str) -> str:
    escaped = token.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _nested_replace(expr: str, pairs: list[tuple[str, str]]) -> str:
    out = expr
    for src, dst in pairs:
        out = f"replace({out}, {sql_str(src)}, {sql_str(dst)})"
    return out


def _fold_digits_expr(expr: str = "s") -> str:
    pairs = [(ch, str(i)) for i, ch in enumerate(_PERSIAN_DIGITS)]
    pairs += [(ch, str(i)) for i, ch in enumerate(_ARABIC_DIGITS)]
    return _nested_replace(expr, pairs)


class SearchEngine:
    def __init__(self, databases_dir: Path | None = None):
        self.databases_dir = Path(databases_dir) if databases_dir else DATABASES_DIR
        self._lock = threading.Lock()
        self._con = duckdb.connect()
        self._signature: tuple | None = None
        self._files: list[CsvFile] = []
        self._errors: list[str] = []
        self._row_counts: dict[str, int] = {}
        self._macros = False

    def close(self) -> None:
        with self._lock:
            if self._con is not None:
                self._con.close()
                self._con = None

    @property
    def connection(self):
        return self._con

    def catalog(self) -> dict:
        with self._lock:
            self._refresh()
            return self._catalog_payload()

    def sql_clean(self, value):
        """Return (text, id, phone) after the SQL cleaners. Used to keep SQL and Python in step."""
        with self._lock:
            self._ensure_macros()
            return self._con.execute(
                "SELECT ws_clean_text(?), ws_clean_id(?), ws_clean_phone(?)",
                [value, value, value],
            ).fetchone()

    def search(self, raw: str, source: str | None = None, limit: int = 50) -> dict:
        import time
        started = time.perf_counter()
        result = self._search_locked(raw, source, limit)
        result["took_ms"] = (time.perf_counter() - started) * 1000
        return result

    def _search_locked(self, raw: str, source: str | None, limit: int) -> dict:
        query = classify_query(raw)
        limit = max(1, min(int(limit or 50), 500))
        source_key = (source or "").strip() or None
        with self._lock:
            self._refresh()
            result = {
                "query": query,
                "source": source_key,
                "limit": limit,
                "rows": [],
                "matches": 0,
                "shown": 0,
                "took_ms": 0.0,
                "warnings": list(self._errors),
                "error": None,
                "files": len(self._files),
            }
            if query["type"] == "empty":
                return result
            try:
                sql, params = _search_sql(query, source_key, limit)
                cur = self._con.execute(sql, params)
                names = [item[0] for item in cur.description]
                raw_rows = [dict(zip(names, row)) for row in cur.fetchall()]
            except Exception as exc:
                result["error"] = str(exc).splitlines()[0]
                return result
        packed = _pack_rows(raw_rows)
        result.update(packed)
        return result

    def _catalog_payload(self) -> dict:
        return {
            "files": [
                item.as_dict(int(self._row_counts.get(item.source_tag, 0)))
                for item in self._files
            ],
            "warnings": list(self._errors),
        }

    def _refresh(self) -> None:
        files = scan_csv_files(self.databases_dir)
        signature = tuple(
            (str(item.path), item.path.stat().st_mtime_ns, item.path.stat().st_size)
            for item in files
        )
        self._files = files
        if signature == self._signature and self._macros:
            return
        self._ensure_macros()
        errors: list[str] = []
        branches: list[tuple[str, str]] = []
        for item in files:
            source = resolve_source(item.folder, item.name) if item.known else None
            try:
                if source is not None:
                    encoding, columns = self._inspect(item.path, header=False)
                    branch = _branch_sql(item, source, columns, encoding)
                else:
                    encoding, columns = self._inspect(item.path, header=True)
                    branch = _generic_branch_sql(item, columns, encoding)
                self._con.execute(f"SELECT * FROM ({branch}) WHERE FALSE")
                branches.append((item.source_tag, branch))
            except Exception as exc:
                errors.append(f"{item.folder}/{item.name}: {str(exc).splitlines()[0]}")
        # One file at a time, so a bad CSV does not drop the rest.
        nulls = ", ".join(f"NULL::VARCHAR AS {name}" for name in PERSON_COLUMNS)
        empty_sql = f"CREATE TABLE persons AS SELECT {nulls} WHERE FALSE"
        counts: dict[str, int] = {}
        try:
            self._con.execute("DROP TABLE IF EXISTS persons")
            self._con.execute(empty_sql)
            for tag, branch in branches:
                try:
                    self._con.execute(f"INSERT INTO persons BY NAME SELECT * FROM ({branch})")
                    counts[tag] = int(self._con.execute(
                        "SELECT count(*) FROM persons WHERE source_tag = ?",
                        [tag],
                    ).fetchone()[0])
                except Exception as exc:
                    errors.append(f"{tag}: {str(exc).splitlines()[0]}")
                    counts[tag] = 0
        except Exception as exc:
            errors.append(str(exc).splitlines()[0])
            self._con.execute("DROP TABLE IF EXISTS persons")
            self._con.execute(empty_sql)
            self._row_counts = {}
            self._errors = errors
            self._signature = None
            return
        self._row_counts = counts
        self._errors = errors
        self._signature = signature

    def _ensure_macros(self) -> None:
        if self._macros:
            return
        # Scalar subqueries so each input is cleaned once. Nested CASE macros
        # inline every copy of the expression and make planning extremely slow.
        fold_digits = _fold_digits_expr("s")
        fold_persian = _nested_replace("s", [("ي", "ی"), ("ك", "ک"), ("ـ", "")])
        statements = [
            f"""
            CREATE OR REPLACE MACRO ws_fold_digits(s) AS {fold_digits}
            """,
            f"""
            CREATE OR REPLACE MACRO ws_fold_persian(s) AS {fold_persian}
            """,
            """
            CREATE OR REPLACE MACRO ws_collapse(s) AS
              trim(regexp_replace(
                replace(replace(replace(COALESCE(s, ''), chr(9), ' '), chr(160), ' '), chr(65279), ' '),
                ' {2,}', ' ', 'g'
              ))
            """,
            """
            CREATE OR REPLACE MACRO ws_clean_text(s) AS (
              SELECT CASE
                WHEN s IS NULL OR v = '' OR lower(v) IN (
                  '-', '--', '—', '.', '..', 'null', 'none', 'nan', 'n/a', 'na', 'nil'
                ) THEN NULL
                ELSE nullif(trim(regexp_replace(ws_fold_persian(v), ' {2,}', ' ', 'g')), '')
              END
              FROM (SELECT ws_collapse(s) AS v)
            )
            """,
            r"""
            CREATE OR REPLACE MACRO ws_clean_id(s) AS (
              SELECT CASE
                WHEN t IS NULL THEN NULL
                ELSE regexp_replace(ws_fold_digits(t), '^([0-9]+)\.0+$', '\1')
              END
              FROM (SELECT ws_clean_text(s) AS t)
            )
            """,
            r"""
            CREATE OR REPLACE MACRO ws_clean_phone(s) AS (
              SELECT CASE
                WHEN d IS NULL OR regexp_full_match(d, '0+') THEN NULL
                ELSE d
              END
              FROM (
                SELECT nullif(regexp_replace(ws_fold_digits(t), '[^0-9]', '', 'g'), '') AS d
                FROM (SELECT ws_clean_text(s) AS t)
              )
            )
            """,
        ]
        for statement in statements:
            self._con.execute(statement)
        self._macros = True

    def _inspect(self, path: Path, header: bool) -> tuple[str, list[str]]:
        last: Exception | None = None
        for encoding in ("utf-8", "cp1256"):
            try:
                cur = self._con.execute(
                    f"SELECT * FROM {_read_csv(path, encoding, header)} LIMIT 0"
                )
                names = [item[0] for item in cur.description]
                if names:
                    return encoding, names
            except Exception as exc:
                last = exc
        assert last is not None
        raise last


def _read_csv(path: Path, encoding: str, header: bool = False) -> str:
    # parallel=false and sample_size=-1 make DuckDB scan every row instead of
    # stopping after a sniff sample.
    return (
        "read_csv("
        + sql_str(path.resolve().as_posix())
        + ", header=" + ("true" if header else "false")
        + ", all_varchar=true, delim=',', quote='\"', escape='\"', "
        + "strict_mode=false, null_padding=true, ignore_errors=true, "
        + "parallel=false, sample_size=-1, encoding="
        + sql_str(encoding)
        + ")"
    )


def _field_expr(field: str, indexes: dict[str, int], columns: list[str]) -> str:
    index = indexes.get(field)
    if index is None or index >= len(columns):
        return "NULL::VARCHAR"
    col = quote_ident(columns[index])
    if field in PHONE_FIELDS:
        return f"ws_clean_phone({col})"
    if field in ID_FIELDS:
        return f"ws_clean_id({col})"
    if field == "email":
        return f"lower(ws_clean_text({col}))"
    return f"ws_clean_text({col})"


def _branch_sql(item: CsvFile, source: Source, columns: list[str], encoding: str) -> str:
    indexes = {
        name: index
        for index, name in enumerate(source.columns)
        if name
    }
    first_col = quote_ident(columns[0]) if columns else "''"
    header = (
        "regexp_full_match(lower(trim(replace(replace(coalesce("
        + first_col
        + ", ''), chr(65279), ''), chr(9), ''))), "
        + sql_str(source.header_pattern)
        + ")"
    )
    scalars = {
        "national_code": _field_expr("national_code", indexes, columns),
        "first_name": _field_expr("first_name", indexes, columns),
        "last_name": _field_expr("last_name", indexes, columns),
        "father_name": _field_expr("father_name", indexes, columns),
        "id_number": _field_expr("id_number", indexes, columns),
        "birth_date": _field_expr("birth_date", indexes, columns),
        "city": _field_expr("city", indexes, columns),
        "province": _field_expr("province", indexes, columns),
        "birth_city": _field_expr("birth_city", indexes, columns),
        "birth_province": _field_expr("birth_province", indexes, columns),
        "address": _field_expr("address", indexes, columns),
        "po_box": _field_expr("po_box", indexes, columns),
        "mobile": _field_expr("mobile", indexes, columns),
        "phone": _field_expr("phone", indexes, columns),
        "card": _field_expr("card", indexes, columns),
        "account": _field_expr("account", indexes, columns),
        "email": _field_expr("email", indexes, columns),
        "define_number": _field_expr("define_number", indexes, columns),
        "define_num_old": _field_expr("define_num_old", indexes, columns),
        "branch": _field_expr("branch", indexes, columns),
    }
    own_name = _field_expr("full_name", indexes, columns)
    full_name = (
        f"COALESCE({own_name}, NULLIF(trim(concat_ws(' ', {scalars['first_name']}, {scalars['last_name']})), ''))"
    )
    select_list = ",\n".join([
        f"{sql_str(source.id)} AS source_id",
        f"{sql_str(source.label)} AS source_label",
        f"{sql_str(item.name)} AS file_name",
        f"{sql_str(item.source_tag or '')} AS source_tag",
        f"{scalars['national_code']} AS national_code",
        f"{full_name} AS full_name",
        f"{scalars['first_name']} AS first_name",
        f"{scalars['last_name']} AS last_name",
        f"{scalars['father_name']} AS father_name",
        f"{scalars['id_number']} AS id_number",
        f"{scalars['birth_date']} AS birth_date",
        f"{scalars['city']} AS city",
        f"{scalars['province']} AS province",
        f"{scalars['birth_city']} AS birth_city",
        f"{scalars['birth_province']} AS birth_province",
        f"{scalars['address']} AS address",
        f"{scalars['po_box']} AS po_box",
        f"{scalars['mobile']} AS mobile",
        f"{scalars['phone']} AS phone",
        f"{scalars['card']} AS card",
        f"{scalars['account']} AS account",
        f"{scalars['email']} AS email",
        f"{scalars['define_number']} AS define_number",
        f"{scalars['define_num_old']} AS define_num_old",
        f"{scalars['branch']} AS branch",
    ])
    return f"""
    SELECT
      cleaned.*,
      CASE
        WHEN mobile IS NULL THEN NULL
        WHEN regexp_full_match(mobile, '^9[0-9]{{9}}$') THEN '0' || mobile
        ELSE mobile
      END AS mobile_key,
      lower(ws_fold_digits(full_name)) AS name_key,
      lower(ws_fold_digits(concat_ws(' ', full_name, father_name))) AS search_blob
    FROM (
      SELECT
        {select_list}
      FROM {_read_csv(item.path, encoding)} AS raw
      WHERE NOT ({header})
    ) AS cleaned
    WHERE coalesce(
      national_code, full_name, first_name, last_name, mobile, phone, card, account
    ) IS NOT NULL
    """


def _generic_branch_sql(item: CsvFile, columns: list[str], encoding: str) -> str:
    """Read a CSV whose folder name is not one of the known layouts."""
    id_exprs = [f"ws_clean_id({quote_ident(name)})" for name in columns]
    phone_exprs = [f"ws_clean_phone({quote_ident(name)})" for name in columns]
    text_exprs = [f"ws_clean_text({quote_ident(name)})" for name in columns]
    blob = "concat_ws(' ', " + ", ".join(text_exprs) + ")" if text_exprs else "NULL"
    return f"""
    SELECT
      'file' AS source_id,
      {sql_str(item.folder)} AS source_label,
      {sql_str(item.name)} AS file_name,
      {sql_str(item.source_tag)} AS source_tag,
      {_first_match(id_exprs, "^[0-9]{10}$")} AS national_code,
      NULLIF(trim({blob}), '') AS full_name,
      NULL::VARCHAR AS first_name,
      NULL::VARCHAR AS last_name,
      NULL::VARCHAR AS father_name,
      NULL::VARCHAR AS id_number,
      NULL::VARCHAR AS birth_date,
      NULL::VARCHAR AS city,
      NULL::VARCHAR AS province,
      NULL::VARCHAR AS birth_city,
      NULL::VARCHAR AS birth_province,
      NULL::VARCHAR AS address,
      NULL::VARCHAR AS po_box,
      {_first_match(phone_exprs, "^0?9[0-9]{9}$")} AS mobile,
      NULL::VARCHAR AS phone,
      {_first_match(id_exprs, "^[0-9]{16}$")} AS card,
      NULL::VARCHAR AS account,
      NULL::VARCHAR AS email,
      NULL::VARCHAR AS define_number,
      NULL::VARCHAR AS define_num_old,
      NULL::VARCHAR AS branch,
      CASE
        WHEN {_first_match(phone_exprs, "^9[0-9]{9}$")} IS NOT NULL
          THEN '0' || {_first_match(phone_exprs, "^9[0-9]{9}$")}
        ELSE {_first_match(phone_exprs, "^0?9[0-9]{9}$")}
      END AS mobile_key,
      lower(ws_fold_digits(NULLIF(trim({blob}), ''))) AS name_key,
      lower(ws_fold_digits(NULLIF(trim({blob}), ''))) AS search_blob
    FROM {_read_csv(item.path, encoding, header=True)} AS raw
    WHERE NULLIF(trim({blob}), '') IS NOT NULL
    """


def _first_match(exprs: list[str], pattern: str) -> str:
    if not exprs:
        return "NULL::VARCHAR"
    cases = ", ".join(
        "CASE WHEN regexp_full_match(" + expr + ", '" + pattern + "') THEN " + expr + " END"
        for expr in exprs
    )
    return "COALESCE(" + cases + ")"


def _in_clause(column: str, values: list[str]) -> tuple[str, list[str]]:
    marks = ", ".join("?" for _ in values)
    return f"{column} IN ({marks})", list(values)


def _search_sql(query: dict, source: str | None, limit: int) -> tuple[str, list]:
    where: list[str] = []
    params: list = []
    if source:
        if ":" in source:
            where.append("source_tag = ?")
        else:
            where.append("source_id = ?")
        params.append(source)

    kind = query["type"]
    score_sql = "100"
    score_params: list = []
    if kind == "national_code":
        where.append("national_code = ?")
        params.append(query["value"])
    elif kind == "card":
        where.append("card = ?")
        params.append(query["value"])
    elif kind in {"mobile", "mobile_or_national"}:
        forms = mobile_forms(query["value"])
        parts = []
        for column in ("mobile", "mobile_key"):
            clause, values = _in_clause(column, forms)
            parts.append(clause)
            params.extend(values)
        if kind == "mobile_or_national":
            national = query["value"][1:] if query["value"].startswith("0") else query["value"]
            parts.append("national_code = ?")
            params.append(national)
        where.append("(" + " OR ".join(parts) + ")")
    elif kind == "any_id":
        forms = sorted(set(mobile_forms(query["value"])) | {query["value"]})
        parts = []
        for column in _ID_COLUMNS:
            clause, values = _in_clause(column, forms)
            parts.append(clause)
            params.extend(values)
        where.append("(" + " OR ".join(parts) + ")")
    elif kind == "name":
        for token in query["tokens"]:
            where.append("search_blob LIKE ? ESCAPE '\\'")
            params.append(like_pattern(token))
        score_sql = (
            "CASE WHEN name_key = ? THEN 1000 "
            "WHEN search_blob = ? THEN 800 ELSE 100 END"
        )
        score_params = [query["value"], query["value"]]
    else:
        where.append("FALSE")

    where_sql = " AND ".join(where) if where else "TRUE"
    order_sql = (
        "score DESC, length(coalesce(name_key, '')) ASC, full_name ASC, file_name ASC"
        if kind == "name"
        else "source_label ASC, file_name ASC, full_name ASC"
    )
    sql = f"""
        SELECT * FROM (
          SELECT hits.*, {score_sql} AS score
          FROM (
            SELECT *, count(*) OVER () AS match_count
            FROM persons
            WHERE {where_sql}
          ) AS hits
        ) AS scored
        ORDER BY {order_sql}
        LIMIT ?
    """
    # Placeholders are bound in textual order: the score expression is selected
    # before the WHERE clause, and LIMIT is last.
    return sql, [*score_params, *params, limit]


def _pack_rows(raw_rows: list[dict]) -> dict:
    matches = int(raw_rows[0]["match_count"]) if raw_rows else 0
    rows = []
    for row in raw_rows:
        item = dict(row)
        item.pop("match_count", None)
        item.pop("search_blob", None)
        item.pop("name_key", None)
        item.pop("mobile_key", None)
        if item.get("score") is not None:
            item["score"] = int(item["score"])
        rows.append(item)
    return {"rows": rows, "matches": matches, "shown": len(rows)}
