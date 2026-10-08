from __future__ import annotations

import errno
import os
import socket
import stat
import struct
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, call, patch

from hermes_chat import docker_boundary as boundary


def info(mode, *, uid=0, gid=0, device=1, inode=1, change=1):
    return SimpleNamespace(st_mode=mode, st_uid=uid, st_gid=gid,
                           st_dev=device, st_ino=inode, st_ctime_ns=change)


class DockerBoundaryTests(unittest.TestCase):
    def fixture(self, *, socket_info=None, executable_info=None, peer_info=None,
                ours=None, theirs=None, credentials=None, readlink=None,
                second_socket=None, second_executable=None, opened=None, peer_root=None):
        sock = socket_info or info(stat.S_IFSOCK | 0o660, gid=999, inode=100)
        executable = executable_info or info(stat.S_IFREG | 0o755, inode=200)
        namespace = info(stat.S_IFREG | 0o444, device=4, inode=300)
        client = Mock()
        client.getsockopt.return_value = credentials if credentials is not None else struct.pack("3i", 1234, 0, 0)
        counts = {"docker.sock": 0, "dockerd": 0}

        def file_stat(path, **kwargs):
            if path in counts:
                counts[path] += 1
                if path == "docker.sock":
                    self.assertEqual(kwargs, {"dir_fd": 20, "follow_symlinks": False})
                    return second_socket if counts[path] > 1 and second_socket is not None else sock
                self.assertEqual(kwargs, {"dir_fd": 21, "follow_symlinks": False})
                return second_executable if counts[path] > 1 and second_executable is not None else executable
            if path == "/proc/1234/exe":
                return peer_info if peer_info is not None else executable
            if path == "/proc/self/ns/mnt":
                return ours if ours is not None else namespace
            if path == "/proc/1234/ns/mnt":
                return theirs if theirs is not None else namespace
            if path == "/proc/self/root":
                return info(stat.S_IFDIR | 0o755, device=10, inode=400)
            if path == "/proc/1234/root":
                return peer_root if peer_root is not None else info(stat.S_IFDIR | 0o755, device=10, inode=400)
            raise AssertionError(f"Unexpected stat: {path}")

        stack = ExitStack()
        stack.enter_context(patch.object(boundary.platform, "system", return_value="Linux"))
        stack.enter_context(patch.dict(os.environ, {
            "NEWSCRAFT_DOCKER_SOCKET": "/run/docker.sock",
            "NEWSCRAFT_DOCKER_DAEMON_EXECUTABLE": "/usr/bin/dockerd",
        }))
        stack.enter_context(patch.object(boundary.socket, "SO_PEERCRED", 17, create=True))
        socket_factory = stack.enter_context(patch.object(boundary.socket, "socket", return_value=client))
        parents = stack.enter_context(patch.object(boundary, "_open_trusted_parent", side_effect=[20, 21]))
        stack.enter_context(patch.object(boundary.os, "stat", side_effect=file_stat))
        opened_file = stack.enter_context(patch.object(boundary.os, "open", return_value=22))
        stack.enter_context(patch.object(boundary.os, "fstat", return_value=opened or executable))
        close = stack.enter_context(patch.object(boundary.os, "close"))
        links = stack.enter_context(patch.object(boundary.os, "readlink", return_value=readlink or "/usr/bin/dockerd"))
        return stack, client, socket_factory, parents, opened_file, close, links

    def test_existing_rootful_daemon_same_executable_and_namespace_is_admitted_read_only(self):
        stack, client, factory, parents, opened_file, close, _ = self.fixture()
        with stack:
            self.assertEqual(boundary.verify_local_docker_socket(), "/run/docker.sock")
        factory.assert_called_once_with(socket.AF_UNIX, socket.SOCK_STREAM)
        parents.assert_has_calls([call(Path("/run/docker.sock")), call(Path("/usr/bin/dockerd"))])
        self.assertTrue(opened_file.call_args.args[1] & os.O_NOFOLLOW)
        self.assertEqual(client.mock_calls, [
            call.settimeout(0.5), call.connect("/run/docker.sock"),
            call.getsockopt(socket.SOL_SOCKET, 17, 12), call.close(),
        ])
        close.assert_has_calls([call(22), call(21), call(20)])

    def test_mac_fails_before_any_socket_or_filesystem_inspection(self):
        with patch.object(boundary.platform, "system", return_value="Darwin"), \
                patch.object(boundary.socket, "socket") as connect, \
                patch.object(boundary, "_open_trusted_parent") as parents:
            with self.assertRaisesRegex(boundary.DockerBoundaryError, "local rootful Linux"):
                boundary.verify_local_docker_socket()
        connect.assert_not_called()
        parents.assert_not_called()

    def test_missing_peer_credentials_fails_closed(self):
        with patch.object(boundary.platform, "system", return_value="Linux"), \
                patch.object(boundary, "hasattr", side_effect=lambda _obj, name: name != "SO_PEERCRED", create=True), \
                patch.object(boundary.socket, "socket") as connect:
            with self.assertRaisesRegex(boundary.DockerBoundaryError, "peer credentials"):
                boundary.verify_local_docker_socket()
        connect.assert_not_called()

    def test_remote_relative_noncanonical_and_oversized_socket_paths_are_rejected(self):
        paths = ["tcp://localhost:2375", "run/docker.sock", "/run/../run/docker.sock",
                 "/run/./docker.sock", "/run//docker.sock", "//run/docker.sock",
                 "/", "/run/" + "x" * 108]
        for path in paths:
            with self.subTest(path=path), patch.object(boundary.platform, "system", return_value="Linux"), \
                    patch.object(boundary.socket, "SO_PEERCRED", 17, create=True), \
                    patch.dict(os.environ, {"NEWSCRAFT_DOCKER_SOCKET": path}), \
                    patch.object(boundary, "_open_trusted_parent") as parents, \
                    self.assertRaisesRegex(boundary.DockerBoundaryError, "canonical local path"):
                boundary.verify_local_docker_socket()
            parents.assert_not_called()

    def test_embedded_nul_path_is_rejected(self):
        # Real process environments cannot contain NUL, but a direct caller of
        # the path validator must still reject it explicitly.
        with self.assertRaisesRegex(boundary.DockerBoundaryError, "canonical local path"):
            boundary._canonical_path("/run/docker.sock\x00remote", "socket", socket_path=True)

    def test_daemon_executable_must_have_a_canonical_absolute_path(self):
        for path in ("dockerd", "/usr/bin/../bin/dockerd", "/usr/bin/./dockerd", ""):
            stack, client, _, parents, _, _, _ = self.fixture()
            with self.subTest(path=path), stack, patch.dict(os.environ, {"NEWSCRAFT_DOCKER_DAEMON_EXECUTABLE": path}), \
                    self.assertRaisesRegex(boundary.DockerBoundaryError, "canonical local path"):
                boundary.verify_local_docker_socket()
            parents.assert_not_called()
            client.connect.assert_not_called()

    def test_unowned_non_socket_symlink_and_public_writable_socket_rejected(self):
        variants = [info(stat.S_IFSOCK | 0o660, uid=1000), info(stat.S_IFREG | 0o660),
                    info(stat.S_IFLNK | 0o777), info(stat.S_IFSOCK | 0o666)]
        for variant in variants:
            stack, client, _, _, _, close, _ = self.fixture(socket_info=variant)
            with self.subTest(mode=variant.st_mode, uid=variant.st_uid), stack, \
                    self.assertRaisesRegex(boundary.DockerBoundaryError, "root-owned Unix socket"):
                boundary.verify_local_docker_socket()
            client.connect.assert_not_called()
            close.assert_called_once_with(20)

    def test_unsafe_daemon_file_rejected_before_connection(self):
        variants = [info(stat.S_IFREG | 0o755, uid=1000), info(stat.S_IFLNK | 0o777),
                    info(stat.S_IFREG | 0o775), info(stat.S_IFREG | 0o644), info(stat.S_IFDIR | 0o755)]
        for variant in variants:
            stack, client, _, _, _, _, _ = self.fixture(executable_info=variant)
            with self.subTest(mode=variant.st_mode, uid=variant.st_uid), stack, \
                    self.assertRaisesRegex(boundary.DockerBoundaryError, "daemon executable"):
                boundary.verify_local_docker_socket()
            client.connect.assert_not_called()

    def test_opened_daemon_file_must_match_prior_stat(self):
        changed = info(stat.S_IFREG | 0o755, inode=201)
        stack, client, _, _, _, close, _ = self.fixture(opened=changed)
        with stack, self.assertRaisesRegex(boundary.DockerBoundaryError, "executable changed"):
            boundary.verify_local_docker_socket()
        client.connect.assert_not_called()
        close.assert_has_calls([call(22), call(21), call(20)])

    def test_rootless_invalid_pid_or_short_peer_credentials_rejected(self):
        for credentials in (struct.pack("3i", 1234, 1000, 1000), struct.pack("3i", 0, 0, 0),
                            struct.pack("3i", -1, 0, 0), b"too short"):
            stack, client, _, _, _, _, _ = self.fixture(credentials=credentials)
            with self.subTest(credentials=credentials), stack, self.assertRaises(boundary.DockerBoundaryError):
                boundary.verify_local_docker_socket()
            client.close.assert_called_once_with()

    def test_root_owned_proxy_or_deleted_daemon_is_rejected(self):
        for target in ("/usr/bin/socat", "/usr/bin/dockerd-proxy", "/usr/bin/dockerd (deleted)"):
            stack, client, _, _, _, _, _ = self.fixture(readlink=target)
            with self.subTest(target=target), stack, \
                    self.assertRaisesRegex(boundary.DockerBoundaryError, "not the configured daemon"):
                boundary.verify_local_docker_socket()
            client.close.assert_called_once_with()

    def test_running_executable_inode_or_device_must_match_configured_daemon(self):
        for changed in (info(stat.S_IFREG | 0o755, inode=201), info(stat.S_IFREG | 0o755, device=2, inode=200)):
            stack, _, _, _, _, _, _ = self.fixture(peer_info=changed)
            with self.subTest(identity=(changed.st_dev, changed.st_ino)), stack, \
                    self.assertRaisesRegex(boundary.DockerBoundaryError, "executable identity"):
                boundary.verify_local_docker_socket()

    def test_vm_or_separate_mount_namespace_is_rejected(self):
        for changed in (info(stat.S_IFREG | 0o444, device=4, inode=301),
                        info(stat.S_IFREG | 0o444, device=5, inode=300)):
            stack, _, _, _, _, _, _ = self.fixture(theirs=changed)
            with self.subTest(identity=(changed.st_dev, changed.st_ino)), stack, \
                    self.assertRaisesRegex(boundary.DockerBoundaryError, "share the service mount namespace"):
                boundary.verify_local_docker_socket()

    def test_same_namespace_with_different_chroot_is_rejected(self):
        for changed in (info(stat.S_IFDIR | 0o755, device=10, inode=401),
                        info(stat.S_IFDIR | 0o755, device=11, inode=400)):
            stack, _, _, _, _, _, _ = self.fixture(peer_root=changed)
            with self.subTest(identity=(changed.st_dev, changed.st_ino)), stack, \
                    self.assertRaisesRegex(boundary.DockerBoundaryError, "share the service filesystem root"):
                boundary.verify_local_docker_socket()

    def test_unreadable_proc_metadata_is_an_explicit_fail_closed_gate(self):
        stack, client, _, _, _, _, links = self.fixture()
        with stack:
            links.side_effect = PermissionError(errno.EACCES, "procfs denied")
            with self.assertRaisesRegex(boundary.DockerBoundaryError, "read-only procfs metadata"):
                boundary.verify_local_docker_socket()
        client.close.assert_called_once_with()

    def test_connection_timeout_is_bounded_and_closes_all_descriptors(self):
        stack, client, _, _, _, close, _ = self.fixture()
        with stack:
            client.connect.side_effect = TimeoutError("Existing daemon unavailable")
            with self.assertRaises(boundary.DockerBoundaryError):
                boundary.verify_local_docker_socket()
        client.settimeout.assert_called_once_with(0.5)
        client.close.assert_called_once_with()
        close.assert_has_calls([call(22), call(21), call(20)])

    def test_socket_replacement_or_permissions_changed_during_inspection_is_rejected(self):
        for changed in (info(stat.S_IFSOCK | 0o660, gid=999, inode=101),
                        info(stat.S_IFSOCK | 0o660, gid=999, inode=100, change=2),
                        info(stat.S_IFSOCK | 0o666, gid=999, inode=100)):
            stack, _, _, _, _, _, _ = self.fixture(second_socket=changed)
            with self.subTest(inode=changed.st_ino, mode=changed.st_mode), stack, \
                    self.assertRaises(boundary.DockerBoundaryError):
                boundary.verify_local_docker_socket()

    def test_executable_replacement_after_peer_proof_is_rejected(self):
        stack, _, _, _, _, _, _ = self.fixture(second_executable=info(stat.S_IFREG | 0o755, inode=201))
        with stack, self.assertRaisesRegex(boundary.DockerBoundaryError, "changed during inspection"):
            boundary.verify_local_docker_socket()

    def test_docker_host_context_and_config_do_not_select_the_daemon(self):
        stack, client, _, _, _, _, _ = self.fixture()
        with stack, patch.dict(os.environ, {"DOCKER_HOST": "tcp://remote.invalid:2375",
                                           "DOCKER_CONTEXT": "remote", "DOCKER_CONFIG": "/tmp/untrusted"}):
            self.assertEqual(boundary.verify_local_docker_socket(), "/run/docker.sock")
        client.connect.assert_called_once_with("/run/docker.sock")

    def test_all_parent_components_are_opened_without_following_links(self):
        safe = info(stat.S_IFDIR | 0o755)
        with patch.object(boundary.os, "open", side_effect=[10, 11, 12]) as opened, \
                patch.object(boundary.os, "fstat", return_value=safe), \
                patch.object(boundary.os, "close") as close:
            self.assertEqual(boundary._open_trusted_parent(Path("/usr/bin/dockerd")), 12)
        self.assertEqual([item.args[0] for item in opened.call_args_list], ["/", "usr", "bin"])
        for item in opened.call_args_list:
            self.assertTrue(item.args[1] & os.O_NOFOLLOW)
            self.assertTrue(item.args[1] & os.O_DIRECTORY)
        close.assert_has_calls([call(10), call(11)])

    def test_root_or_intermediate_parent_must_not_allow_non_root_writers(self):
        safe = info(stat.S_IFDIR | 0o755)
        for unsafe in (info(stat.S_IFDIR | 0o755, uid=1000), info(stat.S_IFDIR | 0o775),
                       info(stat.S_IFDIR | 0o777), info(stat.S_IFREG | 0o755)):
            for at_root in (True, False):
                with self.subTest(mode=unsafe.st_mode, at_root=at_root), \
                        patch.object(boundary.os, "open", side_effect=[10, 11]), \
                        patch.object(boundary.os, "fstat", side_effect=[unsafe] if at_root else [safe, unsafe]), \
                        patch.object(boundary.os, "close") as close, \
                        self.assertRaisesRegex(boundary.DockerBoundaryError, "root-owned directories"):
                    boundary._open_trusted_parent(Path("/run/docker.sock"))
                close.assert_any_call(10 if at_root else 11)

    def test_parent_symlink_is_rejected_and_open_descriptor_closed(self):
        safe = info(stat.S_IFDIR | 0o755)
        with patch.object(boundary.os, "open", side_effect=[10, OSError(errno.ELOOP, "symlink")]), \
                patch.object(boundary.os, "fstat", return_value=safe), \
                patch.object(boundary.os, "close") as close, self.assertRaises(OSError):
            boundary._open_trusted_parent(Path("/run/docker.sock"))
        close.assert_called_once_with(10)


