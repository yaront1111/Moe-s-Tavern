#!/usr/bin/python3 -I
# Protected guest supervisor, bridge core (CQ-R08b). guest-bootstrap.mjs buildUserData installs these bytes at
# GUEST_LAYOUT.supervisor, and guest-bridge.mjs is the protocol source of truth. This process is the ONLY writer of
# its stdout: child bytes reach the host only inside base64 'output' frames, and termination only as this process's
# own 'observation' frame from waitpid. Standard library only; Node is installed separately by the toolchain mode.
# Modes: 'bridge' (CQ-R08b/c; CQ-R10b: one host job frame on stdin, then that agent CLI job as the AGENT_IDENTITY
# account, CQ-R10d4: fixed headless argv and private shim-only MCP config), 'materialize' (CQ-R09c: one snapshot from
# host frames on stdin into WORKSPACE) and 'export' (CQ-R09:
# WORKSPACE's changes against its manifest, as frames on stdout, walked as the AGENT_IDENTITY account).
# Exit codes: 0 relay, materialization or export complete; 64 usage; 65 malformed or mismatched snapshot stream, an
# unreadable export manifest or workspace root, an export over its bounds, or a malformed or disallowed job frame; 66 no
# materialized workspace for the job; 71 the job could not start (child or agent socket: hello, then EOF, no
# observation; or no AGENT_IDENTITY account, session home or launch config, or the export could not become it); 73 the workspace or its
# manifest already exists; 74 I/O failure or host EOF (child group killed), including EOF before a whole job frame; 75
# SIGTERM, SIGHUP or SIGINT (child group killed, no observation); 76 host protocol violation (child group killed); 77 not
# root. A bridge refusal before hello (65, 66, 74, and 71 for a missing account, session home or launch config) writes no frame, nor
# does 77.
# Mode 'check' (CQ-R11a): one host check frame on stdin, then that approved command as the CHECK_IDENTITY account. It
# shares the bridge's codes, and none writes a frame: 65 also for a malformed protected entry or a workspace entry reown
# refuses, 66 no workspace, 71 no CHECK_IDENTITY account, a failed re-own, no session home or no protected-path mount
# namespace, and 74 EOF before the check frame. CQ-R11b adds 79 (before hello, no frame, no job): a protected path is
# missing, not a regular file, reached through a symlink, or holds another git blob oid, so the candidate does not carry
# the approved bytes. It adds 80, written after the observation frame: a protected path no longer holds its approved
# blob once the job is reaped; CQ-R11c classifies the run as inconclusive. CQ-R11e5: when this run's 'dependencies' mode
# wrote its manifest, `npm ci` from that offline tree runs for each listed lockfile directory as the check job would, after
# the re-own and the protected mounts. 81 (before hello, no frame, no job; CQ-R11c reports infra-failure) is a malformed
# directory list, a missing, linked, non-regular, malformed or oversized lockfile (an approved, protected path), a
# lockfile or package.json that could not be read or changed while it was read, or an install that failed, could not
# start or outlived INSTALL_TIMEOUT. 82 (task-42e9990c; before hello, no frame, no job, no install; the host reports
# code-failure with its own fixed text) is a refusal the candidate's own files cause: a missing, linked, non-regular,
# malformed or oversized package.json, one whose install metadata differs from its lockfile's root entry or that sets
# overrides, bundled dependencies or workspaces, or an npm-shrinkwrap.json or .npmrc beside them. Every listed
# directory is checked first, and an 81 cause in any of them outranks an 82.
# Mode 'verify' (CQ-R11f): reads no stdin and writes one {kind: 'verified', changed} frame, the count of manifest paths no
# longer holding their materialized bytes and exec bit; 65 a missing or malformed manifest or workspace root, 74 a gone
# host, each with no frame.
# Mode 'agents' (CQ-R10d3a): the pinned agent CLIs from host frames on stdin into AGENTS as root:root 0555, then one
# {kind: 'installed', count} frame and 0; 65 a malformed, mismatched or empty stream, 74 an I/O failure or an AGENTS path
# that is a symlink or a file, 77 not root, 64 any other argv. No refusal writes a frame.
# Mode 'toolchain' (CQ-R11e2): a pinned tarball from host frames into root-owned TOOLCHAIN, then {kind: 'installed',
# sha256} and 0; 65 malformed stream/archive or unsafe tree, 71 no tarfile.data_filter, 73 existing install, 74 I/O
# failure, 77 not root, 64 any other argv. Refusals leave no new install or staging tree.
# Mode 'dependencies' (CQ-R11e4): one snapshot into root-owned DEPENDENCIES (0755 directories, 0644 files) and a
# private manifest, then {kind: 'materialized', digest} and 0; 65 malformed/mismatched stream, 73 existing tree or
# manifest, 74 I/O failure, 77 not root, 64 any other argv. Stream refusals leave no new tree, manifest or staging.
import base64
import contextlib
import errno
import hashlib
import json
import lzma
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
import tarfile
import tempfile
import time
import types
import zlib

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
# The job's session leader. It runs the job in its own group and exits with the job's status. As root it first unshares
# a PID namespace, so its one fork is that namespace's init: init starts the job, reaps orphans until the job's own
# status, sends it up a private pipe and exits, and the kernel kills every other descendant, setsid or not, before init
# can be reaped. Root that cannot unshare never starts the job; a non-root import fixture runs uncontained and certifies
# nothing. On EOF of the life pipe (the supervisor died before reaping it) it SIGKILLs init, then its own group, whose
# id this live member pins. A stand-down byte, sent after the output pipes close, lets it exit once init has; the start
# pipe gets '+' once the job runs, and EOF once this process is gone. argv[3] is the job's Popen identity, groups, umask
# and cwd as JSON (CQ-R10b); the job's environment is this process's own, so a credential travels in no argv or file. On
# Linux the job, and anything it execs, can never gain privileges (PR_SET_NO_NEW_PRIVS); a guard that cannot set the bit
# never starts the job.
# CQ-R11a: a check job's argv[3] also carries its rlimits and network namespace, which this process applies to itself
# before the Popen, for the job to inherit; a guard that cannot apply them never starts the job either.
GUARD = '''import json, os, resource, signal, selectors, subprocess, sys
life, start = int(sys.argv[1]), int(sys.argv[2])
for number in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
    signal.signal(number, lambda *_: None)  # group-wide signals are for the job; a caught signal resets at its exec
try:
    spawn = json.loads(sys.argv[3])
    if sys.platform == 'linux':
        import ctypes
        if ctypes.CDLL(None, use_errno=True).prctl(38, *map(ctypes.c_ulong, (1, 0, 0, 0))):  # PR_SET_NO_NEW_PRIVS
            raise OSError(ctypes.get_errno(), 'PR_SET_NO_NEW_PRIVS')
    if spawn.pop('netns', False):
        # Root in the Linux guest only (Python 3.12+ os.unshare; a non-root test passes netns False); CQ-R13 certifies it
        # on a real VM. Init forks the job into the new namespace, whose own loopback comes up: SIOCGIFFLAGS, then
        # SIOCSIFFLAGS with IFF_UP, on a 40-byte ifreq.
        import fcntl, socket, struct
        os.unshare(os.CLONE_NEWNET)
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            flags = struct.unpack_from('16sH', fcntl.ioctl(sock, 0x8913, struct.pack('16sH22x', b'lo', 0)))[1]
            fcntl.ioctl(sock, 0x8914, struct.pack('16sH22x', b'lo', flags | 1))
    for name, value in spawn.pop('rlimits', {}).items():
        resource.setrlimit(getattr(resource, name), (value, value))  # soft = hard; root is exempt from NPROC at fork
    if os.geteuid() == 0:
        # The next fork is init of a PID namespace whose exit kills every descendant, setsid or not. The kernel then
        # refuses this process any thread, so the loop below watches the life pipe.
        os.unshare(os.CLONE_NEWPID)
    report, told = os.pipe()  # init writes '+' once the job runs, then the job's raw wait status
    init = os.fork()
    if init == 0:
        job = subprocess.Popen(sys.argv[4:], **spawn)  # in C, after fork: groups, gid, uid, then exec
except Exception:
    os._exit(1)  # no '+': the supervisor reports EX_OSERR
if init == 0:
    os.write(told, b'+')
    null = os.open(os.devnull, os.O_RDWR)
    os.dup2(null, 1)
    os.dup2(null, 2)
    while (reaped := os.waitpid(-1, 0))[0] != job.pid:
        pass  # as pid 1, init adopts orphans: reap them until the job's own status
    os.write(told, b'%d' % reaped[1])
    os._exit(0)  # the kernel kills and reaps the rest of the namespace before this exit can be reaped
os.close(told)
try:
    selector = selectors.DefaultSelector()
    selector.register(life, selectors.EVENT_READ)
    selector.register(report, selectors.EVENT_READ)
    data, released, exited = b'', False, None
    while exited is None or not released:
        for key, _ in selector.select():
            chunk = os.read(key.fd, 8)
            if key.fd == life:
                if not chunk:  # the supervisor died
                    if exited is None:
                        os.kill(init, signal.SIGKILL)  # from the parent namespace; the kernel then kills the rest of it
                        os.waitpid(init, 0)  # reaped only once its namespace is empty
                    os.killpg(0, signal.SIGKILL)  # this live leader pins the group id
                released = True  # still watched: a supervisor that dies after standing down still kills the group
            elif chunk and len(data) < 8:
                if not data and chunk[:1] == b'+':
                    os.write(start, b'+')
                    null = os.open(os.devnull, os.O_RDWR)
                    os.dup2(null, 1)
                    os.dup2(null, 2)  # only the job and its descendants hold the output pipes
                data += chunk
            else:
                selector.unregister(report)
                exited = os.waitpid(init, 0)[1]  # init is reaped only once its namespace is empty
                if data[:1] != b'+':
                    os._exit(1)  # init could not start the job: no '+'
    if exited != 0 or not data[1:].isdigit() or len(data) > 6:
        raise OSError('incomplete job status')
    code = os.waitstatus_to_exitcode(int(data[1:]))
except BaseException:
    os.killpg(0, signal.SIGKILL)  # never orphan a started job, nor mirror an incomplete status
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
# whose uid is agent_uid (default: the AGENT_IDENTITY account); peer_uid is injectable from Python only (tests). job is
# None, for GUARD to run argv as this process with its environment, or start_job's {'env': the job's whole environment,
# 'spawn': GUARD's Popen keywords for the job}.
def relay(argv, out_fd=1, in_fd=0, agent_socket=None, agent_uid=None, peer_uid=peer_uid, job=None):
    # An inherited SIG_IGN (it survives exec) lets the kernel discard the child's status before waitpid reads it.
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    termination = Termination()
    wakeup = signal.set_wakeup_fd(termination.wake_w, warn_on_full_buffer=False)  # a full pipe already wakes
    saved = [(number, signal.signal(number, termination.handle)) for number in TERMINATION_SIGNALS]
    try:
        return run_bridge(argv, out_fd, in_fd, agent_socket, agent_uid, peer_uid, termination, job)
    except Terminated:
        return EX_TERMINATED  # run_bridge's finally has killed and reaped the group and closed the bridge
    finally:
        for number, handler in saved:
            signal.signal(number, signal.SIG_DFL if handler is None else handler)
        signal.set_wakeup_fd(wakeup)  # before the close, so no signal byte can reach a reused fd number
        os.close(termination.wake_r)
        os.close(termination.wake_w)


def run_bridge(argv, out_fd, in_fd, agent_socket, agent_uid, peer_uid, termination, job):
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
        env, spawn = (None, {}) if job is None else (job['env'], job['spawn'])
        child = subprocess.Popen([sys.executable, '-I', '-B', '-c', GUARD, str(life), str(start), json.dumps(spawn), *argv],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 start_new_session=True, pass_fds=(life, start), env=env)
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


# Writes exactly size bytes from the data frames that follow, each a non-empty canonical base64 chunk within what is left,
# and returns their running sha256.
def copy_data(frames, fd, size):
    sha, left = hashlib.sha256(), size
    while left:
        text = expect(next(frames, None), 'data', 'data')['data']
        chunk = base64.b64decode(text, validate=True) if type(text) is str else b''
        if not chunk or len(chunk) > left or base64.b64encode(chunk).decode('ascii') != text:
            raise ValueError('a malformed data frame')
        write_all(fd, chunk)
        sha.update(chunk)
        left -= len(chunk)
    return sha


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
        fd = create(root, path, executable, owner)
        try:
            sha = copy_data(frames, fd, size)
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
# 0700 staging tree, and after the manifest that manifest too, so a retry exits 73. mode sets the final root permissions.
def materialize(in_fd, out_fd, workspace=WORKSPACE, manifest=WORKSPACE_MANIFEST, owner=None, mode=0o700):
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
        staging = tempfile.mkdtemp(prefix='.' + os.path.basename(workspace) + '-', dir=parent)  # 0700
        root = os.open(staging, WALK)
        digest, rows = receive(snapshot_frames(in_fd), root, owner)
        own(root, owner, mode)
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


DEPENDENCIES = '/var/lib/moe/dependencies'
DEPENDENCIES_MANIFEST = '/var/lib/moe/dependencies.manifest.json'


def dependencies(in_fd, out_fd, tree=DEPENDENCIES, manifest=DEPENDENCIES_MANIFEST, owner=(0, 0)):
    return materialize(in_fd, out_fd, tree, manifest, owner, mode=0o755)


# CQ-R09 export. The host derives every size and hash from the bytes it receives (validateImport), so no frame carries
# one. The walk runs as the AGENT_IDENTITY account: a name the agent swaps for a link between lstat and open can then
# reach only what the agent could read itself, never a root-only file such as the supervisor credential.
MAX_MANIFEST_BYTES = 16777216
MAX_PATH_BYTES = 1024  # mirrors source-snapshot.mjs; checked before descending, it bounds depth and open fds
WALK_LIMIT = 100000  # names visited, so a tree of empty directories still ends
READ = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK  # never through a link, and a FIFO cannot block the open


def chunks(fd, size):
    # Exactly size bytes as full OUTPUT_CHUNK_BYTES chunks and a shorter last one, the only split the host admits, however
    # short each read is; a file that shrinks meanwhile is an I/O failure.
    while size:
        chunk, want = b'', min(size, OUTPUT_CHUNK_BYTES)
        while len(chunk) < want:
            data = os.read(fd, want - len(chunk))
            if not data:
                raise OSError('the file shrank while it was read')
            chunk += data
        size -= want
        yield chunk


def manifest_row(row):
    return (type(row) is list and len(row) == 3 and type(row[0]) is bool and type(row[1]) is int and row[1] >= 0
            and type(row[2]) is str and DIGEST.fullmatch(row[2]) is not None)


def read_manifest(path):
    fd = os.open(path, READ)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_MANIFEST_BYTES:
            raise ValueError('not a bounded manifest file')
        stored = json.loads(b''.join(chunks(fd, info.st_size)).decode('utf-8'))
    finally:
        os.close(fd)
    if not (type(stored) is dict and stored.keys() == {'version', 'digest', 'files'} and type(stored['version']) is int
            and stored['version'] == 1 and type(stored['digest']) is str and DIGEST.fullmatch(stored['digest'])
            and type(stored['files']) is dict and all(map(manifest_row, stored['files'].values()))):
        raise ValueError('a malformed manifest')
    return stored['files']


def drop_to_agent():
    # Irreversible: as root, setuid sets the real, effective and saved uid. The groups go first, while root may set them.
    entry = pwd.getpwnam(AGENT_IDENTITY)
    os.setgroups([])
    os.setgid(entry.pw_gid)
    os.setuid(entry.pw_uid)


class Export:
    """One depth-first walk through directory fds only, each directory's names in byte order. It emits file (then its
    data) for each regular file whose [executable, size, sha256] is not the manifest's, symlink and special for the
    rest, then a delete per manifest path with no non-directory left at it, then end."""

    def __init__(self, out_fd, known):
        self.out_fd, self.known, self.seen = out_fd, known, set()
        self.entries = self.bytes = self.visited = 0

    def emit(self, frame):
        self.entries += 1
        if self.entries > MAX_SNAPSHOT_FILES:
            raise ValueError('more entries than an import admits')
        write_frame(self.out_fd, frame)

    def directory(self, fd, prefix):
        names = []
        with os.scandir(fd) as listing:
            for entry in listing:
                self.visited += 1
                if self.visited > WALK_LIMIT:
                    raise ValueError('more names than a walk visits')
                names.append(entry.name)
        for name in sorted(names, key=os.fsencode):
            raw = prefix + os.fsencode(name)
            if len(raw) > MAX_PATH_BYTES:
                raise ValueError('a path over its limit')
            info = os.lstat(name, dir_fd=fd)
            # Never strict UTF-8: encode_frame carries an undecodable byte's escape to the host, which refuses it.
            path = raw.decode('utf-8', 'surrogateescape')
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, WALK, dir_fd=fd)
                try:
                    self.directory(child, raw + b'/')
                finally:
                    os.close(child)
                continue
            self.seen.add(path)  # a directory at a manifest path leaves that path to a delete
            if stat.S_ISREG(info.st_mode):
                self.regular(fd, name, path, info)
            else:
                self.emit({'kind': 'symlink' if stat.S_ISLNK(info.st_mode) else 'special', 'path': path})

    def regular(self, parent, name, path, info):
        fd = os.open(name, READ, dir_fd=parent)
        try:
            now = os.fstat(fd)
            if not stat.S_ISREG(now.st_mode) or (now.st_dev, now.st_ino) != (info.st_dev, info.st_ino):
                raise OSError('the name was replaced between lstat and open')
            executable, size = bool(now.st_mode & 0o100), now.st_size
            if self.known.get(path, [])[:2] == [executable, size]:
                sha = hashlib.sha256()
                for chunk in chunks(fd, size):
                    sha.update(chunk)
                if sha.hexdigest() == self.known[path][2]:
                    return
                os.lseek(fd, 0, os.SEEK_SET)
            self.bytes += size
            if self.bytes > MAX_SNAPSHOT_BYTES:
                raise ValueError('more changed bytes than an import admits')  # from fstat, before reading them
            self.emit({'kind': 'file', 'path': path, 'executable': executable, 'size': size})
            for chunk in chunks(fd, size):
                write_frame(self.out_fd, {'kind': 'data', 'data': base64.b64encode(chunk).decode('ascii')})
        finally:
            os.close(fd)

    def finish(self):
        for path in sorted(self.known.keys() - self.seen, key=lambda path: path.encode('utf-8')):
            self.emit({'kind': 'delete', 'path': path})
        write_frame(self.out_fd, {'kind': 'end', 'entries': self.entries})


# Reads the root-only manifest and opens the workspace root while still root, then drops to the agent before any entry
# is opened. A failure before the drop exits 65, the drop 71, a bound 65 and I/O 74, each with no end frame.
def export(out_fd, workspace=WORKSPACE, manifest=WORKSPACE_MANIFEST, drop=drop_to_agent):
    try:
        known = read_manifest(manifest)
        root = os.open(workspace, WALK)
    except (OSError, ValueError, RecursionError):  # JSON and UTF-8 errors are ValueErrors
        return os.EX_DATAERR
    try:
        try:
            drop()
        except (KeyError, OSError):  # KeyError: no AGENT_IDENTITY account
            return os.EX_OSERR
        walk = Export(out_fd, known)
        walk.directory(root, b'')
        walk.finish()
        return 0
    except (ValueError, RecursionError):
        return os.EX_DATAERR
    except OSError:
        return os.EX_IOERR  # an unreadable or replaced entry, or a gone host
    finally:
        os.close(root)


# CQ-R10b: JOBS[cli] = (executable, allowed credential names); keep the 2-tuple mirror in guest-bridge.mjs unchanged.
# CQ-R10d4: fixed headless argv and shim-only config, never workspace files or a resumed session.
JOBS = {'claude': ('/opt/moe/agents/claude', ('ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN')),
        'codex': ('/opt/moe/agents/codex', ('OPENAI_API_KEY', 'CODEX_API_KEY'))}
AGENTS = '/opt/moe/agents'  # CQ-R10d3a installs every JOBS executable here
MAX_AGENT_BYTES = 1073741824  # 2**30, mirrors agent-cache.mjs MAX_AGENT_BINARY_BYTES
JOB_ROLES = ('worker', 'qa')
SHIM = '/opt/moe/bin/moe-mcp-shim'  # GUEST_LAYOUT.shim in guest-bootstrap.mjs
PROMPTS = {
    'worker': 'Call moe.get_context for your assigned task first. You are the worker: follow nextAction and the approved implementation plan, then finish with moe.complete_task.',
    'qa': 'Call moe.get_context for your assigned task first. You are QA: review against the definition of done, then finish with moe.qa_approve or moe.qa_reject.',
}
# codex 0.166 starts a stdio MCP server with only HOME, PATH and LC_CTYPE: env_vars forwards exactly MOE_ROLE, the one
# variable guest-mcp-shim.py main() reads, and never the credential.
LAUNCH = {
    'claude': (('-p', '{prompt}', '--mcp-config', '{config}', '--strict-mcp-config', '--dangerously-skip-permissions'),
               '.moe-mcp.json', json.dumps({'mcpServers': {'moe': {'command': SHIM}}})),
    'codex': (('exec', '--sandbox', 'danger-full-access', '--skip-git-repo-check', '{prompt}'), '.codex/config.toml',
              '[mcp_servers.moe]\ncommand = "' + SHIM + '"\nenv_vars = ["MOE_ROLE"]\ndefault_tools_approval_mode = "approve"\n'),
}
JOB_PATH = '/usr/local/bin:/usr/bin:/bin'
TOOLCHAIN = '/opt/moe/toolchain'  # CQ-R11e2's 'toolchain' mode installs Node here; a check job's PATH puts its bin first
SESSIONS = '/var/lib/moe/sessions'
CREDENTIAL = re.compile(r'[\x21-\x7e]{1,4096}')


def read_exact(fd, size):
    data = bytearray()
    while len(data) < size:
        chunk = os.read(fd, size - len(data))  # never past size: every later stdin byte belongs to relay()
        if not chunk:
            raise EOFError('host EOF before a whole job frame')
        data += chunk
    return bytes(data)


def read_frame(in_fd):
    length = struct.unpack('>I', read_exact(in_fd, 4))[0]
    if not 0 < length <= MAX_HOST_FRAME_BYTES:
        raise ValueError('frame length outside its limit')  # before any body byte is read
    return json.loads(read_exact(in_fd, length).decode('utf-8'))


def read_job(in_fd, jobs):
    frame = read_frame(in_fd)
    secret = frame.get('credential') if type(frame) is dict else None
    # type(cli) before `in jobs`: an unhashable cli must be refused, never raise TypeError.
    if not (type(frame) is dict and frame.keys() == {'kind', 'version', 'cli', 'role', 'credential'}
            and frame['kind'] == 'job' and type(frame['version']) is int and frame['version'] == 1
            and type(frame['cli']) is str and frame['cli'] in jobs and frame['role'] in JOB_ROLES
            and type(secret) is dict and secret.keys() == {'name', 'value'} and secret['name'] in jobs[frame['cli']][1]
            and type(secret['value']) is str and CREDENTIAL.fullmatch(secret['value'])):
        raise ValueError('not a job frame')  # fixed text: the frame holds a credential
    return frame


def session_home(sessions, uid, gid):
    # 0711: a job reaches its own home by name but cannot list earlier ones. Like the agent socket directory, sessions
    # must be writable only by this euid (root in the guest), so no job can plant or swap a home.
    os.makedirs(sessions, 0o711, exist_ok=True)
    info = os.lstat(sessions)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
        raise PermissionError('the session directory is not private')
    home = tempfile.mkdtemp(prefix='home-', dir=sessions)  # 0700 and a fresh name per job; never reused or deleted
    os.chown(home, uid, gid)
    return home


def prepare_launch(cli, role, home, uid, gid, exe):
    tail, relative, content = LAUNCH[cli]
    fds = [os.open(home, WALK)]
    try:
        parent, name = os.path.split(relative)
        if parent:
            os.mkdir(parent, 0o700, dir_fd=fds[0])
            fds.append(os.open(parent, WALK, dir_fd=fds[0]))
            os.fchown(fds[-1], uid, gid)
        fds.append(os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fds[-1]))
        write_all(fds[-1], content.encode('utf-8'))
        os.fsync(fds[-1])
        os.fchown(fds[-1], uid, gid)
    finally:
        for fd in reversed(fds):
            os.close(fd)
    config = os.path.join(home, relative)
    argv = [exe, *(arg.format(prompt=PROMPTS[role], config=config) for arg in tail)]
    return argv, {'CODEX_HOME': os.path.join(home, '.codex')} if cli == 'codex' else {}


# One bridge session runs one agent CLI job. The host's first frame, read before hello, picks the CLI, the role and the
# one credential, which reaches the job only through its environment; argv uses only the role's fixed prompt. identity is
# (uid, gid, groups): by default the AGENT_IDENTITY account with groups [], which is setgroups([]); None keeps the
# caller's groups, for a non-root test only. workspace, sessions, identity, jobs, agent_socket and peer_uid are
# injectable from Python only (tests). A refusal writes no frame, starts no job and echoes nothing from the frame: 74
# host EOF, 65 a malformed or disallowed frame or a codex workspace holding .codex, 71 no account, 66 no workspace owned by
# the job uid, 71 no home or config.
def start_job(in_fd, out_fd, workspace=WORKSPACE, sessions=SESSIONS, identity=None, jobs=JOBS, agent_socket=AGENT_SOCKET,
              peer_uid=peer_uid):
    try:
        frame = read_job(in_fd, jobs)
    except (EOFError, OSError):
        return os.EX_IOERR
    except (ValueError, RecursionError):  # JSON and UTF-8 errors are ValueErrors
        return os.EX_DATAERR
    if identity is None:
        try:
            entry = pwd.getpwnam(AGENT_IDENTITY)
        except KeyError:
            return os.EX_OSERR
        identity = (entry.pw_uid, entry.pw_gid, [])
    uid, gid, groups = identity
    try:
        info = os.lstat(workspace)  # never through a symlink
    except OSError:
        return os.EX_NOINPUT
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid:
        return os.EX_NOINPUT
    # codex exec loads <workspace>/.codex/config.toml (MCP servers, providers) even for a fresh CODEX_HOME, so a candidate
    # that holds any .codex entry never reaches it; claude's --strict-mcp-config already ignores workspace MCP files.
    if frame['cli'] == 'codex' and os.path.lexists(os.path.join(workspace, '.codex')):
        return os.EX_DATAERR
    try:
        home = session_home(sessions, uid, gid)
        argv, extra_env = prepare_launch(frame['cli'], frame['role'], home, uid, gid, jobs[frame['cli']][0])
    except OSError:
        return os.EX_OSERR
    secret = frame['credential']
    env = {'PATH': JOB_PATH, 'HOME': home, 'USER': AGENT_IDENTITY, 'LOGNAME': AGENT_IDENTITY, 'LANG': 'C.UTF-8',
           'MOE_ROLE': frame['role'], secret['name']: secret['value'], **extra_env}
    spawn = {'user': uid, 'group': gid, 'extra_groups': groups, 'umask': 0o077, 'cwd': workspace}
    return relay(argv, out_fd, in_fd, agent_socket, uid, peer_uid, job={'env': env, 'spawn': spawn})


# CQ-R11a: one approved check per fresh check VM. CHECK_IDENTITY is JOB_IDENTITIES[1] in guest-bootstrap.mjs; the id,
# command and protected rules mirror the daemon's validateRequiredChecks, and CHECK_RLIMITS (each soft = hard) is
# check-evidence.mjs CHECK_BOUNDARIES.resources.rlimits, which local-runner-check.test.mjs K2 pins.
CHECK_IDENTITY = 'moe-check'
CHECK_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}')
CHECK_CONTROL = re.compile(r'[\x00-\x1f\x7f-\x9f\u2028\u2029]')  # the daemon's CHECK_CONTROL_CHARACTERS
CHECK_BLANK = re.compile(r'[\s\ufeff]*')  # what JavaScript's trim() removes
MAX_CHECK_COMMAND = 1000  # UTF-16 code units, the daemon's String.length
CHECK_RLIMITS = {'RLIMIT_CORE': 0, 'RLIMIT_FSIZE': 1073741824, 'RLIMIT_NOFILE': 4096, 'RLIMIT_NPROC': 2048}
# CQ-R11b: the protected paths are the approved RequiredCheckSnapshot entries, as the daemon stores them: at most
# MAX_ENTRIES {path, oid} records, strictly ascending by UTF-8 bytes, each path within MAX_PATH_LEN UTF-16 units.
MAX_PROTECTED = 2000
MAX_PROTECTED_PATH = 500
OID = re.compile(r'[0-9a-f]{40}')
PROTECTED_MISMATCH = 79
PROTECTED_CHANGED = 80
# CQ-R11e5: the offline install of this run's 'dependencies' tree, one `npm ci` per lockfile directory it lists.
DEPENDENCIES_FAILED = 81
DEPENDENCIES_CANDIDATE_INVALID = 82  # check-session.mjs's code-failure: the candidate's own files refused the install
INSTALL_TIMEOUT = 900  # seconds per directory
MAX_DEPENDENCY_DIRS = 16  # dependency-cache.mjs MAX_LOCKFILES
MAX_DEPENDENCY_LIST_BYTES = 65536
# dependency-cache.mjs OFFLINE_INSTALL_ARGS, which KI1 pins: --offline never fetches and --ignore-scripts runs no script.
OFFLINE_INSTALL_ARGS = ('--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--no-update-notifier', '--logs-max=0',
                        '--workspaces=false')
MAX_PACKAGE_JSON_BYTES = 1048576
MAX_LOCKFILE_BYTES = 16777216  # dependency-cache.mjs MAX_LOCKFILE_BYTES
# Besides name and version, what npm ci builds the root project's dependency edges from.
DEPENDENCY_MAPS = ('dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies')
# Resolution controls npm ci reads from package.json that no lockfile root comparison approves: overrides replace locked
# specs, npm ci still installs a root-bundled dependency whose lockfile entry host admission skips as inBundle, and
# workspaces add link edges host admission refuses.
UNAPPROVED_CONTROLS = ('overrides', 'bundleDependencies', 'bundledDependencies', 'workspaces')


def protected_path(path):
    # The safety rules of the daemon's normalizedPath, which is stricter, so every approved path passes: no traversal,
    # empty or '.' segment, backslash, replacement or control character, and nothing JavaScript's trim() would remove.
    # utf-16-le raises UnicodeEncodeError, a ValueError, for a lone surrogate.
    return (len(path.encode('utf-16-le')) // 2 <= MAX_PROTECTED_PATH and '\\' not in path and '\ufffd' not in path
            and not CHECK_CONTROL.search(path) and all(part not in ('', '.', '..') for part in path.split('/'))
            and not CHECK_BLANK.fullmatch(path[0]) and not CHECK_BLANK.fullmatch(path[-1]))


def protected_entries(value):
    if not (type(value) is list and len(value) <= MAX_PROTECTED and all(
            type(entry) is dict and entry.keys() == {'path', 'oid'} and type(entry['oid']) is str
            and OID.fullmatch(entry['oid']) and type(entry['path']) is str and protected_path(entry['path'])
            for entry in value)):
        return False
    paths = [entry['path'].encode('utf-8') for entry in value]
    return all(a < b for a, b in zip(paths, paths[1:]))  # strictly ascending, so also unique


def blob_oid(root, path):
    # Git's blob id of the regular file at path under the root fd, or None. Every directory is opened through its parent's
    # fd with WALK and the file with READ, so no symlink is ever followed; a file that grows or shrinks while it is read,
    # and any other failure, is None too.
    fds = []
    try:
        *parents, name = path.split('/')
        for part in parents:
            fds.append(os.open(part, WALK, dir_fd=fds[-1] if fds else root))
        fds.append(os.open(name, READ, dir_fd=fds[-1] if fds else root))
        info = os.fstat(fds[-1])
        if not stat.S_ISREG(info.st_mode):
            return None
        digest = hashlib.sha1(b'blob %d\0' % info.st_size)
        for chunk in chunks(fds[-1], info.st_size):
            digest.update(chunk)
        return None if os.read(fds[-1], 1) else digest.hexdigest()
    except OSError:
        return None
    finally:
        for fd in fds:
            os.close(fd)


def holds(root, entries):
    return all(blob_oid(root, entry['path']) == entry['oid'] for entry in entries)


def unchanged(workspace, entries):
    # After the job. The mounts are the boundary and this is the second line: it cannot see a swap the job restored before
    # it exited, which is why protect_mounts exists. A workspace that cannot be re-read has changed.
    try:
        root = os.open(workspace, WALK)
    except OSError:
        return False
    try:
        return holds(root, entries)
    finally:
        os.close(root)


def read_check(in_fd):
    frame = read_frame(in_fd)
    command = frame.get('command') if type(frame) is dict else None
    # utf-16-le raises UnicodeEncodeError, a ValueError, for a lone surrogate, which could never reach argv.
    if not (type(frame) is dict and frame.keys() == {'kind', 'version', 'id', 'command', 'protected'}
            and frame['kind'] == 'check' and type(frame['version']) is int and frame['version'] == 1
            and type(frame['id']) is str and CHECK_ID.fullmatch(frame['id'])
            and type(command) is str and not CHECK_BLANK.fullmatch(command) and not CHECK_CONTROL.search(command)
            and len(command.encode('utf-16-le')) // 2 <= MAX_CHECK_COMMAND and protected_entries(frame['protected'])):
        raise ValueError('not a check frame')
    return frame


# CQ-R11b: the job's boundary around the protected paths. A private mount namespace keeps every mount below out of the
# guest's own. Each ancestor directory is bound onto itself: it stays writable, but renaming a mount point is EBUSY.
# Each protected file is bound onto itself read-only: a write or chmod is EROFS, and a rename, replace or unlink EBUSY.
# Parents are bound before their children, and every directory before any file, since a later non-recursive bind of a
# parent would hide its children's mounts. Path targets are safe: reown has refused every symlink in the workspace, and
# no job identity has run since. This root supervisor sets it up, not GUARD as CQ-R11b's DoD words it: GUARD inherits
# it with the job, and its only channel, argv, is capped at MAX_ARG_STRLEN (128 KiB) per argument, too little for
# MAX_PROTECTED paths. Here a failure also refuses before hello. CQ-R13 certifies it on a real guest.
CLONE_NEWNS = 0x00020000  # os.CLONE_NEWNS on Linux, spelled out so the recorder test also runs on macOS
MS_RDONLY, MS_REMOUNT, MS_BIND, MS_REC, MS_PRIVATE = 1, 32, 4096, 16384, 1 << 18


def mount(source, target, flags):
    import ctypes
    libc = ctypes.CDLL(None, use_errno=True)
    libc.mount.argtypes = (ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_void_p)
    if libc.mount(source, target, None, flags, None):
        raise OSError(ctypes.get_errno(), 'mount')


def protect_mounts(workspace, paths):
    if not hasattr(os, 'unshare'):
        raise OSError('no mount namespace: os.unshare needs Linux and Python 3.12+')
    os.unshare(CLONE_NEWNS)  # before relay(), so this thread is the only one, and it forks GUARD
    mount(None, b'/', MS_REC | MS_PRIVATE)
    ancestors = {path[:index] for path in paths for index, char in enumerate(path) if char == '/'}
    for rel in sorted(ancestors, key=lambda rel: rel.encode('utf-8')):  # a prefix sorts first
        target = os.fsencode(os.path.join(workspace, rel))
        mount(target, target, MS_BIND)
    for rel in paths:
        target = os.fsencode(os.path.join(workspace, rel))
        mount(target, target, MS_BIND)
        mount(None, target, MS_BIND | MS_REMOUNT | MS_RDONLY)


# Hands the materialized (agent-owned) tree to the check identity through directory fds only, never a path, so nothing
# is followed. Each entry is opened without following a link and must still be the inode lstat saw; a symlink, FIFO,
# socket or device, or a hard-linked file (its inode may live outside), raises ValueError before any chown of it. No
# WALK_LIMIT: the root materialized this tree from at most MAX_SNAPSHOT_FILES files in a fresh check VM where no job
# identity has run yet, and MAX_PATH_BYTES, checked before descending, bounds its depth and open fds. A file whose
# relative path is in protected (CQ-R11b, UTF-8 bytes) is never handed over: it becomes this euid's (root in the guest)
# and read-only, its exec bit kept so a protected script the command runs directly still runs.
def reown(fd, uid, gid, prefix=b'', protected=frozenset()):
    os.fchown(fd, uid, gid)
    for name in os.listdir(fd):
        raw = prefix + os.fsencode(name)
        if len(raw) > MAX_PATH_BYTES:
            raise ValueError('a path over its limit')
        info = os.lstat(name, dir_fd=fd)
        if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
            raise ValueError('not a file or directory')
        child = os.open(name, WALK if stat.S_ISDIR(info.st_mode) else READ, dir_fd=fd)
        try:
            now = os.fstat(child)
            if ((now.st_dev, now.st_ino) != (info.st_dev, info.st_ino) or stat.S_IFMT(now.st_mode) != stat.S_IFMT(info.st_mode)
                    or stat.S_ISREG(now.st_mode) and now.st_nlink != 1):
                raise ValueError('the entry was replaced, or is linked elsewhere')
            if stat.S_ISDIR(now.st_mode):
                reown(child, uid, gid, raw + b'/', protected)
            elif raw in protected:
                os.fchown(child, os.geteuid(), os.getegid())
                os.fchmod(child, 0o555 if now.st_mode & 0o100 else 0o444)
            else:
                os.fchown(child, uid, gid)
        finally:
            os.close(child)


def dependency_dir(name):
    # '.', or a path create() accepts: UTF-8 segments none of '', '.' or '..', no NUL, and at most MAX_PATH_BYTES in all.
    raw = name.encode('utf-8')  # UnicodeEncodeError, a ValueError, for a lone surrogate
    return name == '.' or (len(raw) <= MAX_PATH_BYTES and b'\0' not in raw
                           and all(part not in (b'', b'.', b'..') for part in raw.split(b'/')))


def dependency_dirs(tree):
    # The tree is root-owned, written by this run's 'dependencies' mode; its list is still read strictly and bounded.
    fd = os.open(os.path.join(tree, 'moe-dependencies.json'), READ)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_DEPENDENCY_LIST_BYTES:
            raise ValueError('not a bounded dependency list')
        stored = json.loads(b''.join(chunks(fd, info.st_size)).decode('utf-8'))
    finally:
        os.close(fd)
    dirs = stored.get('dirs') if type(stored) is dict else None
    if not (type(stored) is dict and stored.keys() == {'version', 'dirs'} and type(stored['version']) is int
            and stored['version'] == 1 and type(dirs) is list and 1 <= len(dirs) <= MAX_DEPENDENCY_DIRS
            and all(type(name) is str and dependency_dir(name) for name in dirs) and len(set(dirs)) == len(dirs)):
        raise ValueError('a malformed dependency list')
    return dirs


def wait_byte(fd, deadline):
    # One byte, b'' at EOF, or None once the time.monotonic() deadline passes first.
    with selectors.DefaultSelector() as selector:
        selector.register(fd, selectors.EVENT_READ)
        while (left := deadline - time.monotonic()) > 0:
            if selector.select(left):
                return os.read(fd, 1)
    return None


# One install as one GUARD job, started as run_bridge starts a job but with no relay, so nothing reaches the host before
# hello. The start pipe gets '+' once the job runs and EOF once the guard has exited, so both waits end by the deadline.
# The group is then SIGKILLed while the unreaped guard still pins its id, which also ends any leftover descendant, and
# the guard is reaped. True only for a guard that exited by itself in time with the job's status 0.
def run_install(argv, env, spawn, timeout):
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)  # as relay(): an inherited SIG_IGN would reap the guard unasked
    deadline = time.monotonic() + timeout
    life, life_end = os.pipe()
    start_end, start = os.pipe()
    child, exited = None, False
    try:
        try:
            child = subprocess.Popen([sys.executable, '-I', '-B', '-c', GUARD, str(life), str(start), json.dumps(spawn), *argv],
                                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                     start_new_session=True, pass_fds=(life, start), env=env)
        finally:
            os.close(life)
            os.close(start)
        if wait_byte(start_end, deadline) == b'+':
            try:
                os.write(life_end, b'0')  # stand down at once: no output pipes to drain first
            except BrokenPipeError:
                pass  # the job SIGKILLed its own group, guard included
            exited = wait_byte(start_end, deadline) == b''
    finally:
        if child is not None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            reap(child)
        os.close(life_end)
        os.close(start_end)
    return exited and child.returncode == 0


def unique_keys(pairs):
    # json.loads' object_pairs_hook. npm's JSON.parse keeps a repeated key's last value: refuse rather than guess.
    value = dict(pairs)
    if len(value) != len(pairs):
        raise ValueError('a repeated key')
    return value


def no_constant(name):
    raise ValueError(name + ' is not JSON')  # json.loads' parse_constant, for NaN, Infinity and -Infinity


def read_json(root, path, limit):
    # The JSON value of the regular file of at most limit bytes at path under the root fd, opened by blob_oid's walk, so
    # no symlink is followed. One leading BOM is dropped, as npm drops it. Anything else that is not strict UTF-8 JSON
    # raises ValueError, as do a repeated key, NaN or Infinity, and a file that is not regular or too big; nesting past
    # the recursion limit raises RecursionError. A file that grows or shrinks while it is read raises OSError, as any
    # other I/O failure does: its bytes say nothing about the file.
    fds = []
    try:
        *parents, name = path.split('/')
        for part in parents:
            fds.append(os.open(part, WALK, dir_fd=fds[-1] if fds else root))
        fds.append(os.open(name, READ, dir_fd=fds[-1] if fds else root))
        info = os.fstat(fds[-1])
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise ValueError('not a bounded regular file')
        data = b''.join(chunks(fds[-1], info.st_size))
        if os.read(fds[-1], 1):
            raise OSError('the file grew while it was read')
    finally:
        for fd in fds:
            os.close(fd)
    return json.loads(data.decode('utf-8-sig'), object_pairs_hook=unique_keys, parse_constant=no_constant)


def install_metadata(value):
    # What npm ci builds a root project's edges from, as one comparable string, or None if any of it is malformed: name
    # and version, each absent or a string, the dependency maps of string specs and peerDependenciesMeta of objects. npm
    # leaves every empty map but devDependencies out of a lockfile root, so an absent map reads as {}; null, an array or
    # a scalar never does, and json.dumps keeps true apart from 1.
    if type(value) is not dict:
        return None
    maps = {key: value.get(key, {}) for key in (*DEPENDENCY_MAPS, 'peerDependenciesMeta')}
    if not (all(type(value.get(key, '')) is str for key in ('name', 'version'))
            and all(type(entries) is dict for entries in maps.values())
            and all(type(spec) is str for key in DEPENDENCY_MAPS for spec in maps[key].values())
            and all(type(meta) is dict for meta in maps['peerDependenciesMeta'].values())):
        return None
    return json.dumps([value.get('name'), value.get('version'), maps], sort_keys=True)


class CandidateDependencyInvalid(Exception):
    # The candidate's own files refuse the install (82). It carries no candidate text, and is neither a ValueError nor
    # an OSError, so no infrastructure handler (81) catches it.
    pass


def approved_project(root, at):
    # The lockfile's root entry is the authority: packages[''] of a lockfileVersion 2 or 3 lockfile (an exact int, never
    # true or 2.0), whose install metadata package.json must equal, with no unapproved control besides. The lockfile is
    # approved and protected, so its faults are the environment's: False, or the read's own error. package.json is the
    # candidate's: missing, linked, not regular, oversized, not strict JSON or not matching raises
    # CandidateDependencyInvalid. Any other OSError (EACCES, EIO, a file resized while read) proves nothing, and
    # propagates.
    lock = read_json(root, at + 'package-lock.json', MAX_LOCKFILE_BYTES)
    if not (type(lock) is dict and type(lock.get('lockfileVersion')) is int and lock['lockfileVersion'] in (2, 3)
            and type(lock.get('packages')) is dict):
        return False
    locked = install_metadata(lock['packages'].get(''))
    if locked is None:
        return False
    try:
        package = read_json(root, at + 'package.json', MAX_PACKAGE_JSON_BYTES)
    except OSError as error:
        if error.errno not in (errno.ENOENT, errno.ELOOP):  # ELOOP: O_NOFOLLOW met a symlink
            raise
        raise CandidateDependencyInvalid() from None
    except (ValueError, RecursionError):
        raise CandidateDependencyInvalid() from None
    if install_metadata(package) != locked or any(key in package for key in UNAPPROVED_CONTROLS):
        raise CandidateDependencyInvalid()
    return True


# Every listed directory is checked before any install runs: approved_project reads its lockfile and package.json by
# blob_oid's walk, so no link is followed, and it holds no npm-shrinkwrap.json or .npmrc. npm ci would install candidate
# bytes from either: it prefers a shrinkwrap to the approved lockfile, and an .npmrc's dry-run keeps a committed
# node_modules. With no package.json, or inside a parent's workspaces (OFFLINE_INSTALL_ARGS sets --workspaces=false), it
# installs a parent's lockfile. It also builds the root's dependency edges from package.json, then checks the tree it
# resolves against the lockfile by version only: a same-version file: spec, alias or override there would install bytes
# the lockfile does not name for that dependency, so package.json must ask for exactly what the lockfile root records.
# Each cwd is a path GUARD's root chdir follows, which is safe: reown refused every link in the workspace (so lexists
# follows none either), and since then only the pinned npm, running no scripts, has run as the check identity.
# False is the environment's failure (81). A candidate refusal in one directory raises CandidateDependencyInvalid (82)
# only once every directory is checked, so a fault of the environment in any directory still returns False.
def install_dependencies(workspace, tree, toolchain, env, spawn, timeout):
    try:
        dirs = dependency_dirs(tree)
        root = os.open(workspace, WALK)
        refused = False
        try:
            for at in ('' if name == '.' else name + '/' for name in dirs):
                try:
                    if not approved_project(root, at):
                        return False
                    if any(os.path.lexists(os.path.join(workspace, at + file))
                           for file in ('npm-shrinkwrap.json', '.npmrc')):
                        raise CandidateDependencyInvalid()
                except CandidateDependencyInvalid:
                    refused = True
        finally:
            os.close(root)
        if refused:
            raise CandidateDependencyInvalid()
        argv = [toolchain + '/bin/node', toolchain + '/lib/node_modules/npm/bin/npm-cli.js', 'ci', *OFFLINE_INSTALL_ARGS,
                '--cache', tree]
        return all(run_install(argv, env, {**spawn, 'cwd': workspace if name == '.' else os.path.join(workspace, name)}, timeout)
                   for name in dirs)
    except (ValueError, RecursionError, OSError):
        return False


# One check session runs one check job: the host's approved command, never candidate bytes, as ['/bin/sh', '-c',
# command] in the materialized WORKSPACE, with no agent socket. identity is (uid, gid, groups) as in start_job; netns
# False skips GUARD's network namespace, for a non-root test only. workspace, sessions, identity and netns are injectable
# from Python only (tests). A refusal writes no frame and starts no job: 74 host EOF, 65 a malformed or disallowed
# frame, 71 no account, 66 no workspace, 79 a protected path that does not hold its approved blob, 65 a workspace entry
# reown refuses, 71 a failed re-own, no session home or a failed protect_mounts, 81 a failed dependency install phase
# (CQ-R11e5; toolchain, dependencies, dependencies_manifest and install_timeout are injectable from Python only too),
# 82 a dependency phase the candidate's own files refuse. After the observation, 80 is a protected path the job changed.
def check_job(in_fd, out_fd, workspace=WORKSPACE, sessions=SESSIONS, identity=None, netns=True, toolchain=TOOLCHAIN,
              dependencies=DEPENDENCIES, dependencies_manifest=DEPENDENCIES_MANIFEST, install_timeout=INSTALL_TIMEOUT):
    try:
        frame = read_check(in_fd)
    except (EOFError, OSError):
        return os.EX_IOERR
    except (ValueError, RecursionError):  # JSON, UTF-8 and UTF-16 errors are ValueErrors
        return os.EX_DATAERR
    if identity is None:
        try:
            entry = pwd.getpwnam(CHECK_IDENTITY)
        except KeyError:
            return os.EX_OSERR
        identity = (entry.pw_uid, entry.pw_gid, [])
    uid, gid, groups = identity
    try:
        root = os.open(workspace, WALK)  # never through a symlink
    except OSError:
        return os.EX_NOINPUT
    paths = [entry['path'] for entry in frame['protected']]
    try:
        if not holds(root, frame['protected']):
            return PROTECTED_MISMATCH  # the candidate does not carry the approved bytes
        reown(root, uid, gid, protected=frozenset(path.encode('utf-8') for path in paths))
        home = session_home(sessions, uid, gid)
        if paths:
            protect_mounts(workspace, paths)  # a partial setup is never used: any failure is 71 and no job starts
    except (ValueError, RecursionError):
        return os.EX_DATAERR
    except OSError:
        return os.EX_OSERR
    finally:
        os.close(root)
    env = {'PATH': toolchain + '/bin:' + JOB_PATH, 'HOME': home, 'USER': CHECK_IDENTITY, 'LOGNAME': CHECK_IDENTITY, 'LANG': 'C.UTF-8',
           'MOE_CHECK_ID': frame['id']}
    spawn = {'user': uid, 'group': gid, 'extra_groups': groups, 'umask': 0o077, 'cwd': workspace, 'rlimits': CHECK_RLIMITS,
             'netns': netns}
    try:
        if os.path.lexists(dependencies_manifest) and not install_dependencies(workspace, dependencies, toolchain, env,
                                                                                spawn, install_timeout):
            return DEPENDENCIES_FAILED  # before relay(): no hello, no frame, no check job
    except CandidateDependencyInvalid:
        return DEPENDENCIES_CANDIDATE_INVALID  # as early, and no install started either
    code = relay(['/bin/sh', '-c', frame['command']], out_fd, in_fd, job={'env': env, 'spawn': spawn})
    # relay's 0 means its observation frame is written; a failed relay is already a failure and is never re-checked.
    return PROTECTED_CHANGED if code == 0 and paths and not unchanged(workspace, frame['protected']) else code


def file_identity(root, path, size):
    # (executable, size, sha256) of the regular, singly linked file at a manifest path under the root fd, or None, by
    # blob_oid's walk: WALK for every parent and READ for the file, so no symlink is ever followed. A file that is gone,
    # replaced, hard-linked, unreadable, not of the manifest's size (never read, so hashing stays within the manifest's
    # bytes), or grows or shrinks while it is read is None; a path materialize would have refused is a ValueError.
    parts = path.split('/')
    if any(part in ('', '.', '..') for part in parts):
        raise ValueError('not a relative manifest path')
    *parents, name = parts
    fds = []
    try:
        for part in parents:
            fds.append(os.open(part, WALK, dir_fd=fds[-1] if fds else root))
        fds.append(os.open(name, READ, dir_fd=fds[-1] if fds else root))
        info = os.fstat(fds[-1])
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size != size:
            return None
        digest = hashlib.sha256()
        for chunk in chunks(fds[-1], size):
            digest.update(chunk)
        return None if os.read(fds[-1], 1) else (bool(info.st_mode & 0o100), size, digest.hexdigest())
    except OSError:
        return None
    finally:
        for fd in fds:
            os.close(fd)


# CQ-R11f verify, after a check session while its fresh check VM still runs. It counts the manifest paths that no longer
# hold their materialized bytes and exec bit, in the manifest's (byte) order, and writes only that count. It runs as
# root and read-only, which is safe: only manifest paths are opened, each component O_NOFOLLOW, so a name the job added
# is never read and a link never followed. It sees the workspace as the job left it, never a change the job restored
# before it exited. A missing or malformed manifest or workspace root exits 65 and a gone host 74, each with no frame.
def verify(out_fd, workspace=WORKSPACE, manifest=WORKSPACE_MANIFEST):
    try:
        known = read_manifest(manifest)
        root = os.open(workspace, WALK)
    except (OSError, ValueError, RecursionError):  # JSON and UTF-8 errors are ValueErrors
        return os.EX_DATAERR
    try:
        changed = sum(file_identity(root, path, row[1]) != tuple(row) for path, row in known.items())
        write_frame(out_fd, {'kind': 'verified', 'changed': changed})
        return 0
    except ValueError:
        return os.EX_DATAERR
    except OSError:
        return os.EX_IOERR  # a gone host
    finally:
        os.close(root)


# CQ-R10d3a agents. Each binary is staged root-only in a 0700 directory INSIDE agents (dir_fd-relative, so a swapped
# agents path cannot redirect it) and checked against its header. Only after the end frame, with nothing after it, is
# each renamed onto agents/<cli>: a whole-file replacement of any older install, never a write in place. A handled
# refusal installs nothing, leaves no staging and writes no frame; a crash can leave only the staging directory. Each
# rename is atomic but the set is not: an I/O failure between two (74) can leave old and new binaries side by side, each
# whole, which the readiness pinned-hash probe refuses. Callers serialize per VM through R06's job lease.
def install_agents(in_fd, out_fd, agents=AGENTS, owner=(0, 0)):
    name, root, staging, staged = '.staging-' + os.urandom(8).hex(), None, None, []
    try:
        try:
            os.mkdir(agents, 0o755)
        except FileExistsError:
            pass  # a symlink or a file there fails the O_NOFOLLOW|O_DIRECTORY open
        root = os.open(agents, WALK)
        own(root, owner, 0o755)
        os.mkdir(name, 0o700, dir_fd=root)
        staging = os.open(name, WALK, dir_fd=root)
        own(staging, owner, 0o700)
        frames = snapshot_frames(in_fd)
        frame = next(frames, None)
        while type(frame) is dict and frame.get('kind') == 'agent':
            head = expect(frame, 'agent', 'cli', 'size', 'sha256')
            cli, size, digest = head['cli'], head['size'], head['sha256']
            # The type first, since an unhashable cli raises TypeError in `in JOBS`; and duplicates explicitly, since
            # O_EXCL would report one as an I/O failure.
            if not (type(cli) is str and cli in JOBS and cli not in staged and type(size) is int
                    and 1 <= size <= MAX_AGENT_BYTES and type(digest) is str and DIGEST.fullmatch(digest)):
                raise ValueError('a malformed agent header')
            fd = os.open(cli, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=staging)
            staged.append(cli)
            try:
                if copy_data(frames, fd, size).hexdigest() != digest:
                    raise ValueError('an agent binary does not match its sha256')
                own(fd, owner, 0o555)
                os.fsync(fd)
            finally:
                os.close(fd)
            frame = next(frames, None)
        expect(frame, 'end')
        if not staged or next(frames, None) is not None:
            raise ValueError('an empty stream or a frame after end')
        for cli in staged:
            os.rename(cli, cli, src_dir_fd=staging, dst_dir_fd=root)
        count, staged = len(staged), []
        os.rmdir(name, dir_fd=root)
        os.fsync(root)
        write_frame(out_fd, {'kind': 'installed', 'count': count})
        return 0
    except (ValueError, RecursionError):  # binascii.Error, JSON and UTF-8 errors are ValueErrors
        return os.EX_DATAERR
    except OSError:
        return os.EX_IOERR
    finally:
        for cli in staged:  # best effort, never masking the first error; one already renamed is gone
            with contextlib.suppress(OSError):
                os.unlink(cli, dir_fd=staging)
        if staging is not None:
            os.close(staging)
            with contextlib.suppress(OSError):
                os.rmdir(name, dir_fd=root)
        if root is not None:
            os.close(root)


MAX_TOOLCHAIN_BYTES = 134217728  # mirrors snapshot-transfer.mjs


def receive_toolchain(in_fd, archive):
    frames = snapshot_frames(in_fd)
    head = expect(next(frames, None), 'toolchain', 'version', 'size', 'sha256')
    size, digest = head['size'], head['sha256']
    if not (type(head['version']) is int and head['version'] == 1 and type(size) is int and 1 <= size <= MAX_TOOLCHAIN_BYTES
            and type(digest) is str and DIGEST.fullmatch(digest)):
        raise ValueError('a malformed toolchain header')
    fd = os.open(archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        actual = copy_data(frames, fd, size).hexdigest()
        os.fsync(fd)
    finally:
        os.close(fd)
    expect(next(frames, None), 'end')
    if next(frames, None) is not None or actual != digest:
        raise ValueError('a mismatched toolchain or bytes after end')
    return digest


def toolchain_members(tar):
    for member in tar:
        # data_filter strips leading slashes; our contract refuses them instead of silently rewriting a name.
        if os.path.isabs(member.name) or '..' in member.name.split('/'):
            raise ValueError('an unsafe toolchain member name')
        yield member


def link_escapes(target, depth):
    # Rename-invariant: climb no higher than the link's depth below top, and never '..' after a name (it may be a link).
    parts = target.split('/')
    ups = next((i for i, part in enumerate(parts) if part != '..'), len(parts))
    return os.path.isabs(target) or ups > depth or '..' in parts[ups:]


def extract_toolchain(archive, tree):
    os.mkdir(tree, 0o700)
    with tarfile.open(archive, mode='r:*') as tar:
        tar.extractall(tree, members=toolchain_members(tar), filter='data')
    entries = os.listdir(tree)
    if len(entries) != 1 or not stat.S_ISDIR(os.lstat(os.path.join(tree, entries[0])).st_mode):
        raise ValueError('not one top-level toolchain directory')
    top = os.path.realpath(os.path.join(tree, entries[0]))
    for root, dirs, files in os.walk(top, followlinks=False):
        depth = root[len(top):].count(os.sep)  # directories between top and root's entries
        for path in [root, *(os.path.join(root, name) for name in dirs + files)]:
            info = os.lstat(path)
            if info.st_uid != os.geteuid() or (not stat.S_ISLNK(info.st_mode) and info.st_mode & 0o7022):
                raise ValueError('an unsafe toolchain owner or mode')
            if stat.S_ISLNK(info.st_mode) and (os.path.commonpath([top, os.path.realpath(path)]) != top
                                               or link_escapes(os.readlink(path), depth)):
                raise ValueError('a link outside the installed toolchain')
    return top


def install_toolchain(in_fd, out_fd, toolchain=TOOLCHAIN):
    if not hasattr(tarfile, 'data_filter'):
        return os.EX_OSERR
    if os.path.lexists(toolchain):
        return os.EX_CANTCREAT
    staging = None
    previous_umask = os.umask(0o022)  # data_filter ignores directory modes; even an inherited zero umask is safe
    try:
        parent = os.path.dirname(toolchain)
        os.makedirs(parent, 0o755, exist_ok=True)
        staging = tempfile.mkdtemp(prefix='.toolchain-', dir=parent)  # root 0700, never exposed to the job
        archive = os.path.join(staging, 'archive')
        digest = receive_toolchain(in_fd, archive)
        top = extract_toolchain(archive, os.path.join(staging, 'tree'))
        # Only root can create a destination under /opt/moe; callers serialize per VM through R06's job lease.
        # rename could replace an empty directory created after lexists, but no job identity can race this boundary.
        os.rename(top, toolchain)
        try:
            write_frame(out_fd, {'kind': 'installed', 'sha256': digest})
        except OSError:
            shutil.rmtree(toolchain, ignore_errors=True)
            raise
        return 0
    except (ValueError, OverflowError, RecursionError, EOFError, KeyError, tarfile.TarError, lzma.LZMAError, zlib.error):
        return os.EX_DATAERR
    except OSError:
        return os.EX_IOERR
    finally:
        os.umask(previous_umask)
        if staging is not None:
            shutil.rmtree(staging, ignore_errors=True)


# geteuid and the keywords (seams) of start_job or check_job are injectable from Python only (tests), never from argv or
# the environment. No refusal writes to stdout.
def main(argv, geteuid=os.geteuid, **seams):
    # bridgeArgv and snapshotArgv pass exactly these, CQ-R11c's checkArgv passes ['check'] and CQ-R10d3 ['agents'].
    if argv not in (['bridge'], ['check'], ['materialize'], ['export'], ['verify'], ['agents'], ['toolchain'], ['dependencies']):
        return os.EX_USAGE
    if geteuid() != 0:
        return os.EX_NOPERM
    if argv == ['dependencies']:
        return dependencies(0, 1)
    if argv == ['toolchain']:
        return install_toolchain(0, 1)
    if argv == ['materialize']:
        return materialize(0, 1)
    if argv == ['agents']:
        return install_agents(0, 1)
    if argv == ['export']:
        return export(1)
    if argv == ['verify']:
        return verify(1)
    if argv == ['check']:
        return check_job(0, 1, **seams)
    return start_job(0, 1, **seams)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
