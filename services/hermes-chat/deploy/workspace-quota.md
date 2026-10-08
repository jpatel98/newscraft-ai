> Historical XFS/rootful-Docker design, unselected by the active runtime. The owned portable runtime uses the optional rootless OCI adapter described in [current executor setup](executor.md); the managed Agents API is also unselected. The requirements below document the earlier bind-mount backend and are not active deployment prerequisites.

# Persistent computer workspace admission

Computer tools require an operator-provisioned **Linux XFS project-quota backend**. A normal host bind mount, Docker memory limit, per-file size limit, or workspace `.quota.json` does not satisfy admission. Mac/Colima host storage is unsupported by this verifier. The application does not mount storage, create quota assignments, enable enforcement, install a seccomp policy, or grant privileges.

`hermes_chat.quota.verify_workspace_quota(runtime)` runs before the sandbox container starts. Failure blocks terminal, filesystem, and browser execution. `quota_readiness()` checks one registered conversation assignment and reports `configured: false` when proof is unavailable. Each actual conversation must independently pass admission; one ready assignment does not provision future conversations.

## Required infrastructure

An authorized operator must provision the following before live validation:

1. An XFS mount with project quota accounting **and enforcement** enabled (`prjquota` or `pquota`). Mount target, source, device identity, and filesystem root must match the registry exactly. A subtree bind mount is unsupported.
2. A separate nonzero project ID for every conversation workspace on a filesystem. All existing files and directories must have that project ID, and every directory must have `FS_XFLAG_PROJINHERIT`. Projects and workspace paths cannot overlap between conversations.
3. Finite project **hard byte and inode limits**, both within application maxima. Soft limits, accounting alone, and `0` unlimited hard limits fail admission. The quota covers the entire conversation tree, including screenshots and outputs, and applies to all concurrent or background writers through kernel enforcement. Private browser storage is separately capped at 1 MiB outside the model mount. This kernel behavior still requires an authorized live write test on the deployed backend. [XFS quota documentation](https://man7.org/linux/man-pages/man8/xfs_quota.8.html)
4. A root-owned, read-only-to-service quota registry and seccomp profile outside every sandbox workspace. Every path component must be a real directory owned by root, without group/other write permission. Configuration files must be regular files; symlinks are rejected.
5. An unprivileged worker account with read access to these configuration files, directory contents and inode attributes, and the exact read-only XFS queries below. The worker and sandbox must not receive quota administration privileges. If the distribution requires privileged quota query access, admission remains blocked until a separately reviewed query-only mechanism is provisioned. No such privileged helper is shipped here; do not solve this by granting broad `CAP_SYS_ADMIN` or unrestricted `sudo xfs_quota`.
6. A direct daemon-created root-owned AF_UNIX Docker socket, approved root-owned dockerd executable, matching worker/daemon mount namespace and pathname root, and readable peer procfs identity. Every Docker command pins that socket and an empty private CLI configuration. TCP/SSH/Desktop/VM contexts and root-owned forwarding proxies fail admission. Socket activation exposing PID 1 peer credentials also fails; service mount hardening may create a different namespace. These deployment layouts require an approved compatible setup, not a bypass.
7. A reviewed native-architecture, default-deny seccomp policy which retains the deployment's Docker baseline restrictions and protects project inheritance. Applying that policy and permitting Chromium namespaces require an explicit deployment security review. No default-allow or unconfined profile is supported.

The current `TenantIsolation` resolves the exact workspace under `NEWSCRAFT_AGENT_WORKSPACE/tenants/<tenant-key>/conversations/<conversation-hash>`. Use its returned `TenantRuntime.workspace` and `task_key` as the assignment identity. Do not accept workspace paths, project IDs, or quota metadata from model arguments. Assignments must exist before a conversation uses computer tools. The application currently has no privileged automatic provisioning path, so an unregistered new conversation is blocked.


An ordinary unprivileged Linux account, including Docker group membership, generally cannot inspect a root daemon’s `/proc/<pid>/exe`, namespace and filesystem-root links. The direct verifier therefore remains blocked unless an already authorized read-only inspection mechanism exists. A narrow operator helper may require separate implementation and approval; none is shipped here. XFS quota query access can present the same issue. Broad `CAP_SYS_PTRACE`, `CAP_SYS_ADMIN`, sudo access or relaxed namespace checks are not proposed.

## Worker configuration

Place these references in the operator-managed worker environment; this example contains no credential values:

```dotenv
NEWSCRAFT_QUOTA_REGISTRY=/etc/newscraft/workspace-quotas.json
NEWSCRAFT_SANDBOX_SECCOMP_PROFILE=/etc/newscraft/sandbox-seccomp.json
NEWSCRAFT_WORKSPACE_MAX_BYTES=268435456
NEWSCRAFT_WORKSPACE_MAX_INODES=10000
```

The defaults are 256 MiB and 10,000 inodes per conversation. Configuration accepts positive byte maxima up to 2 GiB and inode maxima up to 100,000. These are admission ceilings; the operator's actual kernel hard limits must match each registry entry and may be smaller. The environment cannot enable a quota by itself.

The registry schema is exact; unknown or duplicate fields are rejected. The following entry illustrates its shape. Replace every example identity with values from the actual provisioned directory and mount:

```json
{
  "version": 1,
  "workspaces": [
    {
      "scope": "newscraft-0123456789abcdef0123456789abcdef",
      "workspace": "/srv/newscraft-xfs/tenants/example/conversations/example",
      "device": 2049,
      "inode": 123456,
      "mount_target": "/srv/newscraft-xfs",
      "mount_source": "/dev/sdb1",
      "project_id": 1001,
      "hard_bytes": 268435456,
      "hard_inodes": 10000
    }
  ]
}
```

`device` and `inode` are the directory's actual `st_dev` and `st_ino`, not invented identifiers. `scope` is the server-derived `TenantRuntime.task_key`. IDs must be unique per filesystem; project `0` is forbidden. `hard_bytes` must be an exact 1 KiB multiple. The registry is limited to 4,096 assignments and 1 MiB. An operator must refresh stale mount/device/directory identity after infrastructure changes; a stale entry fails closed.

## Seccomp contract

The verifier supports Linux `x86_64` (`SCMP_ARCH_X86_64`) and `aarch64` (`SCMP_ARCH_AARCH64`) only. The profile must explicitly list its single native architecture, use a deny default action, and omit compatibility architecture maps. It rejects trace/notify/log actions, filesystem administration allowances, generic `ioctl` allowances, and malformed or repeated argument comparisons. It does not certify Chromium compatibility or independently prove that the kernel loaded a filter.

The following filesystem mutation requests must be explicitly denied using `SCMP_CMP_MASKED_EQ` on argument index `1`, mask `4294967295`. Masking the low word also covers high-word aliases of the kernel's 32-bit request:

| Request | Hex value | Decimal value |
| --- | --- | --- |
| `FS_IOC_FSSETXATTR` | `0x401c5820` | `1075599392` |
| `FS_IOC_SETFLAGS`, native | `0x40086602` | `1074292226` |
| `FS_IOC_SETFLAGS`, compat | `0x40046602` | `1074030082` |

The numbers come from the [Linux filesystem UAPI](https://raw.githubusercontent.com/torvalds/linux/master/include/uapi/linux/fs.h). This deny rule illustrates one required entry; it is **not a complete executable profile**:

```json
{
  "names": ["ioctl"],
  "action": "SCMP_ACT_ERRNO",
  "errnoRet": 13,
  "args": [{
    "index": 1,
    "op": "SCMP_CMP_MASKED_EQ",
    "value": 4294967295,
    "valueTwo": 1075599392
  }]
}
```

Allow required safe ioctl requests individually with exact `SCMP_CMP_EQ` values within the unsigned 32-bit range. Do not use an unconditional ioctl allowance or several exclusions on the same argument. Libseccomp permits one comparison per argument in a rule; an exact whitelist avoids that invalid construction. Preserve Docker's existing restricted syscall allowances and add the quota protections through a reviewed profile. Do not broaden the profile to work around a browser startup failure. [Libseccomp rule documentation](https://raw.githubusercontent.com/seccomp/libseccomp/main/doc/man/man3/seccomp_rule_add.3)

The worker verifies the profile's owner, modes, contents, architecture, and quota-specific rules, then returns its absolute path and SHA-256 digest. Sandbox startup passes that path as `--security-opt seccomp=<path>`. The operator must keep the profile immutable to the service and must not change it while workers run. The worker itself is outside the sandbox and needs the read-only `FS_IOC_FSGETXATTR` operation to inspect project attributes.

## Read-only proof and its limits

The implementation invokes root-owned, non-service-writable regular executables at `/usr/bin/findmnt`, `/usr/sbin/xfs_io`, and `/usr/sbin/xfs_quota`, with fixed arguments, no shell, a scrubbed environment, 2-second query timeouts, and bounded output. The distribution must provide these exact paths. The queries inspect:

- `findmnt --json --target <workspace> --output TARGET,SOURCE,FSTYPE,OPTIONS,FSROOT,MAJ:MIN`
- `xfs_quota -x -D /dev/null -P /dev/null -c 'state -p' <mount>`
- `xfs_quota -D /dev/null -P /dev/null -c 'quota -p -b -n -N -v <project-id>' <mount>`
- The corresponding `quota -p -i -n -N -v` inode query.
- `xfs_io -r -c stat /proc/self/fd/<pinned-directory-fd>` and descriptor-based read-only inode attribute checks. [XFS I/O documentation](https://man7.org/linux/man-pages/man8/xfs_io.8.html)

All directory components are opened without following symlinks. The verifier scans existing inodes, rejects special files and mount crossings, and checks the directory identity before and after querying. It rereads enforcement, hard limits, mount identity, registry assignment, and seccomp configuration before admitting the container. Tree scanning is bounded to 2 seconds, 64 levels, and the assigned inode limit; the complete asynchronous proof has an 8-second budget. A proof timeout blocks admission. Tree counts bound inspection work; they do not replace kernel quota enforcement.

Readiness/proof metadata always reports `kernel_live_write_tested: false`. The deterministic tests simulate XFS query and ioctl contracts while walking real temporary directories; they do not prove live kernel enforcement, filter loading, many-writer `EDQUOT`, or Chromium startup. Authorized live validation must cover aggregate byte and inode exhaustion across many files and background writers, refusal to clear project inheritance/change project IDs (including raw/high-word ioctl aliases), persistence after restart, isolation between projects, and normal browser operation under the deployed profile. Do not claim the local bundle or cloud computer tools are operational until those checks pass on the actual provisioned backend.
