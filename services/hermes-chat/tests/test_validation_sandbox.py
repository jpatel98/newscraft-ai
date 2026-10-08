"""Deterministic disposable backend checks; never start Docker or Chromium."""
import ast
import copy
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from hermes_chat.isolation import TenantIsolation
from hermes_chat.live_validation_fixture import ALLOWED_URLS, SyntheticFixture
from hermes_chat.sandbox import SandboxError
from hermes_chat.validation_sandbox import DisposableValidationSandbox, _BOUND_PROOF
from hermes_chat.sandbox import _IMAGE_CONTRACT


class ValidationSandboxTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name).resolve()
        isolation = TenantIsolation(root/'state', root/'workspace')
        self.runtime = isolation.ensure(isolation.resolve('validation-contract','validation-contract'))
        for folder in ('outputs','browser-screenshots'):
            (self.runtime.workspace/folder).mkdir(mode=0o700)
        self.socket_patch = patch.object(DisposableValidationSandbox, '_check_socket', return_value=(1,2,os.getuid()))
        self.socket_patch.start()
        self.computer = DisposableValidationSandbox(self.runtime, 'validation-contract', docker_socket='/private/tmp/fake.sock',
            image='fixture:reviewed', resource_fetcher=SyntheticFixture().fetch, allowed_urls=ALLOWED_URLS, synthetic_fixture=True)
        self.computer._image_id='sha256:'+'a'*64

    def tearDown(self):
        self.socket_patch.stop()
        self.temp.cleanup()

    def inspect_data(self):
        argv = self.computer._run_argv()
        tmpfs = dict(a.split(':',1) for i,a in enumerate(argv) if i and argv[i-1]=='--tmpfs')
        return {'Image':self.computer._image_id, 'Config': {'Labels': {'newscraft.managed':'disposable-validation','newscraft.scope': self.runtime.task_key},
                          'User': f'{os.getuid()}:{os.getgid()}'},
            'HostConfig': {'NetworkMode':'none','ReadonlyRootfs':True,'Privileged':False,'CapDrop':['ALL'],
                'SecurityOpt':['no-new-privileges'],'Memory':768*1024*1024,'MemorySwap':768*1024*1024,
                'NanoCpus':1000000000,'PidsLimit':128,'ShmSize':64*1024*1024,'Tmpfs':tmpfs},
            'Mounts': [], 'State': {'Running':True}}

    async def test_pins_explicit_socket_and_empty_config_without_global_context(self):
        argv = await self.computer._argv(['docker','exec',self.computer.name,'python3','-I','-c','print(1)'], config_dir=Path('/private/tmp/issued'))
        self.assertEqual(argv[:5], ['docker','--config','/private/tmp/issued','--host','unix:///private/tmp/fake.sock'])
        for candidate in (['docker','--host','tcp://bad'], ['docker','run','--context=bad']):
            with self.assertRaises(SandboxError):
                await self.computer._argv(candidate, config_dir=Path('/private/tmp/issued'))
        with patch.object(self.computer,'_check_socket', return_value=(1,3,os.getuid())), self.assertRaises(SandboxError):
            await self.computer._argv(['docker','inspect','fixture'], config_dir=Path('/private/tmp/issued'))

    def test_no_host_mounts_and_exact_container_resource_limits(self):
        argv = self.computer._run_argv()
        self.assertNotIn('--mount',argv)
        self.assertNotIn('--volume',argv)
        self.assertNotIn(str(self.runtime.workspace), '\n'.join(argv))
        self.assertIn('--pull=never',argv)
        self.assertIn(self.computer._image_id,argv)
        self.computer._verify_inspect(self.inspect_data())
        alterations = [('Privileged',True), ('NetworkMode','bridge'), ('ReadonlyRootfs',False),
            ('Memory',0), ('MemorySwap',-1), ('PidsLimit',-1), ('NanoCpus',0), ('ShmSize',0),
            ('Binds',['/host:/workspace']), ('Devices',[{}]), ('CapAdd',['SYS_ADMIN']),
            ('SecurityOpt',['no-new-privileges','seccomp=unconfined'])]
        for key,value in alterations:
            data=self.inspect_data(); data['HostConfig'][key]=value
            with self.subTest(key=key),self.assertRaises(SandboxError): self.computer._verify_inspect(data)
        for mount in ({'Type':'bind','Destination':'/workspace'}, {'Type':'volume','Destination':'/secret'}):
            data=self.inspect_data(); data['Mounts']=[mount]
            with self.assertRaises(SandboxError): self.computer._verify_inspect(data)
        data=self.inspect_data(); data['HostConfig']['Tmpfs']['/workspace']='size=0'
        with self.assertRaises(SandboxError): self.computer._verify_inspect(data)

    async def test_prepare_never_reclaims_production_scope(self):
        with patch.object(self.computer,'_process',new_callable=AsyncMock) as process:
            await self.computer.prepare()
            process.assert_not_awaited()
        browser=self.computer._make_browser({'storage':{},'input_tainted':False,'last_url':''})
        self.assertEqual(browser._docker_argv_builder,self.computer._argv)
        self.assertEqual(browser.browser_uid,os.getuid()+65536)

    async def test_cleanup_only_removes_its_verified_disposable_container(self):
        self.computer._started=True
        with patch.object(self.computer,'_process',new_callable=AsyncMock) as process:
            process.return_value=(0,json.dumps({'newscraft.managed':'research-agent','newscraft.scope':self.runtime.task_key}),'')
            with self.assertRaisesRegex(SandboxError,'unowned'):await self.computer._remove()
            self.assertEqual(process.await_count,1)
            process.reset_mock()
            process.side_effect=[(0,json.dumps({'newscraft.managed':'disposable-validation','newscraft.scope':self.runtime.task_key}),''),(0,'','')]
            await self.computer._remove()
            self.assertFalse(self.computer._started)
            self.assertEqual(process.await_args_list[-1].args[0],['docker','rm','--force',self.computer.name])

    async def test_image_is_pinned_and_tag_cannot_change_container_identity(self):
        identity='sha256:'+'b'*64
        with patch.object(self.computer,'_process',new_callable=AsyncMock,
                return_value=(0,json.dumps({'Id':identity,'Config':{'Labels':_IMAGE_CONTRACT}}),'')):
            await self.computer._image_manifest('fixture:reviewed')
        self.assertEqual(self.computer._image_id,identity)
        data=self.inspect_data();data['Image']='sha256:'+'c'*64
        with self.assertRaisesRegex(SandboxError,'immutable'):self.computer._verify_inspect(data)
        with patch.object(self.computer,'_process',new_callable=AsyncMock,
                return_value=(0,json.dumps({'Id':identity,'Config':{'Labels':{}}}),'')):
            with self.assertRaises(SandboxError):await self.computer._image_manifest('fixture:reviewed')

    async def test_start_requires_inspection_and_exhaustion_and_cleans_failure(self):
        with patch.object(self.computer,'_image_manifest',new_callable=AsyncMock), \
             patch.object(self.computer,'_process',new_callable=AsyncMock) as process, \
             patch.object(self.computer,'_exec_json',new_callable=AsyncMock) as proof, \
             patch.object(self.computer,'_remove',new_callable=AsyncMock) as remove:
            process.side_effect=[(0,'',''),(0,json.dumps([self.inspect_data()]),'')]
            proof.return_value={'byte_exhaustion':False,'inode_exhaustion':True}
            with self.assertRaisesRegex(SandboxError,'enforcement'): await self.computer._start()
            remove.assert_awaited_once()
            proof.assert_awaited_once()

    def test_guest_and_nested_writer_programs_compile_without_running(self):
        tree=ast.parse(_BOUND_PROOF)
        compile(tree,'bounds','exec')
        child=[n.value for n in ast.walk(tree) if isinstance(n,ast.Constant) and isinstance(n.value,str) and n.value.startswith('import errno,sys')]
        self.assertEqual(len(child),1)
        compile(child[0],'bounded-child','exec')
        self.assertIn('errno.ENOSPC',child[0])

    def test_exports_are_bounded_declared_bytes_and_reject_symlinks(self):
        self.computer._export('outputs','brief.md',b'fixture')
        self.assertEqual((self.runtime.workspace/'outputs/brief.md').read_bytes(),b'fixture')
        for folder,name,data in [('outside','secret',b'x'),('outputs','../escape',b'x'),
            ('outputs','large',b'x'*(1048576+1)),('outputs','brief.md',b'replace')]:
            with self.assertRaises(SandboxError): self.computer._export(folder,name,data)
        (self.runtime.workspace/'outputs/planted.md').symlink_to(self.runtime.hermes_home/'checkpoint')
        with self.assertRaises(FileExistsError): self.computer._export('outputs','planted.md',b'x')
        self.assertFalse((self.runtime.hermes_home/'checkpoint').exists())
        self.computer._export_bytes=20*1024*1024
        with self.assertRaises(SandboxError): self.computer._save_screenshot(b'png')

    def test_non_synthetic_or_other_allowlist_is_rejected(self):
        for synthetic,urls in ((False,ALLOWED_URLS),(True,{'https://example.com'})):
            with self.assertRaises(SandboxError):
                DisposableValidationSandbox(self.runtime,'validation-contract',docker_socket='/private/tmp/fake.sock',
                    image='fixture',resource_fetcher=SyntheticFixture().fetch,allowed_urls=urls,synthetic_fixture=synthetic)
