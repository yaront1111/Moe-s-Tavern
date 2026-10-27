#!/usr/bin/python3 -I
# Protected guest supervisor, bridge core (CQ-R08b). guest-bootstrap.mjs buildUserData installs these bytes at
# GUEST_LAYOUT.supervisor, and guest-bridge.mjs is the protocol source of truth. This process is the ONLY writer of
# its stdout: child bytes reach the host only inside base64 'output' frames, and termination only as this process's
# own 'observation' frame from waitpid. Standard library only; the guest has python3 for cloud-init and no Node.
# Modes: 'bridge' (CQ-R08b/c) and 'materialize' (CQ-R09c: one snapshot from host frames on stdin into WORKSPACE).
# Exit codes: 0 relay or materialization complete; 64 usage; 65 malformed or mismatched snapshot stream; 71 the job could
# not start (child or agent socket: hello, then EOF, no observation; or no AGENT_IDENTITY account); 73 the workspace or
# its manifest already exists; 74 I/O failure or host EOF (child group killed); 75 SIGTERM, SIGHUP or SIGINT (child group
# killed, no observation); 76 host protocol violation (child group killed); 77 not root; 78 root bridge with no job.
import base64
import hashlib
import json
import os
import pwd
import re
import selectors
import shutil
import signal
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import types

PROTOCOL = 1
MAX_GUEST_FRAME_BYTES = 262144  # mirrors guest-bridge.mjs
MAX_HOST_FRAME_BYTES = 4194304  # mirrors guest-bridge.mjs
MAX_REQUEST_ID = 2147483647
# base64 grows a full chunk to 87,384 bytes plus a 45-byte JSON envelope, far inside the frame limit.
OUTPUT_CHUNK_BYTES = 65536
# CQ-R08c ingress, the agent's only route to Moe. AGENT_IDENTITY is JOB_IDENTITIES[0] in guest-bootstrap.mjs.
AGENT_IDENTITY = 'moe-agent'
AGENT_SOCKET = '/run/moe/agent.sock'
MAX_CONNECTIONS = 8
MAX_IN_FLIGHT = 8  # per connection; MAX_CONNECTIONS * MAX_IN_FLIGHT bounds all pending ids, closed requesters' too
TOOL = re.compile(r'moe\.[a-z][a-z_]{0,63}')
CODE = re.compile(r'[A-Z][A-Z0-9_]{0,63}')
# CQ-R10a: these end relay() through its teardown; SIGKILL of the supervisor is left to GUARD.
TERMINATION_SIGNALS = (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)
EX_TERMINATED = os.EX_TEMPFAIL
# The job's session leader. It runs the job in its own group and exits with the job's status. On EOF of the life pipe
# (the supervisor died before reaping it) it SIGKILLs that group, whose id this live member pins. A stand-down byte,
# sent after the output pipes close, lets it exit once the job has; the start pipe gets '+' once the job runs, and
# EOF once this process is gone.
GUARD = '''import os, resource, signal, subprocess, sys, threading
life, start = int(sys.argv[1]), int(sys.argv[2])
for number in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
    signal.signal(number, lambda *_: None)  # group-wide signals are for the job; a caught signal resets at its exec
released = threading.Event()
def watch():
    while True:
        if not os.read(life, 1):
            os.killpg(0, signal.SIGKILL)  # the supervisor died; this live leader pins the group id
        released.set()
threading.Thread(target=watch, daemon=True).start()
try:
    job = subprocess.Popen(sys.argv[3:])
except Exception:
    os._exit(1)  # no '+': the supervisor reports EX_OSERR
try:
    os.write(start, b'+')
    null = os.open(os.devnull, os.O_RDWR)
    os.dup2(null, 1)
    os.dup2(null, 2)  # only the job and its descendants hold the output pipes
    status = os.waitpid(job.pid, 0)[1]
    released.wait()
except BaseException:
    os.killpg(0, signal.SIGKILL)  # never orphan a started job
code = os.waitstatus_to_exitcode(status)
if code >= 0:
    os._exit(code)
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))  # die by the job's signal without writing a core file
try:
    signal.signal(-code, signal.SIG_DFL)
except OSError:
    pass  # SIGKILL and glibc's 32 and 33 refuse a reset; a signal that cannot end this process exits 128 + N
os.kill(os.getpid(), -code)
os._exit(128 - code)
'''


class ProtocolViolation(Exception):
    """The host broke the protocol; the bridge ends with EX_PROTOCOL."""