class VerifiedDockerArgvTests(unittest.IsolatedAsyncioTestCase):
    async def test_all_owned_commands_get_explicit_host_and_keep_the_original_argv_unchanged(self):
        for command in ("image", "ps", "rm", "run", "exec", "inspect"):
            args = ["docker", command, "--example"]
            with self.subTest(command=command), boundary.empty_docker_config() as config, \
                    patch.object(boundary, "verify_local_docker_socket", return_value="/run/docker.sock") as verify:
                self.assertEqual(await boundary.verified_docker_argv(args, config_dir=config),
                                 ["docker", "--config", str(config), "--host", "unix:///run/docker.sock", command, "--example"])
            self.assertEqual(args, ["docker", command, "--example"])
            verify.assert_called_once_with()

    async def test_container_python_c_argument_is_preserved(self):
        args = ["docker", "exec", "--interactive", "container", "python3", "-I", "-c", "print('fixture')"]
        with boundary.empty_docker_config() as config, patch.object(boundary, "verify_local_docker_socket", return_value="/run/docker.sock"):
            result = await boundary.verified_docker_argv(args, config_dir=config)
        self.assertEqual(result[5:], args[1:])

    async def test_boundary_failure_prevents_any_command_from_being_returned(self):
        with boundary.empty_docker_config() as config, \
                patch.object(boundary, "verify_local_docker_socket", side_effect=boundary.DockerBoundaryError("blocked")), \
                self.assertRaisesRegex(boundary.DockerBoundaryError, "blocked"):
            await boundary.verified_docker_argv(["docker", "exec", "container", "true"], config_dir=config)

    async def test_context_host_overrides_or_unowned_commands_are_rejected_before_peer_check(self):
        cases = [[], ["docker"], ["podman", "exec"], ["docker", "--context", "remote", "exec"],
                 ["docker", "-c", "remote", "exec"], ["docker", "--host=tcp://remote", "exec"],
                 ["docker", "run", "--host=tcp://remote"], ["docker", "run", "-Htcp://remote"],
                 ["docker", "run", "--context=remote"], ["docker", "context", "use", "remote"],
                 ["docker", "--config", "/tmp/ambient", "run"], ["docker", "run", "--config=/tmp/ambient"]]
        for args in cases:
            with self.subTest(args=args), boundary.empty_docker_config() as config, \
                    patch.object(boundary, "verify_local_docker_socket") as verify, \
                    self.assertRaisesRegex(boundary.DockerBoundaryError, "host or context overrides"):
                await boundary.verified_docker_argv(args, config_dir=config)
            verify.assert_not_called()

    async def test_private_empty_config_overrides_ambient_credentials_contexts_and_proxies(self):
        with tempfile.TemporaryDirectory() as ambient:
            ambient_path = Path(ambient)
            (ambient_path / "config.json").write_text('{"proxies":{"default":{"httpProxy":"https://fixture:synthetic@proxy.invalid"}},"currentContext":"remote"}')
            with patch.dict(os.environ, {"DOCKER_CONFIG": ambient, "DOCKER_CONTEXT": "remote",
                                         "DOCKER_HOST": "tcp://remote.invalid:2375", "TMPDIR": ambient}), \
                    boundary.empty_docker_config() as config, \
                    patch.object(boundary, "verify_local_docker_socket", return_value="/run/docker.sock"):
                self.assertEqual(config.parent, Path("/tmp").resolve())
                self.assertEqual(stat.S_IMODE(config.stat().st_mode), 0o700)
                self.assertEqual(list(config.iterdir()), [])
                self.assertFalse(config.is_relative_to(ambient_path))
                result = await boundary.verified_docker_argv(["docker", "run", "fixture"], config_dir=config)
                self.assertEqual(result[1:5], ["--config", str(config), "--host", "unix:///run/docker.sock"])
            self.assertFalse(config.exists())
            self.assertTrue((ambient_path / "config.json").exists())

    async def test_foreign_or_expired_private_directory_is_rejected_before_peer_check(self):
        with tempfile.TemporaryDirectory() as foreign, boundary.empty_docker_config() as active:
            path = Path(foreign)
        for path in (Path(foreign), active):
            with self.subTest(path=path.name), patch.object(boundary, "verify_local_docker_socket") as verify, \
                    self.assertRaisesRegex(boundary.DockerBoundaryError, "active private empty"):
                await boundary.verified_docker_argv(["docker", "ps"], config_dir=path)
            verify.assert_not_called()

    async def test_config_mutation_before_or_during_peer_check_blocks_cli(self):
        with boundary.empty_docker_config() as config, patch.object(boundary, "verify_local_docker_socket") as verify:
            (config / "config.json").write_text('{"currentContext":"remote"}')
            with self.assertRaisesRegex(boundary.DockerBoundaryError, "changed or is not empty"):
                await boundary.verified_docker_argv(["docker", "ps"], config_dir=config)
            verify.assert_not_called()
        with boundary.empty_docker_config() as config:
            def changed_during_inspection():
                (config / "config.json").write_text('{}')
                return "/run/docker.sock"
            with patch.object(boundary, "verify_local_docker_socket", side_effect=changed_during_inspection), \
                    self.assertRaisesRegex(boundary.DockerBoundaryError, "changed or is not empty"):
                await boundary.verified_docker_argv(["docker", "ps"], config_dir=config)

    async def test_config_permissions_and_symlinks_cannot_replace_active_directory(self):
        with boundary.empty_docker_config() as config:
            config.chmod(0o755)
            with self.assertRaisesRegex(boundary.DockerBoundaryError, "changed or is not empty"):
                await boundary.verified_docker_argv(["docker", "ps"], config_dir=config)
            config.chmod(0o700)
        with boundary.empty_docker_config() as config:
            saved = config.with_name(config.name + "-saved")
            config.rename(saved)
            config.symlink_to(saved, target_is_directory=True)
            try:
                with self.assertRaisesRegex(boundary.DockerBoundaryError, "cannot be inspected safely"):
                    await boundary.verified_docker_argv(["docker", "ps"], config_dir=config)
            finally:
                config.unlink()
                saved.rename(config)


class EmptyDockerConfigTests(unittest.TestCase):
    def test_config_is_removed_on_caller_error(self):
        config = None
        with self.assertRaisesRegex(RuntimeError, "fixture"):
            with boundary.empty_docker_config() as config:
                self.assertTrue(config.exists())
                raise RuntimeError("fixture")
        self.assertIsNotNone(config)
        self.assertFalse(config.exists())
        self.assertNotIn(str(config), boundary._ACTIVE_CONFIGS)


if __name__ == "__main__":
    unittest.main()
