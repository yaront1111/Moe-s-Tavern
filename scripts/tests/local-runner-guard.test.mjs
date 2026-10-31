import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFrameDecoder, parseGuestFrame } from '../local-runner/guest-bridge.mjs';

// GUARD containment: as root, guest-supervisor.py's GUARD owns a PID namespace whose init exit makes the kernel kill
// every descendant the job left, setsid, setpgid or double-forked. Root rows run the harness as root of a user namespace
// it creates, so the namespace is real kernel behavior; they skip, with the reason, on a host that refuses one. Each
// process reports its pid and start time, so liveness is read and cleanup kills by recorded pid only, and a sentinel
// running the descendants' own program as the same uid, outside GUARD, must outlive every row.
const SUPERVISOR = fileURLToPath(new URL('../local-runner/guest-supervisor.py', import.meta.url));
const DESC = String.raw`import os, sys, time
start = open('/proc/self/stat').read().rsplit(')', 1)[1].split()[19]
with open(sys.argv[2], 'a') as f:
    f.write('%s %s %s\n' % (sys.argv[1], os.readlink('/proc/self'), start))
if sys.argv[1] == 'reaped':
    sys.exit()
if sys.argv[1] != 'open':
    null = os.open(os.devnull, os.O_RDWR)
    os.dup2(null, 1)
    os.dup2(null, 2)
time.sleep(60)
`;
// The job: a setsid descendant that keeps the output pipes, a setpgid one and two double-forked orphans, one of which
// exits at once; then it waits for the go byte (EOF under run_install and relay) and exits with argv[1] or that signal.
const JOB = String.raw`import os, signal, subprocess, sys, time
how, report, desc = sys.argv[1:4]
nspid = next(line.split()[1:] for line in open('/proc/self/status') if line.startswith('NSpid:'))
start = open('/proc/self/stat').read().rsplit(')', 1)[1].split()[19]
with open(report, 'a') as f:
    f.write('job %s %s %s\n' % (os.readlink('/proc/self'), start, ':'.join(nspid)))
print('ran', flush=True)
run = lambda tag, **options: subprocess.Popen([sys.executable, '-I', '-c', desc, tag, report], **options)
run('open', start_new_session=True)
run('group', process_group=0)
for tag in ('double', 'reaped'):
    if (child := os.fork()) == 0:
        if os.fork() == 0:
            os.execv(sys.executable, [sys.executable, '-I', '-c', desc, tag, report])
        os._exit(0)
    os.waitpid(child, 0)
deadline = time.monotonic() + 20
while len(open(report).readlines()) < 5 and time.monotonic() < deadline:
    time.sleep(0.02)
os.read(0, 1)
if how in ('TERM', 'KILL'):
    os.kill(os.getpid(), getattr(signal, 'SIG' + how))
sys.exit(int(how))
`;
// The harness is the supervisor. via 'guard' starts GUARD as relay() does and then acts: 'go' lets the job finish,
// 'life' closes the life pipe, 'standdown-life' stands down first, 'initkill' SIGKILLs init. It stands down after
// output EOF, as relay() does, and reports the descendants still alive at completion (start-pipe) EOF.
const HARNESS = String.raw`import ctypes, importlib.util, json, os, selectors, signal, subprocess, sys, time
spec = importlib.util.spec_from_file_location('moe_supervisor', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
c, job, desc = json.loads(sys.argv[2]), sys.argv[3], sys.argv[4]
for old, new in c.get('patch', []):
    assert m.GUARD.count(old) == 1, old
    m.GUARD = m.GUARD.replace(old, new)
if c['root']:
    uid, gid = os.getuid(), os.getgid()
    os.unshare(os.CLONE_NEWUSER)
    for name, text in (('setgroups', 'deny'), ('uid_map', '0 %d 1' % uid), ('gid_map', '0 %d 1' % gid)):
        with open('/proc/self/' + name, 'w') as f:
            f.write(text)
    if c.get('nocap') and ctypes.CDLL(None, use_errno=True).prctl(24, 21, 0, 0, 0):  # PR_CAPBSET_DROP CAP_SYS_ADMIN
        raise OSError(ctypes.get_errno(), 'PR_CAPBSET_DROP')
report = os.path.join(c['dir'], 'report')
argv = [sys.executable, '-I', '-c', job, c['how'], report, desc]
sentinel = subprocess.Popen([sys.executable, '-I', '-c', desc, 'sentinel', os.path.join(c['dir'], 'sentinel')], start_new_session=True)
def reports():
    try:
        return {line.split()[0]: line.split()[1:] for line in open(report).read().splitlines()}
    except FileNotFoundError:
        return {}
def alive(pid, start):  # a zombie still counts: init reaps the whole namespace before GUARD can reap init
    try:
        return open('/proc/%s/stat' % pid).read().rsplit(')', 1)[1].split()[19] == start
    except FileNotFoundError:
        return False
def ready(fd, secs=20):
    with selectors.DefaultSelector() as selector:
        selector.register(fd, selectors.EVENT_READ)
        return bool(selector.select(secs))
r, began = {}, time.monotonic()
if c['via'] == 'guard':
    life, life_end = os.pipe()
    start_end, start = os.pipe()
    go, go_end = os.pipe()
    guard = subprocess.Popen([sys.executable, '-I', '-B', '-c', m.GUARD, str(life), str(start), '{}', *argv], stdin=go,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, pass_fds=(life, start))
    for fd in (life, start, go):
        os.close(fd)
    r['plus'] = os.read(start_end, 1).decode() if ready(start_end) else 'timeout'
    if r['plus'] == '+':
        deadline = time.monotonic() + 20
        while (len(reports()) < 5 or alive(*reports()['reaped'])) and time.monotonic() < deadline:
            time.sleep(0.02)
        r['orphan_reaped'] = not alive(*reports()['reaped'])  # as pid 1, init reaps an orphan while the job runs
        init = int(open('/proc/%d/task/%d/children' % (guard.pid, guard.pid)).read().split()[0])
        r['fds'] = sorted(map(int, os.listdir('/proc/%s/fd' % reports()['job'][0])))
        r['nulls'] = [os.readlink('/proc/%d/fd/%d' % (pid, fd)) for pid in (guard.pid, init) for fd in (1, 2)]
        if c['act'] == 'standdown-life':
            os.write(life_end, b'0')
        if c['act'] in ('life', 'standdown-life'):
            os.close(life_end)
            life_end = None
        if c['act'] == 'initkill':
            os.kill(init, signal.SIGKILL)
        if c['act'] == 'go':
            os.write(go_end, b'0')
    if life_end is not None:  # as relay() does, stand down once the output pipes reach EOF
        deadline = time.monotonic() + c.get('drain', 10)
        with selectors.DefaultSelector() as selector:
            for pipe in (guard.stdout, guard.stderr):
                selector.register(pipe, selectors.EVENT_READ)
            while selector.get_map() and time.monotonic() < deadline:
                for key, _ in selector.select(deadline - time.monotonic()):
                    if not os.read(key.fd, 65536):
                        selector.unregister(key.fd)
            r['output_eof'] = not selector.get_map()
        try:
            os.write(life_end, b'0')
        except BrokenPipeError:
            pass
    r['start_eof'] = ready(start_end) and os.read(start_end, 1) == b''
elif c['via'] == 'install':
    r['code'] = m.run_install(argv, None, {}, 30)
else:
    r['code'] = m.relay(argv, out_fd=os.open(os.path.join(c['dir'], 'frames'), os.O_WRONLY | os.O_CREAT, 0o600), in_fd=os.pipe()[0])
r['secs'] = time.monotonic() - began
r['alive'] = sorted(tag for tag, (pid, start, *_) in reports().items() if alive(pid, start))
if c['via'] == 'guard':
    r['code'] = guard.wait(20)
r['job'], r['sentinel'] = reports().get('job'), sentinel.poll() is None
for pid, start, *_ in reports().values():
    if alive(pid, start):
        os.kill(int(pid), signal.SIGKILL)
sentinel.kill()
sentinel.wait()
print(json.dumps(r))
`;
const PROBE = String.raw`import os
uid, gid = os.getuid(), os.getgid()
os.unshare(os.CLONE_NEWUSER)
for name, text in (('setgroups', 'deny'), ('uid_map', '0 %d 1' % uid), ('gid_map', '0 %d 1' % gid)):
    with open('/proc/self/' + name, 'w') as f:
        f.write(text)
os.unshare(os.CLONE_NEWPID)
if (pid := os.fork()) == 0:
    os._exit(os.getpid() - 1)
assert os.waitpid(pid, 0)[1] == 0
`;
const NO_NAMESPACE = process.platform !== 'linux' ? 'GUARD containment is Linux-only'
  : (({ status, stderr, error }) => status !== 0 && `this host refuses an unprivileged user and PID namespace: ${String(error ?? stderr).trim().split('\n').at(-1)}`)(
    spawnSync('python3', ['-I', '-c', PROBE], { encoding: 'utf8', timeout: 10_000 }));
