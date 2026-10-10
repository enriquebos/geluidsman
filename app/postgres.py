from __future__ import annotations

import json
import re
from pathlib import Path
from typing import TYPE_CHECKING, Self

import psycopg
from psycopg.rows import dict_row

if TYPE_CHECKING:
    from collections.abc import Sequence

    from app.types import SQLParameters


class Cursor:
    def __init__(self, cursor: psycopg.Cursor, lastrowid: int | None = None) -> None:
        self.cursor, self.lastrowid = cursor, lastrowid

    def fetchall(self) -> list[dict]:
        return [
            {key: json.dumps(value) if isinstance(value, (dict, list)) else value for key, value in row.items()}
            for row in self.cursor.fetchall()
        ]


class Connection:
    def __init__(self, url: str) -> None:
        self.raw = psycopg.connect(url, autocommit=True, row_factory=dict_row)
        self.transactions = []

    def __enter__(self) -> Self:
        transaction = self.raw.transaction()
        transaction.__enter__()
        self.transactions.append(transaction)
        return self

    def __exit__(self, *args: object) -> None:
        self.transactions.pop().__exit__(*args)

    def execute(self, query: str, args: SQLParameters = ()) -> Cursor:
        values = list(args)
        query = re.sub(r'(?<![\w"])end(?![\w"])', '"end"', query)
        query = re.sub(r"(\w+(?:\.\w+)?) COLLATE NOCASE", r"lower(\1)", query)
        query = query.replace("instr(", "strpos(")
        query = query.replace(
            "caption_search MATCH ?", "caption_search.search_vector @@ phraseto_tsquery('simple',public.unaccent(?))"
        )
        query = query.replace("? IS NULL", "CAST(? AS TEXT) IS NULL")
        if query.startswith("INSERT OR IGNORE"):
            query = query.replace("INSERT OR IGNORE", "INSERT", 1) + " ON CONFLICT DO NOTHING"
        if query.startswith("INSERT OR REPLACE INTO settings"):
            query = (
                query.replace("INSERT OR REPLACE", "INSERT", 1) + " ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value"
            )
        generated = bool(re.match(r"INSERT INTO (audit|caption_cues|channel_items)\b", query))
        if generated:
            query += " RETURNING id"
        if values:
            query = query.replace("%", "%%").replace("?", "%s")
        cursor = self.raw.execute(query, values or None)
        inserted = cursor.fetchone() if generated else None
        return Cursor(cursor, inserted["id"] if inserted else None)

    def executemany(self, query: str, values: Sequence[SQLParameters]) -> None:
        query = re.sub(r'(?<![\w"])end(?![\w"])', '"end"', query)
        if query.startswith("INSERT OR IGNORE"):
            query = query.replace("INSERT OR IGNORE", "INSERT", 1) + " ON CONFLICT DO NOTHING"
        query = query.replace("%", "%%").replace("?", "%s")
        with self.raw.cursor() as cursor:
            cursor.executemany(query, values)

    def executescript(self, query: str) -> None:
        self.raw.execute(query)

    def initialize(self) -> None:
        self.executescript(Path(__file__).with_name("schema.sql").read_text(encoding="utf-8"))
        self.raw.execute("SET pg_trgm.word_similarity_threshold=0.3")

    def close(self) -> None:
        self.raw.close()