class Terminated(Exception):
    """A termination signal reached relay(); the bridge ends with EX_TERMINATED."""


class Termination:
    """Raises Terminated only inside wait(), so a signal can never cut teardown short. relay() makes wake_w the signal
    wakeup fd and every wait watches wake_r, so a signal that lands just before a wait's syscall still ends it."""

    def __init__(self):
        self.caught = self.armed = False
        self.wake_r, self.wake_w = os.pipe()
        for fd in (self.wake_r, self.wake_w):
            os.set_blocking(fd, False)  # set_wakeup_fd requires it of wake_w; drain() must never block

    def handle(self, number, frame):
        self.caught = True
        if self.armed:
            self.armed = False
            raise Terminated

    def drain(self, *_):
        try:
            os.read(self.wake_r, 4096)  # the bytes only wake a wait; handle() records the signal
        except BlockingIOError:
            pass

    def wait(self, call, *args):
        self.armed = True
        try:
            if self.caught:
                raise Terminated
            return call(*args)
        finally:
            self.armed = False

    def read(self, fd):
        # One byte, or b'' at EOF, from a blocking pipe, once a wait() on it and on wake_r reports it readable.
        with selectors.DefaultSelector() as selector:
            selector.register(fd, selectors.EVENT_READ)
            selector.register(self.wake_r, selectors.EVENT_READ)
            while not any(key.fd == fd for key, mask in self.wait(selector.select)):
                self.drain()
        return os.read(fd, 1)


