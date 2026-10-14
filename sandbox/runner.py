"""Runs only INSIDE disposable sandboxes. No GitHub credentials are provided."""
import base64
import hashlib
import json
import os
import pathlib
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time

ROOT = pathlib.Path('/tmp/kangentix')
REPO = ROOT / 'repo'
MAX_FILE = 5 * 1024 * 1024
MAX_TRANSFER = 20 * 1024 * 1024
LOG_SECRETS = []


def redact(message):
    for secret in LOG_SECRETS:
        message = message.replace(secret, '[redacted]')
        message = message.replace(json.dumps(secret, ensure_ascii=False)[1:-1], '[redacted]')
    return message


def excerpt(message, limit):
    # Redact the complete value first: truncating inside a credential would leak its prefix.
    message = redact(str(message)).replace('\r', '\\r').replace('\n', '\\n')
    message = ''.join(c if ord(c) >= 32 and ord(c) != 127 else '?' for c in message)
    return message if len(message) <= limit else message[:limit] + ' … [truncated]'


def emit(message):
    print(redact(str(message)), flush=True)


def path_for(name):
    parts = name.split('/')
    if (not name or '\\' in name or any(ord(c) < 32 or ord(c) == 127 for c in name)
            or any(not p or p in ('.', '..') or p.lower() == '.git' for p in parts)):
        raise RuntimeError('Unsafe repository path')
    path = REPO.joinpath(*parts)
    for parent in path.parents:
        if parent == REPO:
            break
        if parent.is_symlink():
            raise RuntimeError('Repository path traverses a symbolic link')
    return path


