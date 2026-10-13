"""Project locations. CSV files stay in databases/ and are read in place."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATABASES_DIR = ROOT / "databases"
