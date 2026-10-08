"""Offline evidence that compatibility names do not hide a Hermes engine."""
import ast
from pathlib import Path
import subprocess
import sys
import tomllib
import unittest


class OwnedRuntimeDependencyTests(unittest.TestCase):
    def test_service_imports_with_upstream_runtime_imports_forbidden(self):
        source = Path(__file__).resolve().parents[1] / "src"
        program = """
import importlib.abc, sys
sys.path.insert(0, sys.argv[1])
class BlockUpstream(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split('.')[0] in {'hermes_agent','hermes_cli','agui_adapter','tools','model_tools','run_agent'}:
            raise AssertionError('upstream runtime import attempted: ' + fullname)
sys.meta_path.insert(0, BlockUpstream())
import hermes_chat.service, hermes_chat.runtime, hermes_chat.sandbox, hermes_chat.retrieval, hermes_chat.artifact_publish
"""
        completed = subprocess.run([sys.executable, "-I", "-c", program, str(source)],
                                   capture_output=True, text=True, timeout=15)
        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_source_dependency_and_install_graph_has_no_upstream_engine(self):
        service = Path(__file__).resolve().parents[1]
        forbidden = {"hermes_agent", "hermes_cli", "agui_adapter", "tools", "model_tools", "run_agent"}
        for path in (service / "src" / "hermes_chat").glob("*.py"):
            tree = ast.parse(path.read_text())
            for node in ast.walk(tree):
                roots = [name.name.split(".")[0] for name in node.names] if isinstance(node, ast.Import) else (
                    [node.module.split(".")[0]] if isinstance(node, ast.ImportFrom) and node.module and not node.level else [])
                self.assertFalse(forbidden.intersection(roots), f"{path.name}: {roots}")
        package = (service / "pyproject.toml").read_text()
        installer = (service / "scripts" / "install-runtime.sh").read_text()
        self.assertNotIn('hermes_agent.plugins', package)
        self.assertNotIn('agui_adapter', installer)
        self.assertNotIn('EXPECTED_HERMES_COMMIT', installer)
        self.assertIn('newscraft-agent = "hermes_chat.service:main"', package)

    def test_locked_install_uses_the_audited_worker_interpreter_without_downloading_one(self):
        service = Path(__file__).resolve().parents[1]
        project = tomllib.loads((service / "pyproject.toml").read_text())
        lock = tomllib.loads((service / "uv.lock").read_text())
        self.assertEqual(project["project"]["requires-python"], ">=3.11,<3.12")
        self.assertEqual(lock["requires-python"], ">=3.11, <3.12")
        installer = (service / "scripts" / "install-runtime.sh").read_text()
        self.assertIn("--python cpython@3.11 --no-python-downloads", installer)


if __name__ == "__main__":
    unittest.main()
