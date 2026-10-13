"""Exercise sandbox file boundaries without Docker, credentials, or an agent."""
import base64
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import sys
import pathlib
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'sandbox_runner', pathlib.Path(__file__).resolve().parents[1] / 'sandbox' / 'runner.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class SandboxRunnerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='aira-runner-test-')
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name).resolve()
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        for name, value in [('ROOT', self.root), ('REPO', self.repo), ('LOG_SECRETS', [])]:
            self.enterContext(patch.object(runner, name, value))
        self.enterContext(contextlib.redirect_stdout(io.StringIO()))

    def archive(self, entries):
        self.repo.rmdir()
        with tarfile.open(self.root / 'repository.tar.gz', 'w:gz') as archive:
            for name, content, link in entries:
                entry = tarfile.TarInfo('snapshot/' + name)
                if link is not None:
                    entry.type = tarfile.SYMTYPE
                    entry.linkname = link
                    archive.addfile(entry)
                else:
                    entry.size = len(content)
                    archive.addfile(entry, io.BytesIO(content))
        (self.root / 'input.json').write_text(json.dumps({'documents': [], 'images': []}))

    def agent_config(self, provider='claude'):
        config = {'modelProvider': provider, 'apiKey': 'selected-secret',
                  'model': 'selected-model', 'prompt': 'test prompt',
                  'implement': False, 'timeoutSeconds': 5}
        (self.root / 'input.json').write_text(json.dumps(config))
        return config

    def test_run_rejects_invalid_provider_key_and_model_before_starting_child(self):
        for change, expected in [({'modelProvider': 'invalid'}, 'model provider'),
                                 ({'apiKey': ''}, 'Claude API key'),
                                 ({'model': 'bad\nmodel'}, 'Claude model')]:
            config = self.agent_config()
            config.update(change)
            (self.root / 'input.json').write_text(json.dumps(config))
            with self.subTest(change=change), patch.object(runner.subprocess, 'Popen') as child:
                with self.assertRaisesRegex(RuntimeError, expected):
                    runner.run()
                child.assert_not_called()

    def test_child_launch_clears_inherited_auth_and_provider_selection(self):
        inherited = {'ANTHROPIC_API_KEY': 'stale-key', 'ANTHROPIC_AUTH_TOKEN': 'stale-token',
                     'CLAUDE_CODE_OAUTH_TOKEN': 'stale-oauth', 'CLAUDE_CODE_USE_BEDROCK': '1',
                     'CLAUDE_CODE_USE_VERTEX': '1', 'CLAUDE_CODE_USE_FOUNDRY': '1',
                     'CLAUDE_CODE_USE_AWS': '1', 'ANTHROPIC_CUSTOM_HEADERS': 'Authorization: stale',
                     'ANTHROPIC_DEFAULT_SONNET_MODEL': 'stale-model'}
        for provider in ('ollama', 'claude'):
            self.agent_config(provider)
            with self.subTest(provider=provider), patch.dict(os.environ, inherited), \
                    patch.object(runner.shutil, 'which', return_value=None), \
                    patch.object(runner.subprocess, 'Popen', side_effect=OSError('test launch stopped')) as child:
                with self.assertRaisesRegex(OSError, 'test launch stopped'):
                    runner.run()
                env = child.call_args.kwargs['env']
                key_name = 'ANTHROPIC_API_KEY' if provider == 'claude' else 'ANTHROPIC_AUTH_TOKEN'
                self.assertEqual(env[key_name], 'selected-secret')
                for name in inherited:
                    if name == key_name:
                        continue
                    if provider == 'ollama' and name == 'ANTHROPIC_DEFAULT_SONNET_MODEL':
                        self.assertEqual(env[name], 'selected-model')
                    else:
                        self.assertNotIn(name, env)

    def test_run_real_stub_process_uses_each_provider_and_reports_redacted_output(self):
        executable = self.root / 'claude'
        executable.write_text('#!' + sys.executable + '\n' + """
import json, os, pathlib, sys
pathlib.Path('environment.json').write_text(json.dumps({
    name: os.environ.get(name) for name in
    ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL']
}))
assert sys.stdin.read() == 'test prompt'
assert '--tools' in sys.argv and sys.argv[sys.argv.index('--tools') + 1] == 'Read,Glob,Grep'
print(json.dumps({'type': 'system', 'subtype': 'init'}))
print('selected-secret', file=sys.stderr)
print(json.dumps({'type': 'result', 'result': json.dumps({'reply': 'Done'})}))
""")
        executable.chmod(0o755)
        for provider, endpoint in [('claude', 'https://api.anthropic.com'),
                                   ('ollama', 'https://ollama.com')]:
            self.agent_config(provider)
            output = io.StringIO()
            with self.subTest(provider=provider), \
                    patch.dict(os.environ, {'PATH': str(self.root) + os.pathsep + os.environ.get('PATH', '')}), \
                    patch.object(runner.shutil, 'which', return_value=None), contextlib.redirect_stdout(output):
                runner.run()
            env = json.loads((self.repo / 'environment.json').read_text())
            self.assertEqual(env['ANTHROPIC_BASE_URL'], endpoint)
            self.assertEqual(env['ANTHROPIC_MODEL'], 'selected-model')
            self.assertEqual(env['ANTHROPIC_API_KEY'], 'selected-secret' if provider == 'claude' else None)
            self.assertEqual(env['ANTHROPIC_AUTH_TOKEN'], 'selected-secret' if provider == 'ollama' else None)
            self.assertEqual(json.loads((self.root / 'result.json').read_text()), {'reply': 'Done'})
            self.assertNotIn('selected-secret', output.getvalue())
            self.assertIn('[redacted]', output.getvalue())
            self.assertIn('connected to ' + ('Claude' if provider == 'claude' else 'Ollama Cloud'), output.getvalue())

    def test_paths_reject_traversal_git_metadata_controls_and_symlink_parents(self):
        for name in ['', '/etc/passwd', '../outside', 'a/../b', 'a//b', './a',
                     '.git/config', 'a/.GIT/config', 'a\\b', 'a\nfile', 'a\x7ffile']:
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, 'Unsafe'):
                runner.path_for(name)
        (self.repo / 'linked').symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, 'symbolic link'):
            runner.path_for('linked/outside')
        self.assertEqual(runner.path_for('src/file.ts'), self.repo / 'src/file.ts')

    def test_secrets_are_redacted_before_truncation_and_control_sanitization(self):
        runner.LOG_SECRETS[:] = ['private-token-long', 'quoted"token']
        self.assertEqual(runner.excerpt('private-token-long', 10), '[redacted]')
        self.assertEqual(runner.redact('quoted\\"token'), '[redacted]')
        self.assertEqual(runner.excerpt('a\n\r\x00\x7fb', 100), 'a\\n\\r??b')

    def test_prepare_blocks_archive_path_escape(self):
        self.archive([('../outside', b'bad', None)])
        with self.assertRaisesRegex(RuntimeError, 'Unsafe'):
            runner.prepare()
        self.assertFalse((self.root / 'outside').exists())

    def test_prepare_blocks_absolute_and_escaping_symlinks(self):
        for target in ['/etc/passwd', '../../outside', '.git/config']:
            with self.subTest(target=target):
                if self.repo.exists():
                    self.repo.rmdir()
                self.repo.mkdir()
                self.archive([('link', b'', target)])
                with self.assertRaisesRegex(RuntimeError, 'symbolic link leaves checkout'):
                    runner.prepare()

    def test_prepare_rechecks_symlink_ancestors(self):
        self.archive([('directory', b'', 'actual'), ('directory/link', b'', '../safe')])
        with self.assertRaisesRegex(RuntimeError, 'symbolic link'):
            runner.prepare()

    def test_prepare_loads_documents_and_images_on_clean_snapshot(self):
        self.archive([('README.md', b'base', None), ('readme-link', b'', 'README.md')])
        (self.root / 'input.json').write_text(json.dumps({
            'documents': [{'path': 'docs/definition.md', 'content': 'definition'}],
            'images': [{'path': 'images/a.png', 'content': base64.b64encode(b'image').decode()}],
        }))
        runner.prepare()
        self.assertEqual((self.repo / 'readme-link').read_text(), 'base')
        self.assertEqual((self.repo / 'docs/definition.md').read_text(), 'definition')
        self.assertEqual((self.repo / 'images/a.png').read_bytes(), b'image')
        self.assertEqual(runner.git('show', 'HEAD:README.md'), b'base')
        self.assertNotIn(b'docs/definition.md', runner.git('ls-tree', '-r', 'HEAD'))

    def test_prepare_rejects_document_writes_to_symlinks(self):
        self.archive([('original', b'base', None), ('link', b'', 'original')])
        (self.root / 'input.json').write_text(json.dumps({
            'documents': [{'path': 'link', 'content': 'overwrite'}], 'images': [],
        }))
        with self.assertRaisesRegex(RuntimeError, 'destination must not be a symbolic link'):
            runner.prepare()
        self.assertEqual((self.repo / 'original').read_text(), 'base')

    def test_export_reports_content_deletions_modes_and_links_without_unchanged_files(self):
        def baseline(name, content, mode='100644'):
            digest = hashlib.sha1(f'blob {len(content)}\0'.encode() + content).hexdigest()
            return {'path': name, 'sha': digest, 'mode': mode}
        (self.root / 'base.json').write_text(json.dumps([
            baseline('same', b'base'), baseline('changed', b'before'),
            baseline('deleted', b'gone'), baseline('replaced', b'file'),
        ]))
        (self.repo / 'same').write_bytes(b'base')
        (self.repo / 'same').chmod(0o644)
        (self.repo / 'changed').write_bytes(b'after')
        (self.repo / 'changed').chmod(0o755)
        (self.repo / 'replaced').mkdir()
        (self.repo / 'new').write_bytes(b'new')
        (self.repo / 'new').chmod(0o644)
        (self.repo / 'link').symlink_to('new')
        with patch.object(runner, 'git', return_value=b'new\0link\0'):
            runner.export()
        result = {entry['path']: entry for entry in json.loads((self.root / 'changes.json').read_text())}
        self.assertEqual(set(result), {'changed', 'deleted', 'replaced', 'new', 'link'})
        self.assertEqual(result['deleted']['content'], None)
        self.assertEqual(result['replaced']['content'], None)
        self.assertEqual(result['changed']['mode'], '100755')
        self.assertEqual(base64.b64decode(result['changed']['content']), b'after')
        self.assertEqual(result['link']['mode'], '120000')
        self.assertEqual(base64.b64decode(result['link']['content']), b'new')

    def test_export_rejects_oversized_changed_files_without_writing_output(self):
        (self.root / 'base.json').write_text('[]')
        (self.repo / 'large').write_bytes(b'x' * 5)
        with patch.object(runner, 'git', return_value=b'large\0'), patch.object(runner, 'MAX_FILE', 4):
            with self.assertRaisesRegex(RuntimeError, 'transfer limits'):
                runner.export()
        self.assertFalse((self.root / 'changes.json').exists())


if __name__ == '__main__':
    unittest.main()
