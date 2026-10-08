"""Fixed programs sent to the isolated computer, never executed on the worker.

Docker cp does not support tmpfs. Restore and snapshot therefore stream through
trusted execs. Snapshot first kills all other untrusted-UID processes; a process
that attacks this helper can only make the action fail and discard its changes.
No extra capability is needed to signal processes belonging to the same UID.
"""

_GUARD = r'''
import os
from pathlib import Path
if os.getuid() != 1000 or os.geteuid() != 1000:
    raise RuntimeError("unexpected computer identity")
status = dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines() if ":" in line)
if any(int(status[name].strip(), 16) for name in ("CapEff", "CapPrm", "CapInh", "CapAmb", "CapBnd")):
    raise RuntimeError("computer capabilities were not dropped")
if status["NoNewPrivs"].strip() != "1" or status["Seccomp"].strip() != "2":
    raise RuntimeError("computer process restrictions are missing")
control = Path("/sys/fs/cgroup")
if (control.joinpath("memory.max").read_text().strip() != str(MEMORY_LIMIT)
        or control.joinpath("memory.swap.max").read_text().strip() != "0"
        or control.joinpath("pids.max").read_text().strip() != str(PID_LIMIT)):
    raise RuntimeError("computer cgroup limits are not enforced")
quota, period = control.joinpath("cpu.max").read_text().split()
if quota == "max" or not 0 < int(quota) <= int(period):
    raise RuntimeError("computer CPU limit is not enforced")
mounts = [line.split() for line in Path("/proc/self/mountinfo").read_text().splitlines()]
for path, size, inodes in (("/workspace", 8388608, 512), ("/tmp", TEMP_BYTES, TEMP_INODES)):
    matches = [line for line in mounts if line[4] == path]
    if len(matches) != 1 or matches[0][matches[0].index("-") + 1] != "tmpfs" or not {"nosuid", "nodev", "noexec"}.issubset(matches[0][5].split(",")):
        raise RuntimeError("computer temporary filesystem restrictions are missing")
    filesystem = os.statvfs(path)
    if filesystem.f_blocks * filesystem.f_frsize > size or not 0 < filesystem.f_files <= inodes:
        raise RuntimeError("computer temporary filesystem limits are not enforced")
'''

def guard_program(*, memory=268435456, pids=64, temp_bytes=16777216, temp_inodes=1024):
    return f"MEMORY_LIMIT={int(memory)}\nPID_LIMIT={int(pids)}\nTEMP_BYTES={int(temp_bytes)}\nTEMP_INODES={int(temp_inodes)}\n" + _GUARD


GUARD = guard_program()

RESTORE = r'''
import io, os, sys, tarfile
from pathlib import Path
root = Path("/workspace")
data = sys.stdin.buffer.read(8388609)
if len(data) > 8388608:
    raise ValueError("archive limit")
total = 0
seen = set()
with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as archive:
    for item in archive:
        parts = item.name.split("/")
        if (any(p in ("", ".", "..") for p in parts) or "\\" in item.name
                or len(parts) > 16 or item.name in seen or len(seen) >= 256
                or not (item.isfile() or item.isdir()) or item.sparse
                or not 0 <= item.size <= 1048576):
            raise ValueError("unsafe archive")
        seen.add(item.name)
        total += item.size
        if total > 4194304:
            raise ValueError("workspace limit")
        path = root.joinpath(*parts)
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if item.isdir():
            path.mkdir(exist_ok=True, mode=0o700)
        else:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "wb") as target:
                content = archive.extractfile(item).read(1048577)
                if len(content) != item.size:
                    raise ValueError("incomplete file")
                target.write(content)
'''

SNAPSHOT = r'''
import io, os, signal, stat, sys, tarfile, time
from pathlib import Path

def quiesce():
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        active = []
        for path in Path("/proc").iterdir():
            if not path.name.isdecimal() or int(path.name) == os.getpid():
                continue
            try:
                status = dict(line.split(":", 1) for line in (path / "status").read_text().splitlines() if ":" in line)
            except (FileNotFoundError, ProcessLookupError):
                continue
            if status["State"].strip().startswith(("Z", "X")):
                continue
            uids = [int(value) for value in status["Uid"].split()]
            if path.name == "1" and uids == [0, 0, 0, 0]:
                continue
            if uids != [1000, 1000, 1000, 1000]:
                raise RuntimeError("unexpected process identity")
            active.append(int(path.name))
        if not active:
            return
        for pid in active:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        time.sleep(.01)
    raise RuntimeError("computer did not become quiescent")

def snapshot():
    root = Path("/workspace")
    output = io.BytesIO()
    total = count = 0
    with tarfile.open(fileobj=output, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        def visit(directory, prefix=""):
            nonlocal total, count
            for path in sorted(directory.iterdir()):
                name = prefix + path.name
                count += 1
                if count > 256 or len(name.encode()) > 512 or len(name.split("/")) > 16:
                    raise ValueError("workspace entry limit")
                info = path.lstat()
                if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)) or info.st_nlink > 1 and stat.S_ISREG(info.st_mode):
                    raise ValueError("only independent ordinary files and directories persist")
                item = tarfile.TarInfo(name)
                item.uid = item.gid = 1000
                if stat.S_ISDIR(info.st_mode):
                    item.type, item.mode = tarfile.DIRTYPE, 0o700
                    archive.addfile(item)
                    visit(path, name + "/")
                else:
                    if info.st_size > 1048576:
                        raise ValueError("file limit")
                    total += info.st_size
                    if total > 4194304:
                        raise ValueError("workspace limit")
                    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                    with os.fdopen(fd, "rb") as source:
                        check = os.fstat(source.fileno())
                        if not stat.S_ISREG(check.st_mode) or (check.st_ino, check.st_dev, check.st_size) != (info.st_ino, info.st_dev, info.st_size):
                            raise ValueError("file changed during snapshot")
                        item.mode, item.size = 0o600, info.st_size
                        archive.addfile(item, source)
        visit(root)
    if len(output.getbuffer()) > 8388608:
        raise ValueError("archive limit")
    sys.stdout.buffer.write(output.getvalue())

quiesce()
snapshot()
'''

def watchdog_program(seconds):
    if type(seconds) is not int or not 1 <= seconds <= 360:
        raise ValueError("invalid computer watchdog")
    return f"WATCHDOG_SECONDS={seconds}\n" + '''import os,time
deadline=time.monotonic()+WATCHDOG_SECONDS
while time.monotonic()<deadline:
 try:
  while os.waitpid(-1, os.WNOHANG)[0]: pass
 except ChildProcessError: pass
 time.sleep(.1)
os._exit(0)
'''


WATCHDOG = watchdog_program(90)
