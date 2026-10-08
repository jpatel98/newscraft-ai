"""Disposable synthetic validation computer; never selected by the service.

No host directory is mounted. The selected AF_UNIX daemon may be a local Linux
VM (Colima); unlike production there is no host pathname/quota correspondence
to attest. All writable storage is bounded inside the disposable container.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import stat
from pathlib import Path
from typing import Any

from .browser_rpc import BrowserSession
from .docker_boundary import empty_docker_config
from .live_validation_fixture import ALLOWED_URLS
from .sandbox import ComputerSandbox, SandboxError, MAX_FILE_BYTES, _IMAGE_CONTRACT

WORKSPACE_BYTES = 64 * 1024 * 1024
WORKSPACE_INODES = 4096
TMP_BYTES = 128 * 1024 * 1024
TMP_INODES = 8192
MAX_EXPORT_FILES = 20
MAX_EXPORT_BYTES = 20 * 1024 * 1024

# These tests intentionally exhaust only disposable tmpfs, sequentially, before
# a credential is read. No host mount, shell, or background surviving the test.
_BOUND_PROOF = r'''
import errno, json, os, subprocess, sys, tempfile
status = dict(line.split(':', 1) for line in open('/proc/self/status') if ':' in line)
if (status.get('Seccomp','').strip() != '2' or status.get('NoNewPrivs','').strip() != '1'
        or int(status.get('CapEff','1').strip(),16) != 0):
    raise RuntimeError('guest security restrictions differ')
v = os.statvfs('/workspace')
if v.f_frsize * v.f_blocks != 67108864 or v.f_files != 4096:
    raise RuntimeError('workspace tmpfs limits differ')
t = os.statvfs('/tmp')
if t.f_frsize * t.f_blocks != 134217728 or t.f_files != 8192:
    raise RuntimeError('temporary tmpfs limits differ')
folder = tempfile.mkdtemp(prefix='bounds-', dir='/workspace')
byte_full = inode_full = False
try:
    # A child writer proves aggregate kernel enforcement outside a file tool.
    child = subprocess.run([sys.executable, '-I', '-c', "import errno,sys\np=sys.argv[1]\ntry:\n with open(p,'wb',buffering=0) as f:\n  for _ in range(65): f.write(b'x'*1048576)\nexcept OSError as e:\n sys.exit(0 if e.errno==errno.ENOSPC else 2)\nsys.exit(3)", folder+'/large'], timeout=10)
    byte_full = child.returncode == 0
    os.unlink(folder+'/large')
    try:
        for i in range(4097):
            fd = os.open(folder+'/'+str(i), os.O_CREAT|os.O_EXCL|os.O_WRONLY, 0o600)
            os.close(fd)
    except OSError as e:
        inode_full = e.errno == errno.ENOSPC
finally:
    for name in os.listdir(folder): os.unlink(folder+'/'+name)
    os.rmdir(folder)
if not byte_full or not inode_full: raise RuntimeError('kernel tmpfs enforcement unproven')
print(json.dumps({'byte_exhaustion': True, 'inode_exhaustion': True,
 'workspace_bytes': 67108864, 'workspace_inodes': 4096,
 'tmp_bytes': 134217728, 'tmp_inodes': 8192}))
'''

class DisposableValidationSandbox(ComputerSandbox):
    """Same tool contract and browser RPC, with a disposable tmpfs backend."""

    def __init__(self, runtime, conversation_id, *, docker_socket: str, **kwargs):
        if kwargs.get('synthetic_fixture') is not True or frozenset(kwargs.get('allowed_urls') or ()) != ALLOWED_URLS:
            raise SandboxError('Disposable validation requires the exact synthetic fixture policy')
        super().__init__(runtime, conversation_id, **kwargs)
        self._socket = Path(docker_socket)
        self._socket_identity = self._check_socket()
        self._image_id = None
        self._exports: dict[str, bytes] = {}
        self._export_bytes = 0
        self.bounds_proof: dict[str, Any] | None = None

    def _check_socket(self):
        path = self._socket
        if (not path.is_absolute() or '..' in path.parts or len(str(path)) > 100
                or any(p.is_symlink() for p in (path, *path.parents))):
            raise SandboxError('Explicit validation Docker socket must be an absolute non-symlink AF_UNIX path')
        try:
            for parent in path.parents:
                directory=parent.stat()
                sticky_root_tmp = directory.st_uid == 0 and directory.st_mode & stat.S_ISVTX
                if (not stat.S_ISDIR(directory.st_mode) or directory.st_uid not in {0,os.getuid()}
                        or directory.st_mode & 0o022 and not sticky_root_tmp):
                    raise SandboxError('Selected Docker socket parent is not trusted')
            info = path.stat()
        except OSError as exc:
            raise SandboxError('Selected Docker socket is unavailable; no daemon is started') from exc
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid not in {0, os.getuid()} or info.st_mode & 0o002:
            raise SandboxError('Selected validation socket has unsafe ownership or permissions')
        return info.st_dev, info.st_ino, info.st_uid

    async def _argv(self, argv: list[str], *, config_dir: Path) -> list[str]:
        if self._check_socket() != self._socket_identity:
            raise SandboxError('Selected Docker socket identity changed')
        if (len(argv) < 2 or argv[0] != 'docker' or argv[1] not in {'run', 'exec', 'inspect', 'rm', 'image'}
                or any(a.startswith(('--host', '--context', '--config')) or a == '-H' for a in argv[2:])):
            raise SandboxError('Validation Docker global overrides are forbidden')
        # Issued by empty_docker_config, never ~/.docker or a model-selected path.
        return ['docker', '--config', str(config_dir), '--host', 'unix://' + str(self._socket), *argv[1:]]

    async def _process(self, argv, *, payload=None, timeout=30):
        with empty_docker_config() as config:
            return await self._process_pinned(await self._argv(argv, config_dir=config), payload=payload, timeout=timeout)

    def _make_browser(self, state):
        return BrowserSession(self.name, env=self._docker_env(), browser_uid=os.getuid()+65536,
            group_id=os.getgid(), resource_fetcher=self._resource_fetcher, allowed_urls=self._allowed_urls,
            storage_state=state['storage'], input_tainted=state['input_tainted'], last_url=state['last_url'],
            docker_argv_builder=self._argv)

    async def prepare(self):
        # Never reclaim production containers, even for a coincident scope.
        if self._closed:
            raise SandboxError('Disposable computer is closed')
        self._prepared = True

    async def _remove(self):
        if self._browser is not None:
            browser,self._browser=self._browser,None
            await browser.close()
        if not self._started:
            return
        code,output,error=await self._process(['docker','inspect','--format','{{json .Config.Labels}}',self.name], timeout=5)
        if code and ('No such object' in error or 'No such container' in error):
            self._started=False
            return
        try:
            labels=json.loads(output)
        except ValueError as exc:
            raise SandboxError('Disposable cleanup ownership is unconfirmed') from exc
        if (code or not isinstance(labels,dict) or labels.get('newscraft.managed') != 'disposable-validation'
                or labels.get('newscraft.scope') != self.runtime.task_key):
            raise SandboxError('Disposable cleanup refuses an unowned container')
        code,_,_=await self._process(['docker','rm','--force',self.name],timeout=10)
        if code:
            raise SandboxError('Disposable cleanup is unconfirmed; operator inspection required')
        self._started=False

    async def _image_manifest(self, image):
        code, output, _ = await self._process(['docker','image','inspect','--format','{{json .}}',image], timeout=5)
        try:
            info=json.loads(output)
            identity=info['Id']
            labels=info['Config']['Labels']
            if (code or not re.fullmatch(r'sha256:[a-f0-9]{64}',identity)
                    or any(labels.get(key) != value for key,value in _IMAGE_CONTRACT.items())):
                raise ValueError('image contract')
        except (KeyError,TypeError,ValueError) as exc:
            raise SandboxError('Existing validation image identity or reviewed contract is invalid') from exc
        self._image_id=identity

    def _run_argv(self):
        return ['docker', 'run', '--detach', '--pull=never', '--name', self.name, '--init',
            '--label', 'newscraft.managed=disposable-validation', '--label', 'newscraft.scope='+self.runtime.task_key,
            '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
            '--pids-limit=128', '--memory=768m', '--memory-swap=768m', '--cpus=1',
            '--ulimit', 'nofile=256:256', '--ulimit', 'fsize=73400320:73400320',
            '--user', f'{os.getuid()}:{os.getgid()}', '--workdir', '/workspace',
            '--tmpfs', f'/workspace:rw,nosuid,nodev,size={WORKSPACE_BYTES},nr_inodes={WORKSPACE_INODES},mode=0700,uid={os.getuid()},gid={os.getgid()}',
            '--tmpfs', f'/tmp:rw,noexec,nosuid,nodev,size={TMP_BYTES},nr_inodes={TMP_INODES},mode=1777',
            '--shm-size=64m', '--env', 'HOME=/workspace', '--env', 'TMPDIR=/tmp',
            '--entrypoint', 'python3', self._image_id or self.image, '-c', 'import time; time.sleep(240)']

    def _verify_inspect(self, data):
        h, c = data.get('HostConfig', {}), data.get('Config', {})
        tmpfs = h.get('Tmpfs', {})
        expected = dict(zip(['/workspace', '/tmp'], [self._run_argv()[self._run_argv().index('--tmpfs')+1].split(':',1)[1],
            f'rw,noexec,nosuid,nodev,size={TMP_BYTES},nr_inodes={TMP_INODES},mode=1777']))
        if (c.get('Labels', {}).get('newscraft.managed') != 'disposable-validation'
                or c.get('Labels', {}).get('newscraft.scope') != self.runtime.task_key
                or c.get('User') != f'{os.getuid()}:{os.getgid()}'
                or h.get('NetworkMode') != 'none' or h.get('ReadonlyRootfs') is not True
                or h.get('Privileged') is not False or h.get('CapDrop') != ['ALL']
                or 'no-new-privileges' not in h.get('SecurityOpt', [])
                or any('unconfined' in item for item in h.get('SecurityOpt', []))
                or h.get('Binds') or h.get('Devices') or h.get('DeviceRequests') or h.get('CapAdd')
                or h.get('VolumesFrom') or h.get('Mounts')
                or h.get('PidMode') or h.get('IpcMode') == 'host' or h.get('UTSMode') == 'host'
                or h.get('Memory') != 768*1024*1024 or h.get('MemorySwap') != 768*1024*1024
                or h.get('NanoCpus') != 1000000000 or h.get('PidsLimit') != 128
                or h.get('ShmSize') != 64*1024*1024 or tmpfs != expected
                or any(m.get('Type') != 'tmpfs' or m.get('Destination') not in {'/tmp','/workspace','/dev/shm'} for m in data.get('Mounts', []))
                or data.get('State', {}).get('Running') is not True):
            raise SandboxError('Actual disposable container isolation or storage limits differ')
        if self._image_id is not None and data.get('Image') != self._image_id:
            raise SandboxError('Disposable container image differs from the inspected immutable image')

    async def _start(self):
        if self._closed:
            raise SandboxError('Disposable computer is closed')
        if self._started:
            return
        if not self.image or os.getuid() == 0:
            raise SandboxError('Validation requires an existing reviewed image and a non-root operator')
        await self._image_manifest(self.image)
        if self._image_id is None:
            raise SandboxError('Validation image was not pinned')
        self._started = True
        try:
            code, _, _ = await self._process(self._run_argv(), timeout=20)
            if code: raise SandboxError('Disposable container could not start')
            code, output, _ = await self._process(['docker','inspect',self.name], timeout=5)
            items = json.loads(output)
            if code or not isinstance(items, list) or len(items) != 1:
                raise SandboxError('Disposable container inspection failed')
            self._verify_inspect(items[0])
            self.bounds_proof = await self._exec_json(_BOUND_PROOF, {}, 20)
            if self.bounds_proof.get('byte_exhaustion') is not True or self.bounds_proof.get('inode_exhaustion') is not True:
                raise SandboxError('Disposable tmpfs enforcement proof failed')
        except BaseException:
            await asyncio.shield(self._remove())
            raise

    def _export(self, folder: str, name: str, data: bytes):
        if folder not in {'outputs','browser-screenshots'} or not re.fullmatch(r'[A-Za-z0-9_.-]{1,100}', name) or name in {'.','..'}:
            raise SandboxError('Validation export path is invalid')
        key = folder+'/'+name
        if len(data) > MAX_FILE_BYTES or len(self._exports) >= MAX_EXPORT_FILES or self._export_bytes+len(data) > MAX_EXPORT_BYTES or key in self._exports:
            raise SandboxError('Validation report export limit exceeded')
        root = os.open(self.runtime.workspace, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        target = fd = None
        try:
            target = os.open(folder, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW, dir_fd=root)
            fd = os.open(name, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600, dir_fd=target)
            view = memoryview(data)
            while view: view = view[os.write(fd, view):]
            os.fsync(fd)
        finally:
            if fd is not None: os.close(fd)
            if target is not None: os.close(target)
            os.close(root)
        self._exports[key] = data
        self._export_bytes += len(data)
        return '/workspace/'+key

    def _save_screenshot(self, data):
        import secrets
        return self._export('browser-screenshots','capture-'+secrets.token_hex(12)+'.png', data)

    async def execute(self, name, args):
        result = await super().execute(name, args)
        # Export only declared write_file bytes already accepted by the guest.
        # Terminal-created files and arbitrary guest paths never enter the host.
        if name == 'write_file' and not result.get('error'):
            path = result.get('path', '')
            if re.fullmatch(r'/workspace/outputs/[A-Za-z0-9_.-]{1,100}', path):
                self._export('outputs', path.rsplit('/',1)[1], args['content'].encode())
        return result
