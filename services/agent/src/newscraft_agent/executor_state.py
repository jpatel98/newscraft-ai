"""Private, bounded computer snapshots; never a replacement for app Postgres.

Only validated regular-file archives are stored. Nothing is extracted onto the
host. Pending admission survives worker death so an uncertain action is never
silently rerun. SQLite serializes local workers sharing this executor store.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import sqlite3
import stat
import tarfile

from .isolation import _ensure_private_directory, _private_root

MAX_FILE = 1024 * 1024
MAX_FILES = 256
MAX_WORKSPACE = 4 * 1024 * 1024
MAX_ARCHIVE = 8 * 1024 * 1024
MAX_RESULT = 96 * 1024
MAX_STORE = 64 * 1024 * 1024
MAX_WORKSPACES = 128
MAX_OPERATIONS = 4096
MAX_BROWSER_STATE = 1024 * 1024
MAX_BROWSER_EVIDENCE = 256 * 1024
BROWSER_RESERVATION = MAX_ARCHIVE + MAX_RESULT + MAX_BROWSER_STATE + MAX_BROWSER_EVIDENCE


class ExecutorError(RuntimeError):
    runtime_failure = True


class ExecutorUncertain(ExecutorError):
    recovery_pending = True


def canonical_archive(data: bytes, *, container_export: bool = False) -> bytes:
    """Validate an uncompressed archive and rebuild it without unsafe metadata."""
    if len(data) > MAX_ARCHIVE:
        raise ExecutorError("Computer files exceed their snapshot limit.")
    if not data:
        return b""
    entries, seen, total = [], set(), 0
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as archive:
            for item in archive:
                name = item.name.removeprefix("./").rstrip("/")
                if container_export:
                    if name == "workspace" and item.isdir():
                        continue
                    if not name.startswith("workspace/"):
                        raise ValueError("unexpected archive root")
                    name = name[len("workspace/"):]
                if name in {"", "."} and item.isdir():
                    continue
                parts = name.split("/")
                if (len(name.encode()) > 512 or len(parts) > 16 or "\\" in name
                        or any(p in {"", ".", ".."} for p in parts)
                        or any(ord(c) < 32 for c in name) or PurePosixPath(name).is_absolute()
                        or name in seen or len(seen) >= MAX_FILES):
                    raise ValueError("unsafe path")
                if not (item.isfile() or item.isdir()) or item.sparse or any(k.startswith("GNU.sparse") for k in item.pax_headers):
                    raise ValueError("only ordinary files and directories persist")
                if item.size < 0 or item.size > MAX_FILE or (item.isdir() and item.size):
                    raise ValueError("file limit")
                total += item.size
                if total > MAX_WORKSPACE:
                    raise ValueError("workspace limit")
                seen.add(name)
                stream = archive.extractfile(item) if item.isfile() else None
                content = stream.read(MAX_FILE + 1) if stream else b""
                if len(content) != item.size:
                    raise ValueError("incomplete file")
                entries.append((name, item.isdir(), content))
        # Reject file/directory collisions regardless of the archive's ordering.
        files = {name for name, directory, _ in entries if not directory}
        if any(any("/".join(name.split("/")[:i]) in files for i in range(1, len(name.split("/"))))
               for name, _, _ in entries):
            raise ValueError("path collision")
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w", format=tarfile.USTAR_FORMAT) as archive:
            for name, directory, content in sorted(entries):
                item = tarfile.TarInfo(name)
                item.uid = item.gid = 1000
                item.mode = 0o700 if directory else 0o600
                item.type = tarfile.DIRTYPE if directory else tarfile.REGTYPE
                item.size = len(content)
                archive.addfile(item, None if directory else io.BytesIO(content))
        result = output.getvalue()
        if len(result) > MAX_ARCHIVE:
            raise ValueError("archive limit")
        return result
    except (tarfile.TarError, OSError, ValueError, UnicodeError):
        raise ExecutorError("Computer changes were discarded: unsafe files or a snapshot limit was reached.") from None


class SnapshotStore:
    def __init__(self, root: Path):
        self.root = _private_root(root)

    @contextlib.contextmanager
    def connect(self):
        _ensure_private_directory(self.root)
        path = self.root / "computer.sqlite3"
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise ExecutorError("The computer state store must be private and owned by the worker.")
        finally:
            os.close(fd)
        db = sqlite3.connect(path, timeout=2)
        db.row_factory = sqlite3.Row
        try:
            # Bounded database plus at most one bounded DELETE-mode journal.
            db.execute("PRAGMA journal_mode=DELETE")
            db.execute("PRAGMA synchronous=FULL")
            if db.execute("PRAGMA page_size").fetchone()[0] != 4096:
                raise ExecutorError("The computer state store has an unsupported page size.")
            db.execute("PRAGMA max_page_count=32768")  # <=128 MiB at default 4 KiB pages.
            db.execute("CREATE TABLE IF NOT EXISTS workspaces (scope TEXT PRIMARY KEY, snapshot BLOB NOT NULL)")
            db.execute("""CREATE TABLE IF NOT EXISTS operations (
                scope TEXT NOT NULL, operation TEXT NOT NULL, run TEXT NOT NULL,
                name TEXT NOT NULL, daemon TEXT NOT NULL, request TEXT NOT NULL, container TEXT, phase TEXT NOT NULL, result TEXT,
                PRIMARY KEY (scope, operation))""")
            db.execute("CREATE TABLE IF NOT EXISTS browser_profiles (scope TEXT PRIMARY KEY, state TEXT NOT NULL)")
            db.execute("""CREATE TABLE IF NOT EXISTS browser_sessions (
                scope TEXT PRIMARY KEY, run TEXT NOT NULL, name TEXT NOT NULL, daemon TEXT NOT NULL,
                container TEXT, phase TEXT NOT NULL)""")
            db.execute("""CREATE TABLE IF NOT EXISTS browser_actions (
                scope TEXT NOT NULL, operation TEXT NOT NULL, run TEXT NOT NULL, request TEXT NOT NULL,
                phase TEXT NOT NULL, result TEXT, evidence TEXT, PRIMARY KEY(scope, operation))""")
            db.commit()
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except sqlite3.Error:
            db.rollback()
            raise ExecutorError("The bounded computer state store is unavailable or full.") from None
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def admit(self, scope, run, operation, name, daemon, request):
        with self.connect() as db:
            old = db.execute("SELECT * FROM operations WHERE scope=? AND operation=?", (scope, operation)).fetchone()
            if old:
                if old["run"] != run or old["request"] != request:
                    raise ExecutorError("Computer operation ownership or request does not match.")
                if old["phase"] == "done":
                    return {"receipt": json.loads(old["result"])}
                raise ExecutorUncertain("This computer action has an uncertain or cancelled outcome and cannot be repeated.")
            if db.execute("SELECT 1 FROM operations WHERE scope=? AND phase IN ('creating','running')", (scope,)).fetchone():
                raise ExecutorUncertain("A previous computer action still needs confirmed cleanup.")
            if db.execute("SELECT 1 FROM browser_actions WHERE scope=? AND phase='pending'", (scope,)).fetchone():
                raise ExecutorUncertain("A browser action still owns this conversation workspace.")
            self.capacity(db, MAX_ARCHIVE + MAX_RESULT)
            existing = db.execute("SELECT snapshot FROM workspaces WHERE scope=?", (scope,)).fetchone()
            self.ensure_scope(db, scope)
            db.execute("INSERT INTO operations VALUES (?,?,?,?,?,?,NULL,'creating',NULL)", (scope, operation, run, name, daemon, request))
            return {"snapshot": bytes(existing[0]) if existing else b""}

    @staticmethod
    def ensure_scope(db, scope):
        if not db.execute("SELECT 1 FROM workspaces WHERE scope=?", (scope,)).fetchone():
            if db.execute("SELECT count(*) FROM workspaces").fetchone()[0] >= MAX_WORKSPACES:
                raise ExecutorError("The computer workspace limit was reached.")
            db.execute("INSERT INTO workspaces VALUES (?,?)", (scope, b""))

    @staticmethod
    def capacity(db, reserve):
        count = db.execute("SELECT (SELECT count(*) FROM operations) + (SELECT count(*) FROM browser_actions)").fetchone()[0]
        used = db.execute("SELECT coalesce(sum(length(snapshot)),0) FROM workspaces").fetchone()[0]
        used += db.execute("SELECT coalesce(sum(length(CAST(result AS BLOB))),0) FROM operations").fetchone()[0]
        used += db.execute("SELECT coalesce(sum(length(CAST(state AS BLOB))),0) FROM browser_profiles").fetchone()[0]
        used += db.execute("SELECT coalesce(sum(length(CAST(result AS BLOB))),0)+coalesce(sum(length(CAST(evidence AS BLOB))),0) FROM browser_actions").fetchone()[0]
        pending = db.execute("SELECT count(*) FROM operations WHERE phase IN ('creating','running')").fetchone()[0]
        browser_pending = db.execute("SELECT count(*) FROM browser_actions WHERE phase='pending'").fetchone()[0]
        if count >= MAX_OPERATIONS or used + pending * (MAX_ARCHIVE + MAX_RESULT) + browser_pending * BROWSER_RESERVATION + reserve > MAX_STORE:
            raise ExecutorError("The computer store has reached its capacity; operator retention is required.")

    def receipt(self, scope, run, operation, request):
        with self.connect() as db:
            row = db.execute("SELECT * FROM operations WHERE scope=? AND operation=?", (scope, operation)).fetchone()
            if row is None:
                return None
            if row["run"] != run or row["request"] != request:
                raise ExecutorError("Computer receipt ownership or request does not match.")
            return json.loads(row["result"]) if row["phase"] == "done" else None

    def created(self, scope, operation, container):
        with self.connect() as db:
            result = db.execute("UPDATE operations SET container=?, phase='running' WHERE scope=? AND operation=? AND phase='creating'",
                                (container, scope, operation))
            if result.rowcount != 1:
                raise ExecutorUncertain("Computer admission was cancelled before execution.")

    def pending(self, scope, run):
        with self.connect() as db:
            return [dict(row) for row in db.execute("SELECT * FROM operations WHERE scope=? AND run=? AND phase IN ('creating','running')", (scope, run))]

    def finish(self, scope, operation, result, snapshot=None):
        encoded = json.dumps(result, ensure_ascii=False)
        if len(encoded.encode()) > MAX_RESULT or (snapshot is not None and len(snapshot) > MAX_ARCHIVE):
            raise ExecutorError("The computer result exceeded its persistence limit.")
        with self.connect() as db:
            row = db.execute("SELECT phase FROM operations WHERE scope=? AND operation=?", (scope, operation)).fetchone()
            if not row or row[0] != "running":
                raise ExecutorUncertain("Computer completion lost ownership to cancellation.")
            if snapshot is not None:
                db.execute("UPDATE workspaces SET snapshot=? WHERE scope=?", (snapshot, scope))
            db.execute("UPDATE operations SET phase='done', result=? WHERE scope=? AND operation=?", (encoded, scope, operation))

    def cancelled(self, scope, operation):
        with self.connect() as db:
            db.execute("UPDATE operations SET phase='cancelled' WHERE scope=? AND operation=? AND phase IN ('creating','running')", (scope, operation))
