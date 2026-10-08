"""Bounded private browser profiles, lifecycle admissions and exact action receipts.

Uses the computer's private store and shared capacity reservation. Never exposed
to page/terminal processes or public replay, and never replaces app Postgres.
"""
import io
import json
import tarfile

from .browser_state import _validate
from .executor_state import (ExecutorError, ExecutorUncertain, SnapshotStore, canonical_archive,
    MAX_BROWSER_STATE, MAX_BROWSER_EVIDENCE, MAX_RESULT, BROWSER_RESERVATION)

EMPTY = {"storage": {"cookies": [], "origins": []}, "input_tainted": False, "last_url": ""}


def encoded_profile(state):
    value = json.dumps(_validate(state), ensure_ascii=False)
    if len(value.encode()) > MAX_BROWSER_STATE:
        raise ExecutorError("The private browser profile exceeds its bound.")
    return value


def with_screenshot(snapshot, name, data):
    """Merge a validated screenshot into an archive; no host extraction."""
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as target:
        if snapshot:
            with tarfile.open(fileobj=io.BytesIO(canonical_archive(snapshot)), mode="r:") as source:
                for item in source:
                    if item.name == name:
                        continue
                    target.addfile(item, source.extractfile(item) if item.isfile() else None)
        item = tarfile.TarInfo(name)
        item.size = len(data)
        target.addfile(item, io.BytesIO(data))
    return canonical_archive(output.getvalue())


class BrowserStore:
    def __init__(self, store: SnapshotStore):
        self.store = store

    def profile(self, scope):
        with self.store.connect() as db:
            row = db.execute("SELECT state FROM browser_profiles WHERE scope=?", (scope,)).fetchone()
            return _validate(json.loads(row[0])) if row else json.loads(json.dumps(EMPTY))

    def session(self, scope):
        with self.store.connect() as db:
            row = db.execute("SELECT * FROM browser_sessions WHERE scope=?", (scope,)).fetchone()
            return dict(row) if row and row["phase"] != "closed" else None

    def admit_session(self, scope, run, operation, name, daemon):
        with self.store.connect() as db:
            action = db.execute("SELECT phase FROM browser_actions WHERE scope=? AND run=? AND operation=?", (scope, run, operation)).fetchone()
            if not action or action[0] != "pending":
                raise ExecutorUncertain("Browser action was cancelled before container admission.")
            row = db.execute("SELECT phase FROM browser_sessions WHERE scope=?", (scope,)).fetchone()
            if row and row[0] != "closed":
                raise ExecutorUncertain("An existing browser still requires confirmed cleanup.")
            self.store.ensure_scope(db, scope)
            db.execute("INSERT INTO browser_sessions VALUES (?,?,?,?,NULL,'creating') ON CONFLICT(scope) DO UPDATE SET run=excluded.run,name=excluded.name,daemon=excluded.daemon,container=NULL,phase='creating'",
                       (scope, run, name, daemon))

    def created(self, scope, run, identity):
        with self.store.connect() as db:
            changed = db.execute("UPDATE browser_sessions SET container=?,phase='running' WHERE scope=? AND run=? AND phase='creating'", (identity, scope, run))
            if changed.rowcount != 1:
                raise ExecutorUncertain("Browser admission lost ownership before dispatch.")

    def receipt(self, scope, run, operation, request):
        with self.store.connect() as db:
            row = db.execute("SELECT * FROM browser_actions WHERE scope=? AND operation=?", (scope, operation)).fetchone()
            if row:
                if row["run"] != run or row["request"] != request:
                    raise ExecutorError("Browser receipt ownership or arguments do not match.")
                if row["phase"] == "done":
                    return json.loads(row["result"])
            return None

    def evidence(self, scope, run, operation):
        with self.store.connect() as db:
            row = db.execute("SELECT evidence FROM browser_actions WHERE scope=? AND run=? AND operation=? AND phase='done'", (scope, run, operation)).fetchone()
            return json.loads(row[0]) if row and row[0] else None

    def admit_action(self, scope, run, operation, request, *, taint=False):
        with self.store.connect() as db:
            old = db.execute("SELECT * FROM browser_actions WHERE scope=? AND operation=?", (scope, operation)).fetchone()
            if old:
                if old["run"] != run or old["request"] != request:
                    raise ExecutorError("Browser action ownership or arguments do not match.")
                if old["phase"] == "done":
                    return json.loads(old["result"])
                raise ExecutorUncertain("An uncertain browser action will not be repeated.")
            owner = db.execute("SELECT run FROM browser_sessions WHERE scope=? AND phase!='closed'", (scope,)).fetchone()
            if owner and owner[0] != run:
                raise ExecutorUncertain("A different run still owns this conversation browser.")
            if (db.execute("SELECT 1 FROM browser_actions WHERE scope=? AND phase='pending'", (scope,)).fetchone()
                    or db.execute("SELECT 1 FROM operations WHERE scope=? AND phase IN ('creating','running')", (scope,)).fetchone()):
                raise ExecutorUncertain("A previous conversation action still requires confirmed cleanup.")
            self.store.capacity(db, BROWSER_RESERVATION)
            self.store.ensure_scope(db, scope)
            if taint:
                row = db.execute("SELECT state FROM browser_profiles WHERE scope=?", (scope,)).fetchone()
                state = json.loads(row[0]) if row else json.loads(json.dumps(EMPTY))
                state["input_tainted"] = True
                db.execute("INSERT INTO browser_profiles VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET state=excluded.state", (scope, encoded_profile(state)))
            db.execute("INSERT INTO browser_actions VALUES (?,?,?,?,'pending',NULL,NULL)", (scope, operation, run, request))
            return None

    def finish(self, scope, run, operation, result, *, profile=None, evidence=None, screenshot=None):
        result_json = json.dumps(result, ensure_ascii=False)
        evidence_json = json.dumps(evidence, ensure_ascii=False) if evidence else None
        if len(result_json.encode()) > MAX_RESULT or evidence_json and len(evidence_json.encode()) > MAX_BROWSER_EVIDENCE:
            raise ExecutorError("The browser result exceeds its persistence bound.")
        profile_json = encoded_profile(profile) if profile is not None else None
        with self.store.connect() as db:
            row = db.execute("SELECT phase FROM browser_actions WHERE scope=? AND run=? AND operation=?", (scope, run, operation)).fetchone()
            if not row or row[0] != "pending":
                raise ExecutorUncertain("Browser completion lost ownership to cancellation.")
            if screenshot:
                if db.execute("SELECT 1 FROM operations WHERE scope=? AND phase IN ('creating','running')", (scope,)).fetchone():
                    raise ExecutorUncertain("A terminal action owns the conversation files.")
                old = db.execute("SELECT snapshot FROM workspaces WHERE scope=?", (scope,)).fetchone()
                merged = with_screenshot(bytes(old[0]) if old else b"", *screenshot)
                db.execute("UPDATE workspaces SET snapshot=? WHERE scope=?", (merged, scope))
            if profile_json is not None:
                db.execute("INSERT INTO browser_profiles VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET state=excluded.state", (scope, profile_json))
            db.execute("UPDATE browser_actions SET phase='done',result=?,evidence=? WHERE scope=? AND run=? AND operation=?", (result_json, evidence_json, scope, run, operation))

    def closed(self, scope, run, *, cancel_actions=True):
        with self.store.connect() as db:
            db.execute("UPDATE browser_sessions SET phase='closed' WHERE scope=? AND run=?", (scope, run))
            if cancel_actions:
                db.execute("UPDATE browser_actions SET phase='cancelled' WHERE scope=? AND run=? AND phase='pending'", (scope, run))
