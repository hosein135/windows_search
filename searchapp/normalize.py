"""Query-side normalization.

The same folding rules are applied in SQL when DuckDB reads each CSV, so a
search string and a stored cell compare equal after Arabic/Persian variants
and digit alphabets are folded.
"""

from __future__ import annotations

import re

PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹"
ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩"
_DIGIT_TRANS = str.maketrans(
    {ch: str(i) for i, ch in enumerate(PERSIAN_DIGITS)}
    | {ch: str(i) for i, ch in enumerate(ARABIC_DIGITS)}
)

PLACEHOLDERS = frozenset({
    "", "-", "--", "—", ".", "..",
    "null", "none", "nan", "n/a", "na", "nil",
})

_FLOAT_SUFFIX = re.compile(r"^(\d+)\.0+$")


def collapse_whitespace(value: str) -> str:
    text = value.replace("\t", " ").replace("\u00a0", " ").replace("\ufeff", " ")
    return re.sub(r" {2,}", " ", text).strip()


def normalize_digits(value: str) -> str:
    return value.translate(_DIGIT_TRANS)


def normalize_persian(value: str) -> str:
    return value.replace("ي", "ی").replace("ك", "ک").replace("ـ", "")


def strip_float_suffix(value: str) -> str:
    match = _FLOAT_SUFFIX.match(value)
    return match.group(1) if match else value


def clean_text(value) -> str | None:
    """Display text: drop placeholders, fold Arabic ي/ك, collapse whitespace."""
    if value is None:
        return None
    text = collapse_whitespace(str(value))
    if text.lower() in PLACEHOLDERS:
        return None
    text = collapse_whitespace(normalize_persian(text))
    return text or None


def clean_id(value) -> str | None:
    """IDs, cards, accounts: digit-fold and turn spreadsheet '3046.0' into '3046'."""
    text = clean_text(value)
    if text is None:
        return None
    return strip_float_suffix(normalize_digits(text))


def clean_phone(value) -> str | None:
    """Phones: digits only. All-zero and placeholder cells become empty."""
    text = clean_text(value)
    if text is None:
        return None
    digits = re.sub(r"\D", "", normalize_digits(text))
    if not digits or re.fullmatch(r"0+", digits):
        return None
    return digits


def search_norm(value) -> str | None:
    """Folded, lowercased copy used for name token search."""
    if value is None:
        return None
    text = collapse_whitespace(normalize_digits(normalize_persian(str(value)))).lower()
    return text or None


def mobile_forms(value: str) -> list[str]:
    """09xxxxxxxxx and 9xxxxxxxxx refer to the same mobile."""
    digits = re.sub(r"\D", "", value)
    forms = {digits} if digits else set()
    if re.fullmatch(r"0\d+", digits or ""):
        stripped = digits.lstrip("0")
        if stripped:
            forms.add(stripped)
    if re.fullmatch(r"9\d{9}", digits or ""):
        forms.add("0" + digits)
    return sorted(forms)


def classify_query(raw: str) -> dict:
    """Detect national code, mobile, card, any id, or a name.

    10 digits              -> national code (exact)
    10 digits starting 9   -> mobile or national code (telco dumps omit the leading 0)
    11 digits starting 09  -> mobile (exact)
    16 digits              -> payment card (exact)
    other digit run of 4+  -> any id column
    otherwise              -> name tokens (every token must match)
    """
    text = collapse_whitespace(str(raw or ""))
    if not text:
        return {"type": "empty"}

    compact = re.sub(r"[\s\-]", "", normalize_digits(text))
    compact = strip_float_suffix(compact)
    if re.fullmatch(r"\d+", compact or ""):
        if re.fullmatch(r"\d{10}", compact):
            if compact.startswith("9"):
                return {"type": "mobile_or_national", "value": "0" + compact}
            return {"type": "national_code", "value": compact}
        if re.fullmatch(r"09\d{9}", compact):
            return {"type": "mobile", "value": compact}
        if re.fullmatch(r"\d{16}", compact):
            return {"type": "card", "value": compact}
        if re.fullmatch(r"\d{4,}", compact):
            return {"type": "any_id", "value": compact}
        return {"type": "empty"}

    norm = search_norm(text)
    tokens = [token for token in (norm or "").split(" ") if token]
    if not tokens:
        return {"type": "empty"}
    return {"type": "name", "tokens": tokens, "value": norm}


QUERY_LABELS = {
    "empty": "empty",
    "national_code": "national code",
    "mobile": "mobile",
    "mobile_or_national": "mobile or national code",
    "card": "card",
    "any_id": "id",
    "name": "name",
    "browse": "file",
}