const ROOT = { skip: NO_NAMESPACE, timeout: 180_000 };

function run(config) {
  const dir = mkdtempSync(join(tmpdir(), 'moe-guard-'));
  try {
    const harness = spawnSync('python3', ['-I', '-B', '-c', HARNESS, SUPERVISOR, JSON.stringify({ dir, root: true, via: 'guard', act: 'go', ...config }), JOB, DESC],
      { encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL' });
    assert.equal(harness.status, 0, harness.stderr || String(harness.error));
    const result = JSON.parse(harness.stdout);
    if (config.via === 'relay') {
      const decoder = createFrameDecoder();
      result.frames = decoder.push(readFileSync(join(dir, 'frames'))).map(parseGuestFrame);
      decoder.end();
    }
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const levels = r => r.job[2].split(':');

test('G1 a root GUARD runs the job as pid 2 of its own namespace and mirrors exit 0 and 7 only once every descendant is dead', ROOT, () => {
  for (const how of ['0', '7']) {
    const r = run({ how });
    assert.deepEqual([r.plus, r.code, levels(r).length, levels(r)[1]], ['+', Number(how), 2, '2'], how);
    assert.deepEqual([r.orphan_reaped, r.output_eof, r.start_eof, r.alive, r.sentinel], [true, true, true, [], true], how);
    assert.deepEqual(r.fds, [0, 1, 2], 'the job inherits no life, start or status pipe');
    assert.deepEqual(r.nulls, Array(4).fill('/dev/null'), 'neither GUARD nor init holds the output pipes');
  }
});

test('G2 a job killed by SIGTERM or SIGKILL is mirrored as that signal, never as an exit', ROOT, () => {
  for (const [how, code] of [['TERM', -15], ['KILL', -9]]) {
    const r = run({ how });
    assert.deepEqual([r.plus, r.code, r.output_eof, r.start_eof, r.alive, r.sentinel], ['+', code, true, true, [], true], how);
  }
});

test('G3 a supervisor that dies before or after standing down leaves no descendant alive at the completion EOF', ROOT, () => {
  for (const act of ['life', 'standdown-life']) {
    const r = run({ how: '7', act });
    assert.deepEqual([r.plus, r.code, r.start_eof, r.alive, r.sentinel], ['+', -9, true, [], true], act);
  }
});

test('G4 an init killed before it reports the job status makes GUARD die by SIGKILL, never exit 0', ROOT, () => {
  const r = run({ how: '0', act: 'initkill' });
  assert.deepEqual([r.plus, r.code, r.start_eof, r.alive, r.sentinel], ['+', -9, true, [], true]);
});

test('G5 a root GUARD that cannot create its PID namespace never starts the job: no +, exit 1', ROOT, () => {
  for (const config of [{ nocap: true }, { patch: [['os.unshare(os.CLONE_NEWPID)', 'os.unshare_absent(os.CLONE_NEWPID)']] }]) {
    const r = run({ how: '0', ...config });
    assert.deepEqual([r.plus, r.code, r.job, r.alive, r.sentinel], ['', 1, null, [], true], JSON.stringify(config));
  }
});

test('G6 a missing, malformed or oversized job status, or an init that exits non-zero, is never mirrored', ROOT, () => {
  for (const patch of [["os.write(told, b'%d' % reaped[1])", 'pass'], ["b'%d' % reaped[1]", "b'7x'"], ["b'%d' % reaped[1]", "b'123456789'"],
    ['os._exit(0)  # the kernel', 'os._exit(3)  # the kernel']]) {
    const r = run({ how: '7', patch: [patch] });
    assert.deepEqual([r.plus, r.code, r.start_eof, r.alive, r.sentinel], ['+', -9, true, [], true], patch[1]);
  }
});

test('G7 a non-root GUARD is an uncontained import fixture: the same contract, no PID namespace', {
  skip: process.platform !== 'linux' ? 'reads /proc' : process.getuid() === 0 && 'needs a non-root runner', timeout: 60_000 }, () => {
  const r = run({ root: false, how: '7', drain: 1 });
  assert.deepEqual([r.plus, r.code, levels(r).length, r.start_eof, r.sentinel], ['+', 7, 1, true, true]);
  assert.ok(r.alive.includes('open'), 'non-root certifies no containment');
});

test('G8 run_install as root returns only after the job and every descendant are dead: True for 0, False for 3', ROOT, () => {
  for (const [how, ok] of [['0', true], ['3', false]]) {
    const r = run({ how, via: 'install' });
    assert.deepEqual([r.code, levels(r).length, r.alive, r.sentinel], [ok, 2, [], true], how);
  }
});

test('G9 relay as root ends with the job exit 7 observation although a setsid descendant held its output', ROOT, () => {
  const r = run({ how: '7', via: 'relay' });
  assert.deepEqual([r.code, r.alive, r.sentinel, r.secs < 20], [0, [], true, true]);
  assert.deepEqual(r.frames.map(frame => frame.kind), ['hello', 'output', 'observation']);
  assert.deepEqual(r.frames.at(-1), { kind: 'observation', type: 'exit', code: 7, signal: null });
});
