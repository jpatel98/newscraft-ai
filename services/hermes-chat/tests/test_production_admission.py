import copy
import tempfile
import unittest
import asyncio
import json
import socket
import struct
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch
from hermes_chat.isolation import TenantIsolation
from hermes_chat.production_admission import ProductionAdmissionClient, ProductionAdmissionError, deployment_readiness
from hermes_chat.production_admission import TrustedUnixBrokerTransport, MAX_MESSAGE_BYTES

class ProductionAdmissionTests(unittest.IsolatedAsyncioTestCase):
    async def test_transport_checks_root_peer_and_closes_without_real_sockets(self):
        transport=TrustedUnixBrokerTransport('/run/newscraft/broker.sock')
        request={'nonce':'fixture','operation':'attest'}
        peer=SimpleNamespace(family=socket.AF_UNIX,getsockopt=Mock(return_value=struct.pack('3i',42,0,0)))
        writer=SimpleNamespace(get_extra_info=Mock(return_value=peer),write=Mock(),drain=AsyncMock(),
            close=Mock(),wait_closed=AsyncMock(),transport=SimpleNamespace(abort=Mock()))
        reader=SimpleNamespace(readline=AsyncMock(return_value=b'{"binding":{},"proof":{}}\n'))
        with patch.object(transport,'_verify_path',return_value=(1,2)), \
             patch.object(socket,'SO_PEERCRED',17,create=True), \
             patch('asyncio.open_unix_connection',new_callable=AsyncMock,return_value=(reader,writer)):
            response=await transport(request)
            self.assertEqual(set(response),{'binding','proof'})
            self.assertEqual(json.loads(writer.write.call_args.args[0]),request)
            writer.close.assert_called_once()
            peer.getsockopt.return_value=struct.pack('3i',42,501,501)
            writer.write.reset_mock()
            with self.assertRaisesRegex(ProductionAdmissionError,'root peer'):await transport(request)
            writer.write.assert_not_called()

    async def test_transport_rejects_duplicate_oversized_invalid_frames_and_identity_races(self):
        transport=TrustedUnixBrokerTransport('/run/newscraft/broker.sock')
        peer=SimpleNamespace(family=socket.AF_UNIX,getsockopt=Mock(return_value=struct.pack('3i',42,0,0)))
        writer=SimpleNamespace(get_extra_info=Mock(return_value=peer),write=Mock(),drain=AsyncMock(),
            close=Mock(),wait_closed=AsyncMock(),transport=SimpleNamespace(abort=Mock()))
        reader=SimpleNamespace(readline=AsyncMock())
        with patch.object(transport,'_verify_path',return_value=(1,2)) as identity, \
             patch.object(socket,'SO_PEERCRED',17,create=True), \
             patch('asyncio.open_unix_connection',new_callable=AsyncMock,return_value=(reader,writer)) as connection:
            for frame in (b'{"binding":{},"binding":{}}\n',b'{}',b'[]\n',b'{"value":NaN}\n',b' '*MAX_MESSAGE_BYTES+b'\n'):
                reader.readline.return_value=frame
                with self.subTest(frame=frame[:30]),self.assertRaises(ProductionAdmissionError):await transport({})
            connection.reset_mock()
            with self.assertRaisesRegex(ProductionAdmissionError,'64 KiB'):await transport({'data':'x'*MAX_MESSAGE_BYTES})
            connection.assert_not_awaited()
            identity.side_effect=[(1,2),(1,3)]
            writer.write.reset_mock()
            with self.assertRaisesRegex(ProductionAdmissionError,'identity'):await transport({})
            writer.write.assert_not_called()

    async def test_transport_cancellation_closes_pending_connection(self):
        transport=TrustedUnixBrokerTransport('/run/newscraft/broker.sock')
        peer=SimpleNamespace(family=socket.AF_UNIX,getsockopt=Mock(return_value=struct.pack('3i',42,0,0)))
        writer=SimpleNamespace(get_extra_info=Mock(return_value=peer),write=Mock(),drain=AsyncMock(),
            close=Mock(),wait_closed=AsyncMock(),transport=SimpleNamespace(abort=Mock()))
        entered=asyncio.Event()
        async def pending():
            entered.set()
            await asyncio.Future()
        reader=SimpleNamespace(readline=AsyncMock(side_effect=pending))
        with patch.object(transport,'_verify_path',return_value=(1,2)), \
             patch.object(socket,'SO_PEERCRED',17,create=True), \
             patch('asyncio.open_unix_connection',new_callable=AsyncMock,return_value=(reader,writer)):
            task=asyncio.create_task(transport({}))
            await entered.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):await task
            writer.close.assert_called_once()

    async def test_unconnected_production_is_unavailable_even_with_enrolled_sample(self):
        self.assertFalse(deployment_readiness()['ready'])
        self.assertFalse(deployment_readiness()['integration_complete'])
        with self.assertRaises(ProductionAdmissionError):
            await ProductionAdmissionClient().enroll(None)

    async def test_scope_nonce_limits_and_worker_daemon_path_binding(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve()
            isolation=TenantIsolation(root/'state',root/'work')
            runtime=isolation.ensure(isolation.resolve('tenant-a','conversation-a'))
            info=runtime.workspace.stat()
            proof={'device':info.st_dev,'inode':info.st_ino,'project':7,
                'hard_bytes':268435456,'hard_inodes':10000,'enforced':True,'inheritance':True,
                'daemon_view_device':info.st_dev,'daemon_view_inode':info.st_ino,
                'daemon_identity_verified':True,'security_policy_verified':True}
            async def exchange(request): return {'binding':copy.deepcopy(request),'proof':copy.deepcopy(proof)}
            client=ProductionAdmissionClient(AsyncMock(side_effect=exchange))
            self.assertEqual(await client.enroll(runtime),proof)
            self.assertEqual(await client.attest(runtime),proof)
            requests=[call.args[0] for call in client.exchange.await_args_list]
            self.assertNotEqual(requests[0]['nonce'],requests[1]['nonce'])
            self.assertEqual(requests[0]['scope'],runtime.task_key)
            for field,value in [('daemon_view_inode',info.st_ino+1),('enforced',False),('hard_bytes',0),('project',True)]:
                original=proof[field];proof[field]=value
                with self.subTest(field=field),self.assertRaises(ProductionAdmissionError): await client.enroll(runtime)
                proof[field]=original
            async def wrong_scope(request):
                request=copy.deepcopy(request);request['tenant']='tenant-b'
                return {'binding':request,'proof':proof}
            client.exchange=AsyncMock(side_effect=wrong_scope)
            with self.assertRaisesRegex(ProductionAdmissionError,'binding'): await client.attest(runtime)
