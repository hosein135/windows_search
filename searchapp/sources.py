"""CSV layouts.

Column order is stable per source, including files whose header names are
generic (Field1…) or corrupted. Mapping is positional. Cells mapped to None
are ignored.
"""

from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class Source:
    id: str
    label: str
    # Positional targets. None drops that column.
    columns: tuple[str | None, ...]
    header_pattern: str

    def match(self, directory: str, filename: str) -> bool:
        raise NotImplementedError


class _Mellat(Source):
    def match(self, directory: str, filename: str) -> bool:
        blob = f"{directory} {filename}".lower()
        return "mellat" in blob


class _Melli(Source):
    def match(self, directory: str, filename: str) -> bool:
        blob = f"{directory} {filename}".lower()
        return "melli" in blob


class _Saderat(Source):
    def match(self, directory: str, filename: str) -> bool:
        blob = f"{directory} {filename}".lower()
        return "saderat" in blob


class _Irancell(Source):
    def match(self, directory: str, filename: str) -> bool:
        blob = f"{directory} {filename}".lower()
        return "irancell" in blob or re.search(r"\d{3}-\d", filename) is not None


MELLAT = _Mellat(
    id="mellat",
    label="Bank Mellat",
    # NATIONAL_CODE, ACCOUNT_NUMBER, FULL_NAME, FATHER_NAME, ID_NUMBER,
    # BIRTH_DATE, CITY_NAME, PROVINCE_NAME, BIRTH_CITY, BIRTH_PROVINCE,
    # ADDRESS, CARD_NO, MOBILE
    columns=(
        "national_code", "account", "full_name", "father_name", "id_number",
        "birth_date", "city", "province", "birth_city", "birth_province",
        "address", "card", "mobile",
    ),
    header_pattern=r"national_?code",
)

MELLI = _Melli(
    id="melli",
    label="Bank Melli",
    # NATIONAL_CODE, CARD_NO, FULL_NAME, BIRTH_DATE, MOBILE
    columns=("national_code", "card", "full_name", "birth_date", "mobile"),
    header_pattern=r"national_?code",
)

SADERAT = _Saderat(
    id="saderat",
    label="Bank Saderat",
    # AccountNumber, DefineationNumber, FullName, CardNumber, Password_Hint,
    # user_email_address, Passw, user_phone_number, Member, Username,
    # DefineNum_Old, ID_Branch
    # Password hint, password, member, and username are empty in these dumps.
    columns=(
        "account", "define_number", "full_name", "card", None,
        "email", None, "phone", None, None,
        "define_num_old", "branch",
    ),
    header_pattern=r"accountnumber",
)

IRANCELL = _Irancell(
    id="irancell",
    label="Irancell",
    # MOBL_NUM_VOICE_V, SUBS_NAME_V, FAMILY_NAME_V, IC_NUMBER_V,
    # CONTACT_HOME_NUM_V, CONTACT_OFFICE_NUM_V, ADDRESS_V, PROVINCE_V,
    # TOWN_CITY_V, PO_BOX_V, optional Field15, Field16
    # Office phone and the extra Field columns are empty in these dumps.
    columns=(
        "mobile", "first_name", "last_name", "national_code", "phone",
        None, "address", "province", "city", "po_box", None, None,
    ),
    header_pattern=r"mobl_num_voice_v|field1",
)

SOURCES: tuple[Source, ...] = (MELLAT, MELLI, SADERAT, IRANCELL)

TEXT_FIELDS = frozenset({
    "full_name", "first_name", "last_name", "father_name",
    "birth_date", "city", "province", "birth_city", "birth_province",
    "address", "po_box", "email",
})
ID_FIELDS = frozenset({
    "national_code", "id_number", "account", "card",
    "define_number", "define_num_old", "branch",
})
PHONE_FIELDS = frozenset({"mobile", "phone"})

# Columns the search page shows, in table order.
DISPLAY_FIELDS = (
    ("full_name", "Full name"),
    ("father_name", "Father name"),
    ("national_code", "National code"),
    ("birth_date", "Birth date"),
    ("mobile", "Mobile"),
    ("phone", "Phone"),
    ("card", "Card"),
    ("account", "Account"),
    ("city", "City"),
    ("province", "Province"),
    ("birth_city", "Birth city"),
    ("birth_province", "Birth province"),
    ("address", "Address"),
    ("source_label", "Source"),
    ("file_name", "File"),
)


def resolve_source(directory: str, filename: str) -> Source | None:
    for source in SOURCES:
        try:
            if source.match(directory, filename):
                return source
        except Exception:
            continue
    return None
