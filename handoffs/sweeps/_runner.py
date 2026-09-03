#!/usr/bin/env python3
"""The shared engine behind every `*-sweep.py`.

A seeded sweep used to be strictly serial: apply a seed, rebuild, run the gate,
restore, repeat. That spends half its wall clock with one core busy and the rest
of the machine idle, because a build and a gate run never overlap.

**Only the build has to be serial.** Seeds mutate the same source tree and share
one cargo target directory, so exactly one may be applied at a time. A *gate*
run does not touch the source at all — it takes the candidate binary as an
argument. So the binary is copied aside the moment it is built, the source is
restored, and the next seed starts building while the previous seed's gate runs
against its own frozen copy.

That makes this a producer/consumer: one thread applying and building, a small
pool running gates. Total time drops to roughly the build time alone.

Three things this has to be careful about:

* **Disk.** A debug binary is large and there is one per seed. The producer
  blocks once a few are in flight, and each gate deletes its own copy when it
  finishes, so only a handful ever exist at once.
* **Ports.** Two gate runs of the same script at once would collide on any port
  the gate itself holds. Each worker is handed a distinct one through
  `NMI_GATE_HELD_PORT`; a gate that holds a port must read it from there.
* **Contention.** Every gate run starts two daemons, so the pool is small on
  purpose. A gate that times out under load reports a divergence that is not
  there, which is worse than being slow.
"""
import os
import queue
import shutil
import subprocess
import threading

#: How many gate runs may be in flight. Each one starts two daemons, so this is
#: about the machine's patience rather than its core count.
DEFAULT_WORKERS = 3

#: The first port handed to a worker that holds one. Gates read their own from
#: `NMI_GATE_HELD_PORT`, so two runs never contend for the same one.
HELD_PORT_BASE = 4590


def read(root, path):
    with open(os.path.join(root, path), encoding="utf-8") as handle:
        return handle.read()


def write(root, path, text):
    with open(os.path.join(root, path), "w", encoding="utf-8") as handle:
        handle.write(text)


def cargo_is_busy(root):
    probe = subprocess.run(
        ["cargo", "build", "-p", "nomoreide-cli", "--offline", "-q"],
        cwd=root, capture_output=True, text=True, timeout=180,
    )
    return "Blocking waiting for file lock" in probe.stderr


def _verdict(expected, returncode, stdout):
    names = {
        line.split()[1]
        for line in stdout.splitlines()
        if line.startswith("FAIL ") and len(line.split()) > 1
    }
    if returncode == 0:
        return "GATE-DID-NOT-BITE", expected
    if expected in names:
        return "caught", f"{len(names)} case(s), incl. {expected}"
    return "CAUGHT-WRONG-CASE", f"expected {expected}, got {sorted(names)[:3]}"


def run_sweep(root, seeds, gate_script, workers=DEFAULT_WORKERS):
    """Apply each seed, build, and gate it. Returns an exit code.

    `seeds` is a list of `(name, path, old, new, expected_case)`. Every `old`
    must appear exactly once in its file, which is checked before anything is
    written — a stale anchor is a sweep that silently tests nothing.
    """
    backups = {path: read(root, path) for path in {seed[1] for seed in seeds}}

    stale = [
        (name, backups[path].count(old))
        for name, path, old, _new, _expected in seeds
        if backups[path].count(old) != 1
    ]
    if stale:
        for name, count in stale:
            print(f"SEED-ANCHOR-STALE  {name}  (matches: {count})")
        print("\nFix the anchors before sweeping; nothing was changed.")
        return 2

    if cargo_is_busy(root):
        print("Another cargo build holds the target lock; a seeded sweep that races one")
        print("tests a binary that is one edit behind its source.")
        return 2

    staging = os.path.join(root, "target", "sweep-binaries")
    shutil.rmtree(staging, ignore_errors=True)
    os.makedirs(staging, exist_ok=True)

    # Bounded, so the producer cannot fill the disk with debug binaries while
    # the pool is behind.
    pending = queue.Queue(maxsize=max(1, workers))
    results = {}
    lock = threading.Lock()
    order = [name for name, *_ in seeds]

    def produce():
        for name, path, old, new, expected in seeds:
            source = backups[path]
            write(root, path, source.replace(old, new, 1))
            build = subprocess.run(
                ["cargo", "build", "-p", "nomoreide-cli"],
                cwd=root, capture_output=True, text=True,
            )
            write(root, path, source)
            if build.returncode != 0:
                with lock:
                    results[name] = ("SEED-DID-NOT-COMPILE", build.stderr[-300:])
                print(f"{'SEED-DID-NOT-COMPILE':24} {name}", flush=True)
                continue
            binary = os.path.join(staging, name)
            shutil.copy2(os.path.join(root, "target", "debug", "nomoreide"), binary)
            pending.put((name, binary, expected))
        for _ in range(workers):
            pending.put(None)

    def consume(worker):
        while True:
            job = pending.get()
            if job is None:
                return
            name, binary, expected = job
            environment = dict(os.environ)
            # Its own port, so two gate runs of a gate that holds one do not
            # meet each other instead of the holder they meant to test.
            environment["NMI_GATE_HELD_PORT"] = str(HELD_PORT_BASE + worker)
            gate = subprocess.run(
                ["node", "--import", "tsx", gate_script, binary],
                cwd=root, capture_output=True, text=True, env=environment,
            )
            verdict = _verdict(expected, gate.returncode, gate.stdout)
            with lock:
                results[name] = verdict
            print(f"{verdict[0]:24} {name}", flush=True)
            os.remove(binary)

    producer = threading.Thread(target=produce)
    consumers = [threading.Thread(target=consume, args=(index,)) for index in range(workers)]
    producer.start()
    for consumer in consumers:
        consumer.start()
    try:
        producer.join()
        for consumer in consumers:
            consumer.join()
    finally:
        for path, source in backups.items():
            write(root, path, source)
        shutil.rmtree(staging, ignore_errors=True)
        # The tree is clean again, but the binary on disk is still the last
        # seed's. Rebuild, or the next thing to run tests a mutation.
        subprocess.run(["cargo", "build", "-p", "nomoreide-cli"], cwd=root,
                       capture_output=True, text=True)

    print("\n=== sweep ===")
    for name in order:
        verdict, detail = results.get(name, ("NOT-RUN", ""))
        print(f"{verdict:24} {name}  ({detail})")
    caught = sum(1 for verdict, _ in results.values() if verdict == "caught")
    print(f"\ncaught {caught}/{len(order)}")
    return 0 if caught == len(order) else 1


def select(seeds, argv):
    """Filter `seeds` by the names on the command line, or return them all."""
    wanted = set(argv)
    if not wanted:
        return seeds, None
    unknown = wanted - {seed[0] for seed in seeds}
    if unknown:
        return None, "no such seed: " + ", ".join(sorted(unknown))
    return [seed for seed in seeds if seed[0] in wanted], None