def git(*args):
    env = dict(os.environ, GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', GIT_TERMINAL_PROMPT='0')
    return subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', str(REPO), *args], env=env)


def prepare():
    REPO.mkdir()
    total = 0
    with tarfile.open(ROOT / 'repository.tar.gz', 'r|gz') as archive:
        links = []
        for count, entry in enumerate(archive, 1):
            if count > 60000:
                raise RuntimeError('Repository archive contains too many entries')
            pieces = pathlib.PurePosixPath(entry.name).parts
            if len(pieces) < 2:
                continue
            path = path_for('/'.join(pieces[1:]))
            if entry.isdir():
                path.mkdir(parents=True, exist_ok=True)
            elif entry.isfile():
                total += entry.size
                if total > 500 * 1024 * 1024:
                    raise RuntimeError('Repository exceeds 500 MiB expanded limit')
                path.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(entry) as source, path.open('wb') as target:
                    while True:
                        chunk = source.read(1024 * 1024)
                        if not chunk:
                            break
                        target.write(chunk)
                path.chmod(0o755 if entry.mode & 0o111 else 0o644)
            elif entry.issym():
                links.append((path, entry.linkname))
            else:
                raise RuntimeError('Unsupported repository archive entry')
        for path, target in links:
            if (not target or '\\' in target or any(ord(c) < 32 or ord(c) == 127 for c in target)
                    or any(p.lower() == '.git' for p in target.split('/'))
                    or target.startswith('/') or not (path.parent / target).resolve().is_relative_to(REPO)):
                raise RuntimeError('Repository symbolic link leaves checkout')
            # Earlier archive symlinks may have changed this path's ancestors.
            path = path_for(path.relative_to(REPO).as_posix())
            path.parent.mkdir(parents=True, exist_ok=True)
            path.symlink_to(target)
    git('init', '-q')
    git('add', '--all')
    git('-c', 'user.name=Kangentix', '-c', 'user.email=kangentix@localhost', 'commit', '--allow-empty', '-qm', 'Fresh base snapshot')
    config = json.loads((ROOT / 'input.json').read_text())
    for artifact in config['documents']:
        target = path_for(artifact['path'])
        if target.is_symlink():
            raise RuntimeError('Artifact destination must not be a symbolic link')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(artifact['content'])
    for image in config.get('images', []):
        target = path_for(image['path'])
        if target.is_symlink():
            raise RuntimeError('Image destination must not be a symbolic link')
        content = base64.b64decode(image['content'], validate=True)
        if not content or len(content) > 2 * 1024 * 1024:
            raise RuntimeError('Ticket image exceeds its size limit')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    emit('Fresh base snapshot ready; ticket documents and images loaded.')


def run():
    config = json.loads((ROOT / 'input.json').read_text())
    provider = config.get('modelProvider')
    if provider not in ('ollama', 'claude'):
        raise RuntimeError('Select a valid model provider')
    provider_name = 'Claude' if provider == 'claude' else 'Ollama Cloud'
    api_key = config.get('apiKey')
    if not isinstance(api_key, str) or not api_key.strip():
        raise RuntimeError('Add a ' + provider_name + ' API key')
    LOG_SECRETS.append(api_key)
    model = config.get('model')
    if (not isinstance(model, str) or not model.strip() or len(model) > 150
            or any(ord(c) < 32 for c in model)):
        raise RuntimeError('Set a valid ' + provider_name + ' model')
    env = dict(os.environ)
    # A custom image must not override the project's selected provider or credential.
    for name in (
        'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
        'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_OAUTH_TOKEN',
        'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
        'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_AWS',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
        'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_MODEL',
        'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL',
    ):
        env.pop(name, None)
    if provider == 'ollama':
        env.update({
            'ANTHROPIC_BASE_URL': 'https://ollama.com',
            'ANTHROPIC_AUTH_TOKEN': api_key,
            'ANTHROPIC_DEFAULT_HAIKU_MODEL': model,
            'ANTHROPIC_DEFAULT_SONNET_MODEL': model,
            'ANTHROPIC_DEFAULT_OPUS_MODEL': model,
        })
    else:
        env.update({
            'ANTHROPIC_BASE_URL': 'https://api.anthropic.com',
            'ANTHROPIC_API_KEY': api_key,
        })
    env.update({
        'ANTHROPIC_MODEL': model,
        'DISABLE_TELEMETRY': '1', 'DISABLE_ERROR_REPORTING': '1',
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1',
        'CLAUDE_CONFIG_DIR': '/tmp/kangentix-claude',
    })
    args = ['claude', '-p', '--bare', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--dangerously-skip-permissions', '--max-turns', '80', '--model', config['model'], '--add-dir', str(ROOT)]
    if not config['implement']:
        # No Bash or file mutation tools exist in definition sessions. The final JSON is the only persisted output.
        args += ['--tools', 'Read,Glob,Grep']
    # Give agent commands a headless display when the image provides Xvfb.
    # It stays in the agent process group so cancellation also stops the display.
    if not env.get('DISPLAY') and shutil.which('xvfb-run'):
        args = ['xvfb-run', '--auto-servernum',
                '--server-args=-screen 0 1280x800x24 -nolisten tcp', *args]
    # A pipe write can block forever before the execution deadline is checked.
    with tempfile.TemporaryFile() as prompt:
        prompt.write(config['prompt'].encode())
        prompt.seek(0)
        child = subprocess.Popen(args, cwd=REPO, env=env, stdin=prompt,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 start_new_session=True)
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ, 'stdout')
    selector.register(child.stderr, selectors.EVENT_READ, 'stderr')
    for stream in (child.stdout, child.stderr):
        os.set_blocking(stream.fileno(), False)
    pending = {'stdout': bytearray(), 'stderr': bytearray()}
    final = None
    size = 0
    deadline = time.monotonic() + config['timeoutSeconds']
    tool_names = {}
    activity_count = 0
    activity_bytes = 0
    activity_omitted = False

    def activity(message):
        nonlocal activity_count, activity_bytes, activity_omitted
        message = excerpt(message, 4000)
        if activity_count >= 200 or activity_bytes + len(message.encode()) > 128 * 1024:
            if not activity_omitted:
                emit('Further agent activity details omitted after the execution log limit; final result will still be recorded.')
                activity_omitted = True
            return
        activity_count += 1
        activity_bytes += len(message.encode())
        emit(message)

    def result_text(content):
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            # Images, binary attachments, and hidden reasoning are never execution log text.
            return '\n'.join(block['text'] for block in content
                             if isinstance(block, dict) and block.get('type') == 'text'
                             and isinstance(block.get('text'), str))
        return ''

    def consume(raw, stream):
        nonlocal final
        line = raw.decode('utf-8', errors='replace')
        if stream == 'stderr':
            activity('Agent stderr: ' + excerpt(line.rstrip(), 2000))
            return
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            activity('Agent output: ' + excerpt(line.rstrip(), 1000))
            return
        if not isinstance(event, dict):
            return
        if event.get('type') == 'result':
            final = event
        elif event.get('type') in ('assistant', 'user'):
            message = event.get('message')
            content = message.get('content', []) if isinstance(message, dict) else []
            if not isinstance(content, list):
                return
            for block in content:
                if not isinstance(block, dict):
                    continue
                if event['type'] == 'assistant' and block.get('type') == 'text':
                    if isinstance(block.get('text'), str) and block['text'].strip():
                        activity('Agent: ' + excerpt(block['text'].strip(), 2500))
                elif event['type'] == 'assistant' and block.get('type') == 'tool_use':
                    name = str(block.get('name') or 'unknown')
                    if isinstance(block.get('id'), str):
                        tool_names[block['id']] = name
                    inputs = block.get('input', {})
                    # Command descriptions, shell commands, file paths, and edit inputs are visible.
                    details = json.dumps(inputs, ensure_ascii=False)
                    activity('Agent tool: ' + name + ' — ' + excerpt(details, 3500))
                elif event['type'] == 'user' and block.get('type') == 'tool_result':
                    tool_id = block.get('tool_use_id')
                    name = tool_names.pop(tool_id, 'unknown') if isinstance(tool_id, str) else 'unknown'
                    status = 'error' if block.get('is_error') else 'completed'
                    output = result_text(block.get('content'))
                    activity('Agent tool ' + name + ' ' + status
                             + (': ' + excerpt(output, 2000) if output.strip() else '.'))
        elif event.get('type') == 'system' and event.get('subtype') == 'init':
            emit('Claude Code connected to ' + provider_name + '.')

    try:
        while selector.get_map():
            if time.monotonic() > deadline:
                raise RuntimeError('Agent execution exceeded its time limit')
            for key, _ in selector.select(timeout=1):
                chunk = os.read(key.fd, 64 * 1024)
                if not chunk:
                    selector.unregister(key.fileobj)
                    if pending[key.data]:
                        consume(pending[key.data], key.data)
                        pending[key.data].clear()
                    continue
                size += len(chunk)
                if size > 16 * 1024 * 1024:
                    raise RuntimeError('Agent output exceeded 16 MiB')
                buffer = pending[key.data]
                buffer.extend(chunk)
                lines = buffer.split(b'\n')
                pending[key.data] = lines.pop()
                for line in lines:
                    consume(line, key.data)
        code = child.wait(timeout=max(0.1, deadline - time.monotonic()))
        if code != 0 or final is None or final.get('is_error'):
            detail = (final or {}).get('result') or (final or {}).get('errors') or f'exit {code}; no successful result'
            raise RuntimeError('Agent failed: ' + excerpt(detail, 3000))
        result = final.get('result', '').strip()
        if result.startswith('```'):
            result = result.split('\n', 1)[1].rsplit('```', 1)[0].strip()
        try:
            answer = json.loads(result)
        except json.JSONDecodeError:
            if config['implement']:
                answer = {'reply': result}
            else:
                raise RuntimeError('Agent did not return the required JSON reply/artifact format; rerun or choose a tool-capable model')
        if not isinstance(answer, dict) or not isinstance(answer.get('reply'), str) or not answer['reply'].strip():
            raise RuntimeError('Agent response has no reply')
        if len(json.dumps(answer).encode()) > 1024 * 1024:
            raise RuntimeError('Agent reply exceeds 1 MiB')
        (ROOT / 'result.json').write_text(json.dumps(answer))
        emit('Agent response complete.')
    finally:
        selector.close()
        # Terminate shell commands/background descendants too before exporting files.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()
        child.stdout.close()
        child.stderr.close()


def export():
    baseline = {item['path']: item for item in json.loads((ROOT / 'base.json').read_text())}
    # Include tracked paths even if the agent changed HEAD, and honor ignore rules for new dependency/build directories.
    extra = git('ls-files', '--cached', '--others', '--exclude-standard', '-z').decode().split('\0')
    names = set(baseline) | {name for name in extra if name}
    result = []
    total = 0
    for name in sorted(names):
        path = path_for(name)
        original = baseline.get(name)
        try:
            info = path.lstat()
        except FileNotFoundError:
            if original:
                result.append({'path': name, 'mode': original['mode'], 'content': None})
            continue
        if stat.S_ISLNK(info.st_mode):
            content = os.readlink(path).encode()
            mode = '120000'
        elif stat.S_ISREG(info.st_mode):
            if info.st_size > 100 * 1024 * 1024:
                raise RuntimeError('Repository file exceeds 100 MiB')
            content = path.read_bytes()
            mode = '100755' if info.st_mode & 0o111 else '100644'
        elif stat.S_ISDIR(info.st_mode) and original:
            # Replacing a file with a directory requires deletion of the old tree leaf.
            result.append({'path': name, 'mode': original['mode'], 'content': None})
            continue
        else:
            raise RuntimeError('Unsupported output file type')
        digest = hashlib.sha1(f'blob {len(content)}\0'.encode() + content).hexdigest()
        if original and original['sha'] == digest and original['mode'] == mode:
            continue
        total += len(content)
        if len(content) > MAX_FILE or total > MAX_TRANSFER or len(result) >= 500:
            raise RuntimeError('Implementation exceeds transfer limits: 500 files, 5 MiB/file, 20 MiB total')
        result.append({'path': name, 'mode': mode, 'content': base64.b64encode(content).decode()})
    (ROOT / 'changes.json').write_text(json.dumps(result))
    emit(f'Collected {len(result)} changed files.')


if __name__ == '__main__':
    try:
        {'prepare': prepare, 'run': run, 'export': export}[sys.argv[1]]()
    except Exception as error:
        emit(str(error))
        sys.exit(1)
