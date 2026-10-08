> Historical XFS/root-broker design, unselected by the active runtime. NewsCraft now owns its provider-neutral loop and has a concrete rootless OCI terminal/filesystem adapter; see [current executor setup](executor.md). The managed Agents API is also unselected. Requirements and recommendations below describe the earlier broker design, not the current deployment path.

# Production computer lifecycle still requires implementation

The owned agent and disposable test computer are implemented. The direct production
XFS/Docker backend does **not** yet work with the hardened system service. It
requires the same mount namespace and root dockerd procfs inspection; PrivateTmp,
PrivateDevices and ProtectSystem can create a different namespace. No service
hardening was removed, and no new permissions were applied.

`production_admission.deployment_readiness()` therefore fails deployment readiness
even when a manually enrolled sample passes XFS checks. Normal new conversations
need automatic enrollment; manual per-chat administration is not a finished product.

The strict client contract in `production_admission.py` specifies `enroll`, `attest`
and non-destructive `retire`. The authenticated local **client transport is now
implemented**: Linux AF_UNIX, root-owned path and live root peer, unchanged socket
identity, 64 KiB unique-key JSON frames, five-second request bound and cancellation
cleanup. It does not start or install a server. The root broker/server and sandbox
adapter remain **unimplemented code**, in addition to infrastructure.
The service cannot become ready merely by setting a socket environment variable.

Required broker lifecycle:

1. Authenticate the service UID on a root-owned local Unix socket; bound requests
   to 64 KiB and five seconds. Verify server-generated tenant, conversation, scope
   and fixed approved roots. Never accept shell commands, arbitrary paths or
   model-provided project IDs. Replay nonces and wrong account bindings reject.
2. Under a scope lock, enroll idempotently with a unique project per conversation,
   inherited IDs and hard byte/inode limits before any computer or model dispatch.
   A crash must leave either a complete verified assignment or an unavailable
   scope. Broker-owned registry updates must be atomic and outside model mounts.
3. Attest exact worker-view and daemon-view directory device/inode/project identity
   across namespaces, using trusted pinned descriptors and daemon peer identity.
   This replaces the direct namespace-equality assumption only when an implemented
   adapter consumes authenticated attestations on every container admission.
4. Preserve the approved default-deny security policy, no guest network, no host
   credentials or socket, resource bounds and browser/terminal UID separation.
   Operator privilege belongs only to a reviewed narrow broker, never the worker.
5. Retire only after the durable lifecycle lease proves no active run. Preserve
   files; deletion and project reuse need separate owner-approved policy.

XFS and namespace equality are implementation choices for the current bind-mount
backend. Intrinsic requirements are tenant/conversation isolation, enforceable
aggregate storage bounds, correct filesystem identity, controlled network/secrets,
trusted lifecycle ownership and cleanup. A provider-managed isolated VM with
bounded storage and persistence could implement the same contract without local
XFS or dockerd procfs. That requires a reviewed backend adapter, not a second
model runtime or a Hermes toggle. No such adapter or broker is deployed here.

## Exact decision and blocker classification

Local code does not need further permission. The missing choice is where the
production computer runs; the repository has not established a suitable Linux
quota layout or approved a managed sandbox provider for this project.

| Component | Exact remaining blocker |
| --- | --- |
| Root enrollment broker/server | Remaining local code **if self-hosting is selected**. First settle the Linux host, approved workspace/mount roots, byte/inode policy, service UID and narrowly permitted quota operations. Installing it or granting privileges is a separate security/deployment approval. |
| Hardened-service computer adapter | Remaining local code, dependent on the same backend choice. A broker adapter needs authenticated scoped lifecycle and computer execution; a managed adapter needs provider SDK lifecycle, browser IPC, persistence and bounded exports. Merely accepting attestation while executing through the old direct namespace check is insufficient. |
| Contabo suitability | Missing external facts/access, not a code permission. Repository evidence does not verify current OS, mounts, daemon, image or service. Obtain an operator-generated read-only receipt before selecting it. |
| Managed sandbox adapter | Missing provider/product decision, then remaining local code. Before API-dependent integration, establish project/account access and credential reuse authorization; provisioning and paid compute are separate. No provider account was inspected or chosen. |
| Disposable test execution | Code and fixture tests completed. Exact existing Docker socket/image and fresh private report layout still need selection. Actual container/Chromium/storage-exhaustion execution is unrun; paid mode additionally requires explicit API-call approval. |

Recommendation: evaluate a managed isolated computer as the production adapter,
while keeping the owned model loop and NewsCraft control plane. This reduces the
custom privileged quota/procfs broker burden, at the cost of provider dependency,
compute/storage charges and a new lifecycle/browser transport integration.
Vercel Sandbox is a candidate because NewsCraft already targets Vercel; its docs
describe isolated microVMs, persistence and deny-all networking. Existing Vercel
deployment configuration does **not** prove Sandbox access or credentials.
[Sandbox](https://vercel.com/docs/sandbox),
[firewall](https://vercel.com/docs/sandbox/concepts/firewall).

Self-hosting retains direct infrastructure control and avoids a new sandbox
provider, but requires the privileged server, storage enrollment and audited
namespace-aware adapter. These backend-specific implementations should follow
the choice rather than silently impose a new root service or provider.
