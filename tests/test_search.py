"""Search behavior over synthetic CSV layouts, plus the files in databases/."""

from __future__ import annotations

import csv
import tempfile
import threading
import unittest
from pathlib import Path

from searchapp.engine import SearchEngine
from searchapp.gui import source_choices, status_text, visible_columns
from searchapp.normalize import (
    classify_query,
    clean_id,
    clean_phone,
    clean_text,
    search_norm,
)
from searchapp.paths import DATABASES_DIR


def write_csv(path: Path, rows: list[list[str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        csv.writer(handle).writerows(rows)


class NormalizeTests(unittest.TestCase):
    def test_placeholders_and_folds(self):
        for value in ["", "  ", "null", "None", "NONE", "nan", "n/a", "-", None]:
            self.assertIsNone(clean_text(value))
        self.assertEqual(clean_text("تهران"), "تهران")
        self.assertEqual(clean_id("3046.0"), "3046")
        self.assertEqual(clean_id("287910434.0"), "287910434")
        self.assertEqual(clean_id("۱.0"), "1")
        self.assertEqual(clean_phone(" 0912-345 6789 "), "09123456789")
        self.assertEqual(clean_phone("021-66570876"), "02166570876")
        self.assertIsNone(clean_phone("-"))
        self.assertIsNone(clean_phone("000"))
        self.assertEqual(search_norm("  سيد   علي "), "سید علی")
        self.assertEqual(search_norm("۱۲۳"), "123")

    def test_query_types(self):
        self.assertEqual(classify_query("0532347226")["type"], "national_code")
        self.assertEqual(classify_query("9351000000")["type"], "mobile_or_national")
        self.assertEqual(classify_query("09120000000")["type"], "mobile")
        self.assertEqual(classify_query("0912-000-0000")["value"], "09120000000")
        self.assertEqual(classify_query("6104337846241071")["type"], "card")
        self.assertEqual(classify_query("3000.0")["type"], "any_id")
        self.assertEqual(classify_query("3000.0")["value"], "3000")
        self.assertEqual(classify_query("هادی حسن")["tokens"], ["هادی", "حسن"])
        self.assertEqual(classify_query("   ")["type"], "empty")


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        write_csv(root / "bank mellat" / "Bank Mellat DB1.csv", [
            ["NATIONAL_CODE", "ACCOUNT_NUMBER", "FULL_NAME", "FATHER_NAME", "ID_NUMBER",
             "BIRTH_DATE", "CITY_NAME", "PROVINCE_NAME", "BIRTH_CITY", "BIRTH_PROVINCE",
             "ADDRESS", "CARD_NO", "MOBILE"],
            ["0532347226", "5640913340", "هادي حسن ونديان", "حاجي علي", "1507", "1357-10-06",
             "None", "None", "اراک", "مرکزی", "ماشين سازي اراک", "6104337846241071", "09183604450"],
            ["", "", "", "", "", "", "", "", "", "", "", "", ""],
        ])
        write_csv(root / "bank melli" / "Bank Melli DB1.csv", [
            ["NATIONAL_CODE", "CARD_NO", "FULL_NAME", "BIRTH_DATE", "MOBILE"],
            ["0532347226", "6037991100000000", "هادي حسن ونديان", "1357-10-06", "09120000000"],
        ])
        write_csv(root / "bank saderat" / "Bank Saderat DB1.csv", [
            ["AccountNumber", "DefineationNumber", "FullName", "CardNumber", "Password_Hint",
             "user_email_address", "Passw", "user_phone_number", "Member", "Username",
             "DefineNum_Old", "ID_Branch"],
            ["21340568000.0", "91.0", "احمد اسدي", "3000.0", "", "", "", " 09191271000 ", "", "", "", "1.0"],
        ])
        write_csv(root / "irancell" / "935-1.csv", [
            ["MOBL_NUM_VOICE_V", "SUBS_NAME_V", "FAMILY_NAME_V", "IC_NUMBER_V",
             "CONTACT_HOME_NUM_V", "CONTACT_OFFICE_NUM_V", "ADDRESS_V", "PROVINCE_V",
             "TOWN_CITY_V", "PO_BOX_V"],
            ["9351000000", "علي", "كريمي", "1000000037", "021-66570001", "null",
             "10م ش كمالي\t\tك 15", "null", "null", "1353683434"],
        ])
        write_csv(root / "notes" / "random.csv", [
            ["name"],
            ["ZZZUNIQUE"],
        ])
        self.engine = SearchEngine(root)

    def tearDown(self):
        self.engine.close()
        self.tmp.cleanup()

    def test_sql_cleaners_match_python(self):
        samples = [
            "None", " 0912-345 6789 ", "3046.0", "علي", "۱۲۳", "null",
            "10م ش كمالي\t\tك 15", "۱.0", "000", "-", "0532347226",
        ]
        for value in samples:
            text, ident, phone = self.engine.sql_clean(value)
            self.assertEqual(text, clean_text(value), value)
            self.assertEqual(ident, clean_id(value), value)
            self.assertEqual(phone, clean_phone(value), value)

    def test_mellat_row_folds_and_drops_placeholders(self):
        result = self.engine.search("0532347226", source="mellat")
        self.assertIsNone(result["error"])
        self.assertEqual(result["matches"], 1)
        row = result["rows"][0]
        self.assertEqual(row["national_code"], "0532347226")
        self.assertEqual(row["full_name"], "هادی حسن وندیان")
        self.assertEqual(row["father_name"], "حاجی علی")
        self.assertIsNone(row["city"])
        self.assertIsNone(row["province"])
        self.assertEqual(row["birth_city"], "اراک")
        self.assertEqual(row["card"], "6104337846241071")
        self.assertEqual(row["mobile"], "09183604450")
        self.assertEqual(row["account"], "5640913340")

    def test_name_search_matches_arabic_spelling(self):
        result = self.engine.search("هادی حسن")
        names = {row["full_name"] for row in result["rows"]}
        self.assertIn("هادی حسن وندیان", names)
        self.assertGreaterEqual(result["rows"][0]["score"], result["rows"][-1]["score"])

    def test_father_name_is_searchable(self):
        result = self.engine.search("حاجی علی", source="mellat")
        self.assertEqual(result["matches"], 1)

    def test_card_mobile_and_float_ids(self):
        card = self.engine.search("6104337846241071")
        self.assertEqual(card["query"]["type"], "card")
        self.assertEqual(card["matches"], 1)
        mobile = self.engine.search("0912-000-0000")
        self.assertEqual({row["source_id"] for row in mobile["rows"]}, {"melli"})
        saderat = self.engine.search("3000")
        self.assertEqual(saderat["rows"][0]["source_id"], "saderat")
        self.assertEqual(saderat["rows"][0]["card"], "3000")
        self.assertEqual(saderat["rows"][0]["phone"], "09191271000")
        account = self.engine.search("21340568000")
        self.assertEqual(account["matches"], 1)

    def test_irancell_mobile_without_leading_zero(self):
        result = self.engine.search("09351000000")
        self.assertEqual(result["matches"], 1)
        row = result["rows"][0]
        self.assertEqual(row["full_name"], "علی کریمی")
        self.assertEqual(row["mobile"], "9351000000")
        self.assertEqual(row["phone"], "02166570001")
        self.assertEqual(row["address"], "10م ش کمالی ک 15")
        self.assertIsNone(row["city"])
        by_national = self.engine.search("1000000037")
        self.assertEqual(by_national["rows"][0]["file_name"], "935-1.csv")

    def test_headers_are_excluded_and_other_csvs_are_read(self):
        listed = self.engine.catalog()["files"]
        other = next(item for item in listed if item["name"] == "random.csv")
        self.assertFalse(other["known"])
        self.assertGreater(other["rows"], 0)
        found = self.engine.search("ZZZUNIQUE")
        self.assertEqual(found["matches"], 1)
        self.assertEqual(found["rows"][0]["file_name"], "random.csv")
        leaked = self.engine.connection.execute(
            """
            SELECT full_name FROM persons
            WHERE lower(full_name) IN ('full_name', 'accountnumber', 'subs_name_v', 'field2')
            """
        ).fetchall()
        self.assertEqual(leaked, [])

    def test_source_file_filter_and_new_csv(self):
        tagged = self.engine.search("هادی", source="mellat:Bank Mellat DB1.csv")
        self.assertTrue(tagged["rows"])
        self.assertTrue(all(row["source_id"] == "mellat" for row in tagged["rows"]))
        root = Path(self.tmp.name)
        write_csv(root / "bank mellat" / "extra.csv", [
            ["NATIONAL_CODE", "ACCOUNT_NUMBER", "FULL_NAME", "FATHER_NAME", "ID_NUMBER",
             "BIRTH_DATE", "CITY_NAME", "PROVINCE_NAME", "BIRTH_CITY", "BIRTH_PROVINCE",
             "ADDRESS", "CARD_NO", "MOBILE"],
            ["1234567890", "", "شخص منحصر", "", "", "", "", "", "", "", "", "", ""],
        ])
        found = self.engine.search("منحصر")
        self.assertEqual(found["matches"], 1)
        self.assertEqual(found["rows"][0]["file_name"], "extra.csv")


class GuiTests(unittest.TestCase):
    def test_source_choices_and_status(self):
        choices = source_choices({"files": [
            {"known": True, "source_id": "melli", "source_label": "Bank Melli", "name": "Bank Melli DB1.csv", "source_tag": "melli:Bank Melli DB1.csv"},
            {"known": False, "source_id": None, "source_label": "Unrecognized layout", "name": "random.csv", "source_tag": None},
        ]})
        self.assertEqual(choices[0], ("All CSV files", ""))
        self.assertIn(("All Bank Melli", "melli"), choices)
        self.assertIn(("Bank Melli / Bank Melli DB1.csv", "melli:Bank Melli DB1.csv"), choices)
        self.assertEqual(status_text(None), status_text({"query": {"type": "empty"}}))
        self.assertIn("No matching rows", status_text({
            "query": {"type": "name"}, "matches": 0, "shown": 0, "took_ms": 4, "files": 2, "warnings": [],
        }))
        self.assertIn("showing 50 of 170", status_text({
            "query": {"type": "name"}, "matches": 170, "shown": 50, "took_ms": 12, "files": 7, "warnings": [],
        }))
        columns = visible_columns([{"full_name": "علی", "national_code": "1", "phone": None, "source_label": "Bank Melli", "file_name": "a.csv", "score": 100}])
        keys = [key for key, _label in columns]
        self.assertIn("full_name", keys)
        self.assertNotIn("phone", keys)

    def test_window_shows_a_hit(self):
        from searchapp.gui import tk
        if tk is None:
            self.skipTest("tkinter is not installed")
        from searchapp.gui import SearchApp
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        write_csv(root / "bank melli" / "Bank Melli DB1.csv", [
            ["NATIONAL_CODE", "CARD_NO", "FULL_NAME", "BIRTH_DATE", "MOBILE"],
            ["1000185000", "6037991100000000", "فاطمه اسدي", "1360-06-15", "09159595000"],
        ])
        engine = SearchEngine(root)
        self.addCleanup(engine.close)
        app = SearchApp(engine)
        self.addCleanup(app.root.destroy)
        app.root.withdraw()
        app.refresh_catalog()
        app.query_var.set("1000185000")
        app.source.current(1)
        app.on_search()
        self.assertFalse(app._searching)
        self.assertEqual(app.search_btn.cget("text"), "Search")
        self.assertGreaterEqual(len(app.results.get_children()), 1)
        item = app.results.get_children()[0]
        values = app.results.item(item, "values")
        self.assertIn("1000185000", values)
        self.assertIn("فاطمه اسدی", values)
        self.assertIn("Bank Melli", values)
        self.assertEqual(len(app.files.get_children()), 1)
        app._searching = True
        app.on_search()
        self.assertEqual(app.results.item(app.results.get_children()[0], "values"), values)
        app._searching = False

    def test_background_search_shows_rows(self):
        from searchapp.gui import tk
        if tk is None:
            self.skipTest("tkinter is not installed")
        from searchapp.gui import SearchApp
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        write_csv(root / "bank melli" / "Bank Melli DB1.csv", [
            ["NATIONAL_CODE", "CARD_NO", "FULL_NAME", "BIRTH_DATE", "MOBILE"],
            ["1000185000", "6037991100000000", "فاطمه اسدي", "1360-06-15", "09159595000"],
        ])
        engine = SearchEngine(root)
        self.addCleanup(engine.close)
        app = SearchApp(engine)
        self.addCleanup(app.root.destroy)
        app.root.withdraw()
        app._worker = threading.Thread(target=app._worker_loop, daemon=True)
        app._worker.start()
        app._jobs.put(("catalog",))
        app._poll()
        app.query_var.set("1000185000")
        app.on_search()
        self.assertTrue(app._searching)
        app.on_search()
        app.root.after(8000, app.root.quit)
        app.root.mainloop()
        self.assertFalse(app._searching)
        self.assertEqual(app.search_btn.cget("text"), "Search")
        values = app.results.item(app.results.get_children()[0], "values")
        self.assertIn("1000185000", values)


class RepoDataTests(unittest.TestCase):
    def setUp(self):
        mellat = DATABASES_DIR / "bank mellat" / "Bank Mellat DB1.csv"
        if not mellat.is_file():
            self.skipTest("databases/ is empty")
        self.engine = SearchEngine(DATABASES_DIR)

    def tearDown(self):
        self.engine.close()

    def test_repo_csvs_are_searchable(self):
        catalog = self.engine.catalog()
        known = [item for item in catalog["files"] if item["known"]]
        self.assertGreaterEqual(len(known), 4)
        self.assertEqual(catalog["warnings"], [])
        self.assertTrue(all(item["rows"] > 0 for item in catalog["files"]))
        result = self.engine.search("1000000000")
        self.assertIsNone(result["error"])
        self.assertGreaterEqual(result["matches"], 1)
        self.assertTrue(all(row["national_code"] == "1000000000" for row in result["rows"]))
        self.assertTrue(all(row.get("city") != "None" for row in result["rows"]))
        folded = self.engine.search("اسدی")
        self.assertGreater(folded["matches"], 0)
        for row in folded["rows"]:
            name = row.get("full_name") or ""
            self.assertNotIn("ي", name)
            self.assertNotIn("ك", name)


if __name__ == "__main__":
    unittest.main()