def encode_frame(value, limit=MAX_GUEST_FRAME_BYTES):
    # UTF-8 keeps a relayed frame the size of its source; backslashreplace turns a lone surrogate (only a JSON escape
    # makes one) back into that escape, and allow_nan refuses the inf that Python reads 1e999 as.
    text = json.dumps(value, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
    body = text.encode('utf-8', 'backslashreplace')
    if len(body) > limit:
        raise ValueError('frame body exceeds its limit')
    return struct.pack('>I', len(body)) + body


def write_all(fd, data):
    view = memoryview(data)
    while view:
        view = view[os.write(fd, view):]


def write_frame(fd, value):
    write_all(fd, encode_frame(value))


def exit_observation(status):
    if os.WIFSIGNALED(status):
        number = os.WTERMSIG(status)
        try:
            name = signal.Signals(number).name
        except ValueError:
            name = 'SIG%d' % number  # unnamed Linux real-time signals
        return {'kind': 'observation', 'type': 'exit', 'code': None, 'signal': name}
    if os.WIFEXITED(status):
        return {'kind': 'observation', 'type': 'exit', 'code': os.WEXITSTATUS(status), 'signal': None}
    raise ValueError('wait status is neither an exit nor a signal')


def take_frames(buffer, data, limit):
    # Appends data, then pops each whole frame: a length of 1..limit (refused before its body is buffered), UTF-8 JSON.
    buffer += data
    frames = []
    while len(buffer) >= 4:
        length = struct.unpack_from('>I', buffer)[0]
        if not 0 < length <= limit:
            raise ValueError('frame length outside its limit')
        if len(buffer) < 4 + length:
            break
        frames.append(json.loads(buffer[4:4 + length].decode('utf-8')))
        del buffer[:4 + length]
    return frames


def agent_request(frame):
    # Exactly the CQ-R08a request shape (parseGuestFrame); the host's scopeRequest owns the per-role tool allowlist.
    if not (type(frame) is dict and frame.keys() == {'kind', 'id', 'tool', 'args'} and frame['kind'] == 'request'
            and type(frame['id']) is int and 0 < frame['id'] <= MAX_REQUEST_ID and type(frame['tool']) is str
            and TOOL.fullmatch(frame['tool']) and type(frame['args']) is dict):
        raise ValueError('not a request frame')
    return frame


def host_response(frame):
    ok = frame.get('ok') if type(frame) is dict else None
    error = frame.get('error') if ok is False else {'code': 'OK'}
    if not (type(ok) is bool and frame.keys() == {'kind', 'id', 'ok', 'result' if ok else 'error'}
            and frame['kind'] == 'response' and type(frame['id']) is int and type(error) is dict
            and error.keys() == {'code'} and type(error['code']) is str and CODE.fullmatch(error['code'])):
        raise ProtocolViolation
    return frame


def peer_uid(sock):
    # Linux SO_PEERCRED is struct ucred {pid_t pid; uid_t uid; gid_t gid;}, fixed by the kernel at connect().
    return struct.unpack('iII', sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[1]


class Bridge:
    """The one selector loop: child pipes, host response frames on in_fd and, once opened, the agent socket."""

    def __init__(self, out_fd, peer_uid):
        self.out_fd, self.peer_uid = out_fd, peer_uid
        self.selector = selectors.DefaultSelector()
        self.inbox, self.pending, self.next_id, self.sockets = bytearray(), {}, 1, set()
        self.server = self.path = None

    def open(self, in_fd, path, agent_uid):
        self.selector.register(in_fd, selectors.EVENT_READ, self.from_host)
        if path is None:
            return
        self.agent_uid = pwd.getpwnam(AGENT_IDENTITY).pw_uid if agent_uid is None else agent_uid
        folder = os.path.dirname(path)
        os.makedirs(folder, 0o755, exist_ok=True)  # sudo's umask 0022 keeps it searchable by the agent
        info = os.lstat(folder)
        # Writable only by this euid (root in the guest), so no job can plant or replace the socket.
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
            raise PermissionError('the agent socket directory is not private')
        if os.path.lexists(path) and stat.S_ISSOCK(os.lstat(path).st_mode):
            os.unlink(path)  # left by an earlier bridge
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(path)
        info = os.lstat(path)
        self.path, self.bound = path, (info.st_dev, info.st_ino)
        os.chmod(path, 0o666)  # any guest user may connect; SO_PEERCRED decides who is served
        self.server.listen(MAX_CONNECTIONS)
        self.server.setblocking(False)
        self.selector.register(self.server, selectors.EVENT_READ, self.accept)

    def from_host(self, key, mask):
        data = os.read(key.fd, OUTPUT_CHUNK_BYTES)
        if not data:
            raise BrokenPipeError('the host closed the bridge')  # a gone host, as on stdout: EX_IOERR
        try:
            for frame in take_frames(self.inbox, data, MAX_HOST_FRAME_BYTES):
                conn, agent_id = self.pending.pop(host_response(frame)['id'], (None, None))
                if conn is None:
                    raise ProtocolViolation  # an id never assigned, or already answered
                if not conn.closed:  # a closed requester's answer is dropped, never rerouted
                    conn.inflight -= 1
                    field = 'result' if frame['ok'] else 'error'
                    reply = {'kind': 'response', 'id': agent_id, 'ok': frame['ok'], field: frame[field]}
                    conn.outbox += encode_frame(reply, MAX_HOST_FRAME_BYTES)
                    self.watch(conn)
        except (ValueError, RecursionError):
            raise ProtocolViolation from None

    def accept(self, key, mask):
        try:
            sock = self.server.accept()[0]
        except OSError:
            return
        try:
            if len(self.sockets) >= MAX_CONNECTIONS or self.peer_uid(sock) != self.agent_uid:
                raise PermissionError('not a served agent peer')
        except OSError:
            return sock.close()  # before any byte is read from it
        sock.setblocking(False)
        conn = types.SimpleNamespace(sock=sock, inbox=bytearray(), outbox=bytearray(), inflight=0, closed=False)
        conn.handler = lambda key, mask: self.from_agent(conn, mask)
        self.sockets.add(sock)
        self.selector.register(sock, selectors.EVENT_READ, conn.handler)

    def from_agent(self, conn, mask):
        frames = []
        try:
            if mask & selectors.EVENT_WRITE:
                del conn.outbox[:conn.sock.send(conn.outbox)]
            elif not (data := conn.sock.recv(OUTPUT_CHUNK_BYTES)):
                return self.drop(conn)  # the agent closed it
            else:
                frames = [agent_request(frame) for frame in take_frames(conn.inbox, data, MAX_GUEST_FRAME_BYTES)]
        except BlockingIOError:
            pass
        except (OSError, ValueError, RecursionError):
            return self.drop(conn)  # only the offending connection
        for frame in frames:
            if conn.inflight >= MAX_IN_FLIGHT or len(self.pending) >= MAX_CONNECTIONS * MAX_IN_FLIGHT:
                busy = {'kind': 'response', 'id': frame['id'], 'ok': False, 'error': {'code': 'BRIDGE_BUSY'}}
                conn.outbox += encode_frame(busy)
                continue
            relayed = {'kind': 'request', 'id': self.next_id, 'tool': frame['tool'], 'args': frame['args']}
            try:  # encoding fails before any byte is written; an OSError is a gone host and ends the bridge
                write_frame(self.out_fd, relayed)
            except (ValueError, RecursionError):
                return self.drop(conn)  # not relayable within the guest frame limit
            self.pending[self.next_id] = (conn, frame['id'])
            self.next_id += 1
            conn.inflight += 1
        self.watch(conn)

    def watch(self, conn):
        # Reading pauses while replies are queued, so an agent that never reads cannot make its outbox grow unbounded.
        self.selector.modify(conn.sock, selectors.EVENT_WRITE if conn.outbox else selectors.EVENT_READ, conn.handler)

    def drop(self, conn):
        conn.closed = True
        self.sockets.discard(conn.sock)
        self.selector.unregister(conn.sock)
        conn.sock.close()

    def close(self):
        # Closing the listener resets each connection it still queues; accepted first, such a peer reads EOF instead.
        for _ in range(2 * MAX_CONNECTIONS if self.server else 0):  # beyond what listen() queues, against a flood
            try:
                self.sockets.add(self.server.accept()[0])
            except OSError:  # BlockingIOError: the queue is empty
                break
        for sock in [*self.sockets, *filter(None, [self.server])]:
            sock.close()
        self.selector.close()
        try:
            info = os.lstat(self.path) if self.path else None
            if info and (info.st_dev, info.st_ino) == self.bound:  # a newer bridge may have replaced it
                os.unlink(self.path)
        except FileNotFoundError:
            pass


def pump(child, out_fd, bridge, wait):
    streams = {child.stdout.fileno(): 'stdout', child.stderr.fileno(): 'stderr'}
    with bridge.selector as selector:
        for fd in streams:
            selector.register(fd, selectors.EVENT_READ)
        while any(fd in selector.get_map() for fd in streams):
            for key, mask in wait(selector.select):
                if key.data:  # the host stream, the agent socket or an agent connection
                    key.data(key, mask)
                    continue
                chunk = os.read(key.fd, OUTPUT_CHUNK_BYTES)
                if not chunk:
                    selector.unregister(key.fd)
                    continue
                data = base64.b64encode(chunk).decode('ascii')
                write_frame(out_fd, {'kind': 'output', 'stream': streams[key.fd], 'data': data})


def reap(child):
    status = os.waitpid(child.pid, 0)[1]
    child.returncode = os.waitstatus_to_exitcode(status)  # so subprocess never reaps again
    return status


# in_fd carries host response frames, and its EOF is a gone host. agent_socket opens the CQ-R08c ingress for peers
# whose uid is agent_uid (default: the AGENT_IDENTITY account); peer_uid is injectable from Python only (tests).
def relay(argv, out_fd=1, in_fd=0, agent_socket=None, agent_uid=None, peer_uid=peer_uid):
    # An inherited SIG_IGN (it survives exec) lets the kernel discard the child's status before waitpid reads it.
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    termination = Termination()
    wakeup = signal.set_wakeup_fd(termination.wake_w, warn_on_full_buffer=False)  # a full pipe already wakes
    saved = [(number, signal.signal(number, termination.handle)) for number in TERMINATION_SIGNALS]
    try:
        return run_bridge(argv, out_fd, in_fd, agent_socket, agent_uid, peer_uid, termination)
    except Terminated:
        return EX_TERMINATED  # run_bridge's finally has killed and reaped the group and closed the bridge
    finally:
        for number, handler in saved:
            signal.signal(number, signal.SIG_DFL if handler is None else handler)
        signal.set_wakeup_fd(wakeup)  # before the close, so no signal byte can reach a reused fd number
        os.close(termination.wake_r)
        os.close(termination.wake_w)


def run_bridge(argv, out_fd, in_fd, agent_socket, agent_uid, peer_uid, termination):
    try:
        write_frame(out_fd, {'kind': 'hello', 'protocol': PROTOCOL})
    except OSError:
        return os.EX_IOERR
    bridge = Bridge(out_fd, peer_uid)
    life, life_end = os.pipe()  # the guard reads life; this process holds life_end until the guard is reaped
    start_end, start = os.pipe()  # the guard writes '+' once the job runs; EOF means the guard has exited
    try:
        bridge.selector.register(termination.wake_r, selectors.EVENT_READ, termination.drain)  # wakes pump's select
        bridge.open(in_fd, agent_socket, agent_uid)
        child = subprocess.Popen([sys.executable, '-I', '-B', '-c', GUARD, str(life), str(start), *argv],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 start_new_session=True, pass_fds=(life, start))
    except (OSError, KeyError):  # KeyError: no AGENT_IDENTITY account
        os.close(life_end)
        os.close(start_end)
        bridge.close()
        return os.EX_OSERR  # hello, then EOF: never a fabricated observation
    finally:
        os.close(life)
        os.close(start)
    reaped = False
    try:
        if termination.read(start_end) != b'+':
            return os.EX_OSERR  # the guard could not start the job
        pump(child, out_fd, bridge, termination.wait)
        try:
            os.write(life_end, b'0')  # stand down: a normal completion never kills the group
        except BrokenPipeError:
            pass  # a job SIGKILLed its own group, guard included; waitpid still reports the guard's status
        termination.read(start_end)  # EOF: the guard has exited with the job's status
        # Both pipes are at EOF and the guard has exited; waitpid is the only source of the exit frame.
        status = reap(child)
        reaped = True
        write_frame(out_fd, exit_observation(status))
        return 0
    except ProtocolViolation:
        return os.EX_PROTOCOL
    except OSError:
        return os.EX_IOERR  # a gone host (BrokenPipeError: CPython ignores SIGPIPE) or a failed pipe read
    finally:
        if not reaped:
            # Kill the whole session group while the unreaped guard (its leader) still pins its id, then reap it.
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            reap(child)
        child.stdout.close()
        child.stderr.close()
        os.close(life_end)
        os.close(start_end)
        bridge.close()  # no agent connection or socket outlives the job


# CQ-R09c materialize. Callers serialize per VM through R06's job lease; rename never replaces a non-empty workspace.
WORKSPACE = '/var/lib/moe/workspace'
WORKSPACE_MANIFEST = '/var/lib/moe/workspace.manifest.json'
SNAPSHOT_DIGEST_TAG = b'moe-source-snapshot-v1\0'  # the digest framing of source-snapshot.mjs
MAX_SNAPSHOT_FILES = 10000  # mirrors source-snapshot.mjs
MAX_SNAPSHOT_BYTES = 268435456
DIGEST = re.compile(r'[0-9a-f]{64}')
WALK = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def snapshot_frames(in_fd):
    buffer = bytearray()
    while data := os.read(in_fd, OUTPUT_CHUNK_BYTES):
        yield from take_frames(buffer, data, MAX_HOST_FRAME_BYTES)
    if buffer:
        raise ValueError('a partial frame at EOF')


def expect(frame, kind, *keys):
    if not (type(frame) is dict and frame.get('kind') == kind and frame.keys() == {'kind', *keys}):
        raise ValueError('an unexpected snapshot frame')
    return frame


def own(fd, owner, mode):
    os.fchown(fd, *owner)
    os.fchmod(fd, mode)  # explicit, whatever the umask


def create(root, path, executable, owner):
    # Directory-fd-relative and never through a symlink: O_NOFOLLOW on every segment, O_EXCL on the file.
    parts = path.encode('utf-8').split(b'/') if type(path) is str else [b'']
    if b'\0' in b''.join(parts) or any(part in (b'', b'.', b'..') for part in parts):  # '/abs' splits to an empty segment
        raise ValueError('not a relative snapshot path')
    fds = [root]  # the caller closes root
    try:
        for part in parts[:-1]:
            try:
                fds.append(os.open(part, WALK, dir_fd=fds[-1]))
            except FileNotFoundError:
                os.mkdir(part, 0o755, dir_fd=fds[-1])
                fds.append(os.open(part, WALK, dir_fd=fds[-1]))
                own(fds[-1], owner, 0o755)
        fd = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fds[-1])
    except (FileExistsError, NotADirectoryError):
        raise ValueError('a duplicate path or a path under a file') from None
    finally:
        for parent in fds[1:]:
            os.close(parent)
    try:
        own(fd, owner, 0o755 if executable else 0o644)
    except BaseException:
        os.close(fd)
        raise
    return fd


def receive(frames, root, owner):
    head = expect(next(frames, None), 'snapshot', 'version', 'files', 'bytes', 'digest')
    count, total, digest = head['files'], head['bytes'], head['digest']
    if not (type(head['version']) is int and head['version'] == 1 and type(count) is int and 0 <= count <= MAX_SNAPSHOT_FILES
            and type(total) is int and 0 <= total <= MAX_SNAPSHOT_BYTES and type(digest) is str and DIGEST.fullmatch(digest)):
        raise ValueError('a malformed snapshot header')
    rows, left_total = [], total
    for _ in range(count):
        frame = expect(next(frames, None), 'file', 'path', 'executable', 'size')
        path, executable, size = frame['path'], frame['executable'], frame['size']
        if type(executable) is not bool or type(size) is not int or not 0 <= size <= left_total:
            raise ValueError('a malformed file frame')
        left_total -= size
        fd, sha, left = create(root, path, executable, owner), hashlib.sha256(), size
        try:
            while left:
                text = expect(next(frames, None), 'data', 'data')['data']
                chunk = base64.b64decode(text, validate=True) if type(text) is str else b''
                if not chunk or len(chunk) > left or base64.b64encode(chunk).decode('ascii') != text:
                    raise ValueError('a malformed data frame')
                write_all(fd, chunk)
                sha.update(chunk)
                left -= len(chunk)
        finally:
            os.close(fd)
        rows.append((path.encode('utf-8'), path, executable, size, sha.digest()))
    expect(next(frames, None), 'end')
    if next(frames, None) is not None or left_total:
        raise ValueError('bytes after end or a short total')
    rows.sort()
    check = hashlib.sha256(SNAPSHOT_DIGEST_TAG + struct.pack('>I', len(rows)))
    for raw, _, executable, size, sha in rows:
        check.update(struct.pack('>BI', 0x46, len(raw)) + raw + struct.pack('>?I', executable, size) + sha)
    if check.hexdigest() != digest:
        raise ValueError('the snapshot digest does not match its bytes')
    return digest, rows


def write_manifest(path, digest, rows):
    files = {name: [executable, size, sha.hex()] for _, name, executable, size, sha in rows}
    body = json.dumps({'version': 1, 'digest': digest, 'files': files}, separators=(',', ':'), ensure_ascii=False)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        write_all(fd, body.encode('utf-8'))
        os.fsync(fd)
    except BaseException:
        os.unlink(path)  # only the file this call created
        raise
    finally:
        os.close(fd)


# Builds the tree in a root-only staging directory beside workspace and checks it against the header. It then writes the
# root-only manifest and renames the tree into place for owner (default: the AGENT_IDENTITY account), so no workspace
# ever exists without its manifest. A handled failure leaves neither and writes no frame. A crash can leave only the
# 0700 staging tree, and after the manifest that manifest too, so a retry exits 73.
def materialize(in_fd, out_fd, workspace=WORKSPACE, manifest=WORKSPACE_MANIFEST, owner=None):
    if owner is None:
        try:
            entry = pwd.getpwnam(AGENT_IDENTITY)
        except KeyError:
            return os.EX_OSERR
        owner = (entry.pw_uid, entry.pw_gid)
    if os.path.lexists(workspace) or os.path.lexists(manifest):
        return os.EX_CANTCREAT
    staging = root = None
    try:
        parent = os.path.dirname(workspace)
        os.makedirs(parent, 0o755, exist_ok=True)
        staging = tempfile.mkdtemp(prefix='.workspace-', dir=parent)  # 0700
        root = os.open(staging, WALK)
        digest, rows = receive(snapshot_frames(in_fd), root, owner)
        own(root, owner, 0o700)
        write_manifest(manifest, digest, rows)
        try:
            os.rename(staging, workspace)
        except BaseException:
            os.unlink(manifest)
            raise
        staging = None
        write_frame(out_fd, {'kind': 'materialized', 'digest': digest})
        return 0
    except (ValueError, RecursionError):  # binascii.Error, JSON and UTF-8 errors are ValueErrors
        return os.EX_DATAERR
    except OSError:
        return os.EX_IOERR
    finally:
        if root is not None:
            os.close(root)
        if staging is not None:
            shutil.rmtree(staging, ignore_errors=True)


# geteuid is injectable from Python only (tests), never from argv or the environment. No path writes to stdout.
def main(argv, geteuid=os.geteuid):
    if argv not in (['bridge'], ['materialize']):  # bridgeArgv and snapshotArgv pass exactly these
        return os.EX_USAGE
    if geteuid() != 0:
        return os.EX_NOPERM
    if argv == ['materialize']:
        return materialize(0, 1)
    # The job a bridge session runs comes from the CQ-R10/R11 job tables; until one exists a root bridge fails closed.
    return os.EX_CONFIG


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
