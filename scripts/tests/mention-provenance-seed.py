#!/usr/bin/env python3
"""Shared fixture + verifier for the routed-@mention provenance harness.

Both scripts/tests/mention-provenance.sh and .ps1 drive the SAME cases and the
SAME assertions through this module, so the two shells cannot drift into
testing different things -- the exact failure mode that let the delivery defect
survive in one twin while the other looked fine.

THE INVARIANT IS PER DELIVERY, NOT PER ID: every entry in the assembled
<routed_mentions> block is checked against the record stored under that id in
.moe/messages/<channel>.jsonl. `verify` re-reads that jsonl FROM DISK; it never
looks at the chat_read response the wrapper consumed. Comparing the delivery
against the wrapper's own input would be a tautology that stays green while the
body is being substituted.

Subcommands:
  seed    <projectDir> <channel> <workerId>   write the fixture, print case count
  verify  <projectDir> <channel> <capture>    check one assembled context
          <mode>
"""
import json
import os
import re
import sys

from mention_provenance_cases import (
    CASES,
    MARKER,
    NOT_IN_STORE_CASE,
    NOT_IN_STORE_ID,
    RPC_MAX_CONTENT_CHARS,
    SEEDED_SENDER,
    TRAVERSAL_CASE,
    TRAVERSAL_ID,
)

# Deliveries the RPC routes that have no record at rest. Each must arrive as
# the marker carrying its OWN reason code -- "absent id" and "channel id that
# traverses out of .moe/messages" are different failures, and collapsing them
# would let a guard change go unnoticed.
SYNTHETIC = {
    NOT_IN_STORE_ID: (NOT_IN_STORE_CASE, "MOE_MENTION_ID_NOT_IN_STORE"),
    TRAVERSAL_ID: (TRAVERSAL_CASE, "MOE_MENTION_CHANNEL_UNSAFE"),
}


