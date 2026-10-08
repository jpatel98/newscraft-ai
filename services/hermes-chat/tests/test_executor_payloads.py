"""Fixed helper programs against synthetic files/process tables, never model code."""
import io
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from hermes_chat.executor_payloads import GUARD, RESTORE, SNAPSHOT
from hermes_chat.executor_state import canonical_archive
from test_oci_executor import archive, contents


class PayloadTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.processes = self.root / "proc"
        self.processes.mkdir()
        self.output = io.BytesIO()
        self.namespace = {}
        # Define the exact helpers without dispatching them on the host.
        exec(SNAPSHOT.rsplit("\nquiesce()\nsnapshot()", 1)[0], self.namespace)
        self.namespace["Path"] = lambda value: self.workspace if value == "/workspace" else self.processes
        self.namespace["sys"] = SimpleNamespace(stdout=SimpleNamespace(buffer=self.output))

    def tearDown(self):
        self.directory.cleanup()

    def restore(self, data):
        # Only the root and stdin dependency are replaced for this fixture;
        # the validation and actual filesystem operations are unchanged.
        source = RESTORE.replace('root = Path("/workspace")', 'root = fixture_root').replace(
            'data = sys.stdin.buffer.read(8388609)', 'data = fixture_input.read(8388609)')
        exec(source, {"fixture_root": self.workspace, "fixture_input": io.BytesIO(data)})

    def test_restore_and_snapshot_round_trip_nested_markdown_csv_and_empty_directories(self):
        original = {"research/brief.md": "Confirmed [1]\n", "data/results.csv": "value\n3\n"}
        self.restore(canonical_archive(archive(original)))
        (self.workspace / "empty").mkdir()
        self.namespace["snapshot"]()
        self.assertEqual(contents(canonical_archive(self.output.getvalue())), original)

    def test_guard_checks_actual_process_cgroups_and_filesystem_limits_before_tool_code(self):
        proc = self.processes / "self"
        proc.mkdir()
        (proc / "status").write_text("Uid:\t1000\t1000\t1000\t1000\nCapEff:\t0\nCapPrm:\t0\nCapInh:\t0\nCapAmb:\t0\nCapBnd:\t0\nNoNewPrivs:\t1\nSeccomp:\t2\n")
        (proc / "mountinfo").write_text("1 0 0:1 / /workspace rw,nosuid,nodev,noexec - tmpfs tmpfs rw\n2 0 0:2 / /tmp rw,nosuid,nodev,noexec - tmpfs tmpfs rw\n")
        control = self.root / "sys/fs/cgroup"
        control.mkdir(parents=True)
        limits = {"memory.max": "268435456", "memory.swap.max": "0", "pids.max": "64", "cpu.max": "100000 100000"}
        for name, value in limits.items():
            (control / name).write_text(value)
        def execute():
            source = GUARD.replace("import os\n", "").replace("from pathlib import Path\n", "")
            exec(source, {"Path": lambda value: self.root / value.lstrip("/"),
                "os": SimpleNamespace(getuid=lambda: 1000, geteuid=lambda: 1000,
                    statvfs=lambda _: SimpleNamespace(f_blocks=2048, f_frsize=4096, f_files=512))})
        execute()
        for name, invalid in {"memory.max": "max", "memory.swap.max": "max", "pids.max": "max", "cpu.max": "max 100000"}.items():
            (control / name).write_text(invalid)
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                execute()
            (control / name).write_text(limits[name])
        (proc / "status").write_text((proc / "status").read_text().replace("CapBnd:\t0", "CapBnd:\t1"))
        with self.assertRaisesRegex(RuntimeError, "capabilities"):
            execute()

    def test_restore_rejects_traversal_before_any_file_write(self):
        with self.assertRaises(ValueError):
            self.restore(archive({"../escaped": "synthetic"}))
        self.assertFalse((self.root / "escaped").exists())

    def test_snapshot_rejects_symlinks_hardlinks_and_special_files(self):
        source = self.workspace / "source"
        source.write_text("synthetic")
        link = self.workspace / "link"
        for kind in ("symlink", "hardlink", "fifo"):
            if kind == "symlink":
                link.symlink_to(source)
            elif kind == "hardlink":
                os.link(source, link)
            else:
                os.mkfifo(link)
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                self.namespace["snapshot"]()
            link.unlink()
        self.assertEqual(self.output.getvalue(), b"")

    def test_quiesce_kills_background_children_including_new_forks_without_touching_watchdog_or_self(self):
        def process(pid, uid=1000, state="S"):
            target = self.processes / str(pid)
            target.mkdir(exist_ok=True)
            (target / "status").write_text(f"State:\t{state}\nUid:\t{uid}\t{uid}\t{uid}\t{uid}\n")
        process(1, uid=0)
        process(300)  # trusted helper
        process(101)
        process(99, state="Z")
        killed = []
        def kill(pid, sig):
            killed.append(pid)
            process(pid, state="Z")
            if pid == 101:
                process(102)  # A fork raced the first scan.
        self.namespace["os"] = SimpleNamespace(getpid=lambda: 300, kill=kill)
        self.namespace["quiesce"]()
        self.assertEqual(killed, [101, 102])
        process(500, uid=0)
        with self.assertRaisesRegex(RuntimeError, "unexpected process"):
            self.namespace["quiesce"]()

    def test_quiesce_does_not_snapshot_when_signals_cannot_stop_another_process(self):
        target = self.processes / "101"
        target.mkdir()
        (target / "status").write_text("State:\tS\nUid:\t1000\t1000\t1000\t1000\n")
        def denied(*args):
            raise PermissionError("synthetic refusal")
        self.namespace["os"] = SimpleNamespace(getpid=lambda: 300, kill=denied)
        with self.assertRaises(PermissionError):
            self.namespace["quiesce"]()
        self.assertEqual(self.output.getvalue(), b"")


if __name__ == "__main__":
    unittest.main()
