"""Trusted production computer lifecycle contract, outside model authority.

The root broker/server and production transport adapter are not shipped. A
pre-enrolled sample must therefore never advertise deployment readiness. This
client specifies the bounded interface an operator must implement and review;
it does not grant privileges, administer quotas, or bypass direct admission.
"""
from __future__ import annotations

import secrets
import asyncio
import json
import os
import socket
import stat
import struct
import sys
from pathlib import Path
from typing import Any, Callable

VERSION = 1
MAX_BYTES = 268435456
MAX_INODES = 10000
MAX_MESSAGE_BYTES = 64 * 1024


class ProductionAdmissionError(RuntimeError):
    pass


def deployment_readiness() -> dict[str, Any]:
    return {'ready': False, 'integration_complete': False,
        'automatic_enrollment': False, 'attestation_transport': False,
        'attestation_client_implemented': True,
        'reason': 'Trusted workspace enrollment broker and hardened-service computer adapter are not implemented',
        'required_operations': ['enroll', 'attest', 'retire'],
        'current_backend': 'direct_same_namespace_xfs',
        'host_permissions_granted': False}


def _unique_object(pairs):
    result = {}
    for key,value in pairs:
        if key in result:
            raise ProductionAdmissionError('Duplicate broker response field')
        result[key]=value
    return result


class TrustedUnixBrokerTransport:
    """Bounded Linux client transport; no privileged server or installation.

    Socket/path and live peer must be root-owned. The five-second request bound,
    64 KiB framing and request binding do not relax production computer checks.
    No automatic environment discovery, credentials or remote TCP fallback.
    """
    def __init__(self, socket_path: str):
        self.path = Path(socket_path)

    def _verify_path(self):
        if (sys.platform != 'linux' or not hasattr(socket,'SO_PEERCRED')
                or not self.path.is_absolute() or '..' in self.path.parts
                or len(str(self.path)) > 100
                or any(p.is_symlink() for p in (self.path,*self.path.parents))):
            raise ProductionAdmissionError('Broker requires a trusted local Linux AF_UNIX path')
        for parent in self.path.parents:
            info=parent.stat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                raise ProductionAdmissionError('Broker socket parent must be root-owned and non-writable')
        info=self.path.stat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o002:
            raise ProductionAdmissionError('Broker socket must be root-owned without public write access')
        return info.st_dev,info.st_ino

    async def __call__(self, request):
        data=json.dumps(request,ensure_ascii=False,allow_nan=False).encode()+b'\n'
        if len(data) > MAX_MESSAGE_BYTES:
            raise ProductionAdmissionError('Broker request exceeds 64 KiB')
        writer=None
        try:
            async with asyncio.timeout(5):
                identity=self._verify_path()
                reader,writer=await asyncio.open_unix_connection(str(self.path),limit=MAX_MESSAGE_BYTES+1)
                peer=writer.get_extra_info('socket')
                if peer is None or peer.family != socket.AF_UNIX:
                    raise ProductionAdmissionError('Broker connection is not AF_UNIX')
                pid,uid,_=struct.unpack('3i',peer.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
                if pid <= 0 or uid != 0 or self._verify_path() != identity:
                    raise ProductionAdmissionError('Broker root peer or socket identity is invalid')
                writer.write(data)
                await writer.drain()
                line=await reader.readline()
                if not line.endswith(b'\n') or len(line) > MAX_MESSAGE_BYTES:
                    raise ProductionAdmissionError('Broker response framing exceeds its bound')
                response=json.loads(line,object_pairs_hook=_unique_object,
                    parse_constant=lambda value: (_ for _ in ()).throw(ProductionAdmissionError('Invalid JSON constant')))
                if not isinstance(response,dict) or self._verify_path() != identity:
                    raise ProductionAdmissionError('Broker response or socket identity is invalid')
                return response
        except (OSError, ValueError, TimeoutError, struct.error) as exc:
            raise ProductionAdmissionError('Broker transport unavailable or invalid') from exc
        finally:
            if writer is not None:
                writer.close()
                try:
                    await asyncio.wait_for(writer.wait_closed(),timeout=0.25)
                except (OSError,TimeoutError):
                    writer.transport.abort()


class ProductionAdmissionClient:
    """Strict scoped requests for a future authenticated local root broker.

    `exchange` is trusted host integration, never a model tool or environment
    callback. It must authenticate a root-owned local Unix socket and root peer,
    bound messages to 64 KiB/5 seconds and reject duplicate JSON keys. It must
    not copy credentials, accept arbitrary commands, or implement a generic
    privileged filesystem interface. TrustedUnixBrokerTransport implements the
    local client; no server is installed or connected by this package.
    """

    def __init__(self, exchange: Callable | None = None):
        self.exchange = exchange

    async def enroll(self, runtime):
        return await self._request('enroll', runtime)

    async def attest(self, runtime):
        return await self._request('attest', runtime)

    async def retire(self, runtime):
        # Caller must hold the conversation lifecycle lease and confirm no run
        # is active. Broker retirement is non-destructive: no file deletion.
        return await self._request('retire', runtime)

    async def _request(self, operation, runtime):
        if self.exchange is None:
            raise ProductionAdmissionError('Production admission transport is not connected')
        import asyncio
        nonce = secrets.token_hex(32)
        request = {'version': VERSION, 'operation': operation, 'nonce': nonce,
            'tenant': runtime.key, 'conversation': runtime.conversation_id,
            'scope': runtime.task_key, 'workspace': str(runtime.workspace),
            'max_bytes': MAX_BYTES, 'max_inodes': MAX_INODES}
        async with asyncio.timeout(5):
            response = await self.exchange(request)
        if not isinstance(response, dict) or set(response) != {'binding', 'proof'} or response['binding'] != request:
            raise ProductionAdmissionError('Production admission response binding is invalid')
        proof = response['proof']
        if operation == 'retire':
            if proof != {'retired': True, 'data_deleted': False}:
                raise ProductionAdmissionError('Retirement must preserve workspace data')
            return proof
        expected = {'device', 'inode', 'project', 'hard_bytes', 'hard_inodes',
            'enforced', 'inheritance', 'daemon_view_device', 'daemon_view_inode',
            'daemon_identity_verified', 'security_policy_verified'}
        if not isinstance(proof, dict) or set(proof) != expected:
            raise ProductionAdmissionError('Production attestation shape is invalid')
        info = runtime.workspace.stat()
        if (proof['device'] != info.st_dev or proof['inode'] != info.st_ino
                or proof['daemon_view_device'] != info.st_dev or proof['daemon_view_inode'] != info.st_ino
                or type(proof['project']) is not int or proof['project'] <= 0
                or type(proof['hard_bytes']) is not int or not 0 < proof['hard_bytes'] <= MAX_BYTES
                or type(proof['hard_inodes']) is not int or not 0 < proof['hard_inodes'] <= MAX_INODES
                or any(proof[k] is not True for k in ('enforced','inheritance','daemon_identity_verified','security_policy_verified'))):
            raise ProductionAdmissionError('Production path, quota, daemon or security attestation is invalid')
        return proof