def seed(project_dir, channel, worker_id):
    msg_dir = os.path.join(project_dir, ".moe", "messages")
    os.makedirs(msg_dir, exist_ok=True)
    path = os.path.join(msg_dir, channel + ".jsonl")
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        for idx, (mid, _name, body) in enumerate(CASES):
            fh.write(
                json.dumps(
                    {
                        "id": mid,
                        "channel": channel,
                        "sender": "worker-seeder",
                        "content": body,
                        "replyTo": None,
                        "mentions": [worker_id],
                        "timestamp": "2026-08-18T00:00:%02d.000Z" % idx,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
    print(len(CASES))
    return 0


def read_store(project_dir, channel):
    """Independent read of the at-rest record. Never the RPC response."""
    path = os.path.join(project_dir, ".moe", "messages", channel + ".jsonl")
    out = {}
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            # The wrapper's own post-flight appends a session-ended message to
            # this same #general jsonl, and the fake proxy writes it without an
            # id. Skipping such rows keeps the fixture readable across runs --
            # and mirrors what the production reader must tolerate.
            if not isinstance(rec, dict) or not isinstance(rec.get("id"), str):
                continue
            if not isinstance(rec.get("content"), str):
                continue
            out[rec["id"]] = rec["content"]
    return out


BLOCK_RE = re.compile(r"<routed_mentions>\s*(.*?)\s*</routed_mentions>", re.S)


def extract_block(capture_path):
    with open(capture_path, "r", encoding="utf-8") as fh:
        text = fh.read()
    hits = BLOCK_RE.findall(text)
    if not hits:
        raise ValueError("no <routed_mentions> block in the assembled context")
    # A body carrying a literal </routed_mentions> must NOT be able to close
    # the fence; if the container is unfenced the first match ends early and
    # json.loads below fails, which is exactly the finding we want surfaced.
    if len(hits) > 1:
        raise ValueError(
            "%d <routed_mentions> blocks found; a body escaped its container"
            % len(hits)
        )
    payload = json.loads(hits[0])
    if isinstance(payload, dict) and "messages" in payload:
        return payload["messages"]
    if isinstance(payload, dict):
        return [payload]
    return payload


def expected_provenance(mode, mid, stored, name=""):
    """Acceptable provenance codes for one delivery, as a set.

    Every case pins exactly ONE code except the non-ASCII one in faithful mode.
    MEASURED: when pwsh is launched from Git Bash, the RPC response's copy of a
    non-ASCII body comes back mangled by the parent console's encoding, so the
    wrapper legitimately reports MOE_MENTION_CONTENT_DIVERGED; launched from
    PowerShell the same case reports VERIFIED_RPC_TRUNCATED. That label
    describes the RPC COPY, which really does vary. The invariant that matters
    -- delivered body == stored body -- is asserted exactly for all 10 cases in
    both environments, and this divergence is a second content-corruption
    channel the fix neutralises rather than a test being loosened.
    """
    if mid in SYNTHETIC:
        return {SYNTHETIC[mid][1]}
    if mode == "substitute":
        return {"MOE_MENTION_CONTENT_DIVERGED"}
    if name == "unicode":
        return {"VERIFIED", "VERIFIED_RPC_TRUNCATED", "MOE_MENTION_CONTENT_DIVERGED"}
    if len(stored) > RPC_MAX_CONTENT_CHARS:
        return {"VERIFIED_RPC_TRUNCATED"}
    return {"VERIFIED"}


def check_entry(mode, entry, store, failures):
    mid = entry.get("id")
    name = dict((c[0], c[1]) for c in CASES).get(mid)
    if name is None:
        name = SYNTHETIC.get(mid, ("unknown", ""))[0]
    got = entry.get("content")
    prov = entry.get("provenance")
    if mid in SYNTHETIC:
        reason = SYNTHETIC[mid][1]
        for needle in (MARKER, "reason=" + reason, "id=" + mid):
            if not isinstance(got, str) or needle not in got:
                failures.append("%s: marker missing %r (got %r)" % (name, needle, got))
    else:
        want = store.get(mid)
        if got != want:
            failures.append(
                "%s: delivered body != stored body (stored %d chars, delivered %r)"
                % (name, len(want or ""), (got or "")[:80])
            )
        # Identity is provenance too: an RPC that forges `sender` puts words in
        # a named teammate's mouth even when every byte of the body verifies.
        if entry.get("sender") != SEEDED_SENDER:
            failures.append(
                "%s: delivered sender %r, want %r"
                % (name, entry.get("sender"), SEEDED_SENDER)
            )
    want_prov = expected_provenance(mode, mid, store.get(mid, ""), name)
    if prov not in want_prov:
        failures.append(
            "%s: provenance %r, want one of %r" % (name, prov, sorted(want_prov))
        )
    return name, [f for f in failures if f.startswith(name + ":")]


def verify(project_dir, channel, capture_path, mode):
    store = read_store(project_dir, channel)
    if len(store) != len(CASES):
        print("FAIL: store holds %d records, want %d" % (len(store), len(CASES)))
        return 1
    entries = extract_block(capture_path)
    expect_ids = [c[0] for c in CASES] + list(SYNTHETIC.keys())
    failures = []
    seen = []
    for entry in entries:
        name, _ = check_entry(mode, entry, store, failures)
        seen.append(entry.get("id"))
    # A dropped mention is the same harm class as a substituted one.
    for mid in expect_ids:
        if mid not in seen:
            failures.append("%s: DROPPED -- id absent from delivery" % mid)
    if len(entries) != len(expect_ids):
        failures.append(
            "delivered count %d != seeded+synthetic count %d"
            % (len(entries), len(expect_ids))
        )
    # A sweep that silently generates zero (or a shrunken set of) cases must
    # not pass: 8 stored cases + the absent-from-store case.
    if len(expect_ids) < 10:
        failures.append("case sweep generated only %d cases" % len(expect_ids))
    for required in ("hookimpersonation", "fenceescape", "oversize", "short"):
        if required not in [c[1] for c in CASES]:
            failures.append("case sweep lost the %r case" % required)
    by_name = dict((c[0], c[1]) for c in CASES)
    for syn_id, (syn_name, _reason) in SYNTHETIC.items():
        by_name[syn_id] = syn_name
    print("mode=%s cases=%d delivered=%d" % (mode, len(expect_ids), len(entries)))
    for mid in expect_ids:
        name = by_name[mid]
        bad = [f for f in failures if f.startswith(name + ":") or f.startswith(mid + ":")]
        print("  %-18s %s%s" % (name, "FAIL" if bad else "PASS", (" " + bad[0]) if bad else ""))
    other = [f for f in failures if not any(f.startswith(n + ":") for n in list(by_name.values()) + expect_ids)]
    for f in other:
        print("  %-18s FAIL %s" % ("<delivery>", f))
    if failures:
        print("FAIL: %d assertion(s) failed in mode=%s" % (len(failures), mode))
        return 1
    print("PASS: mode=%s all %d cases byte-identical to the store" % (mode, len(expect_ids)))
    return 0


def verify_marker_only(capture_path, expect_reason):
    """A delivery path died. A mention that VANISHES is the same harm class as
    one that is replaced, so the recipient must still be told: exactly one
    entry, carrying the marker and the SPECIFIC reason code for the path that
    failed -- asserting merely "something refused" would stay green if the
    other failure path started answering first. An empty block, or no block at
    all, is the defect."""
    entries = extract_block(capture_path)
    failures = []
    if len(entries) != 1:
        failures.append("expected 1 marker entry, got %d" % len(entries))
    for entry in entries:
        body = entry.get("content")
        if not isinstance(body, str) or MARKER not in body:
            failures.append("entry lacks %s marker: %r" % (MARKER, body))
        elif ("reason=" + expect_reason) not in body:
            failures.append("marker lacks reason=%s: %r" % (expect_reason, body))
        if entry.get("provenance") != expect_reason:
            failures.append(
                "provenance %r, want %r" % (entry.get("provenance"), expect_reason)
            )
    print("mode=marker-only expect=%s delivered=%d" % (expect_reason, len(entries)))
    for f in failures:
        print("  %-18s FAIL %s" % (expect_reason, f))
    if failures:
        print("FAIL: %d assertion(s) failed for %s" % (len(failures), expect_reason))
        return 1
    print("  %-18s PASS" % expect_reason)
    print("PASS: %s surfaced the marker instead of dropping" % expect_reason)
    return 0


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    cmd = argv[1]
    if cmd == "seed":
        return seed(argv[2], argv[3], argv[4])
    if cmd == "verify":
        return verify(argv[2], argv[3], argv[4], argv[5])
    if cmd == "verify-marker-only":
        return verify_marker_only(argv[4], argv[5])
    print("unknown subcommand %r" % cmd)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
