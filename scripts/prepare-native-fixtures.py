#!/usr/bin/env python3
"""Prepare digest-bound native CI fixture inputs without executing them."""

import argparse
import gzip
import hashlib
import io
import os
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path

MAX_ARCHIVE_BYTES = 8 * 1024 * 1024
MAX_ORBIT_BYTES = 2 * 1024 * 1024
FIXTURE_HOST = ".ci/af-crossrepo/host/fixture-host.py"
PROCESS_HOST = ".ci/af-crossrepo/host/orbit-process-host.py"
ORBIT_ARCHIVE = ".ci/af-crossrepo/inputs/orbit-6c8-api.tar.gz"


class FixtureError(ValueError):
    """Fixture input or destination does not satisfy the preparation contract."""


@dataclass(frozen=True)
class FixtureBinding:
    """An immutable source identity for the preparation library's caller."""

    native_head: str
    bundle_head: str
    fixture_host_sha256: str
    process_host_sha256: str
    archive_sha256: str
    orbit_sha256: str


PRODUCTION_BINDING = FixtureBinding(
    native_head="34ed5877b2a92c3b65081ad13b19803d44d8096d",
    bundle_head="1540ec475827926204b739a28ec0d6c02c967472",
    fixture_host_sha256="83e69a6b7f44764009be6929291e55883e9f79ffb35aa9902e5b041bd125c413",
    process_host_sha256="2ab30a43e5282a0e6253208a1e97bdbe62f2570a42654db69ff615637b2c1dde",
    archive_sha256="03498d768a119f4247fa84b2b6b7c4a5a0c3635f9b253d8e25fd3c48360c4470",
    orbit_sha256="11a3434d6e74038b1176b51dd1c1781a55806b1fcbfb2eac0c7d0d326796e21c",
)


def canonical_path(value: str | Path, label: str, *, fresh: bool = False) -> Path:
    """Reject aliases and control characters instead of silently normalizing them."""
    raw = os.fspath(value)
    if not raw or any(ord(char) < 32 or ord(char) == 127 for char in raw):
        raise FixtureError(f"{label} contains invalid control characters")
    path = Path(raw)
    if not path.is_absolute() or os.path.normpath(raw) != raw:
        raise FixtureError(f"{label} must be an absolute canonical path")
    # Walk every component, including a dangling final symlink. resolve() alone
    # would allow an alias whose target happens to normalize to the same path.
    for component in reversed((path, *path.parents)):
        if component.is_symlink():
            raise FixtureError(f"{label} contains a symlink")
    if fresh:
        if os.path.lexists(path):
            raise FixtureError(f"{label} already exists; a fresh destination is required")
        if not path.parent.is_dir() or path.parent.resolve(strict=True) != path.parent:
            raise FixtureError(f"{label} parent must be an existing canonical directory")
    elif not path.exists() or path.resolve(strict=True) != path:
        raise FixtureError(f"{label} must exist at its canonical path")
    return path


def git_output(root: Path, *args: str) -> str:
    """Read Git metadata without refreshing the index or running fsmonitor code."""
    environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    environment.update({
        "GIT_OPTIONAL_LOCKS": "0",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_NO_REPLACE_OBJECTS": "1",
    })
    try:
        result = subprocess.run(
            ["git", "--no-optional-locks", "-c", "core.fsmonitor=false",
             "-c", "core.untrackedCache=false", "-C", str(root), *args],
            env=environment, stdin=subprocess.DEVNULL, capture_output=True,
            text=True, check=True, timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise FixtureError(f"cannot verify source worktree: {root}") from error
    return result.stdout.rstrip("\n")


def verify_source(root: Path, expected_head: str) -> None:
    if not root.is_dir() or git_output(root, "rev-parse", "--show-toplevel") != str(root):
        raise FixtureError("source root must be the exact Git worktree root")
    if git_output(root, "rev-parse", "--verify", "HEAD^{commit}") != expected_head:
        raise FixtureError(f"source revision does not match the approved binding: {root}")
    if git_output(root, "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"):
        raise FixtureError(f"source worktree must be clean: {root}")


def bound_file(root: Path, relative: str, expected_sha256: str) -> bytes:
    path = canonical_path(root / relative, "bound private file")
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    try:
        descriptor = os.open(path, flags)
        with os.fdopen(descriptor, "rb") as source:
            metadata = os.fstat(source.fileno())
            if not stat.S_ISREG(metadata.st_mode):
                raise FixtureError("bound private input must be a regular file")
            if metadata.st_size > MAX_ARCHIVE_BYTES:
                raise FixtureError("bound private input exceeds the size limit")
            data = source.read(MAX_ARCHIVE_BYTES + 1)
    except OSError as error:
        raise FixtureError("cannot read bound private regular file") from error
    if len(data) > MAX_ARCHIVE_BYTES:
        raise FixtureError("bound private input exceeds the size limit")
    if hashlib.sha256(data).hexdigest() != expected_sha256:
        raise FixtureError(f"private input digest does not match the approved binding: {relative}")
    return data


def orbit_member(archive: bytes, expected_sha256: str) -> bytes:
    """Validate bounded archive bytes; never use tar's filesystem extraction."""
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(archive)) as compressed:
            expanded = compressed.read(MAX_ARCHIVE_BYTES + 1)
        if len(expanded) > MAX_ARCHIVE_BYTES:
            raise FixtureError("expanded archive exceeds the size limit")
        with tarfile.open(fileobj=io.BytesIO(expanded), mode="r:", ignore_zeros=True) as source:
            members = source.getmembers()
            if len(members) != 1:
                raise FixtureError("archive must contain exactly one approved member")
            member = members[0]
            if (member.name != "orbit_server.py"
                    or member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE)
                    or member.linkname or member.pax_headers or member.offset != 0
                    or member.offset_data != 512
                    or member.size > MAX_ORBIT_BYTES):
                raise FixtureError("archive member must be the bounded regular orbit_server.py")
            # Reject extension headers, concatenated archives and nonzero tails,
            # even if tarfile would treat them as metadata or end-of-archive.
            end = member.offset_data + ((member.size + 511) // 512) * 512
            if any(expanded[end:]) or len(expanded) < end + 1024:
                raise FixtureError("archive has unexpected trailing entries or invalid termination")
            content = source.extractfile(member)
            if content is None:
                raise FixtureError("archive member cannot be read")
            with content:
                payload = content.read(MAX_ORBIT_BYTES + 1)
            if len(payload) != member.size:
                raise FixtureError("archive member has an invalid size")
    except (OSError, EOFError, tarfile.TarError) as error:
        raise FixtureError("invalid orbit archive") from error
    if hashlib.sha256(payload).hexdigest() != expected_sha256:
        raise FixtureError("orbit member digest does not match the approved binding")
    return payload


def prepare_fixtures(
    native_root: str | Path, bundle_root: str | Path,
    output_root: str | Path, env_file: str | Path, *, binding: FixtureBinding,
) -> dict[str, str]:
    """Validate all inputs, then create fresh QA data and atomically publish env."""
    native = canonical_path(native_root, "native root")
    bundle = canonical_path(bundle_root, "bundle root")
    output = canonical_path(output_root, "QA output root", fresh=True)
    environment_file = canonical_path(env_file, "environment file", fresh=True)
    if native.is_relative_to(bundle) or bundle.is_relative_to(native):
        raise FixtureError("source roots must be separate worktrees")
    for destination in (output, environment_file):
        if any(destination.is_relative_to(source) for source in (native, bundle)):
            raise FixtureError("destinations must be outside both source worktrees")
    if output == environment_file:
        raise FixtureError("QA output and environment file must be separate destinations")
    github_env = os.environ.get("GITHUB_ENV")
    if github_env and environment_file == Path(github_env).resolve():
        raise FixtureError("environment file must not be the GITHUB_ENV command channel")

    verify_source(native, binding.native_head)
    verify_source(bundle, binding.bundle_head)
    bound_file(bundle, FIXTURE_HOST, binding.fixture_host_sha256)
    bound_file(bundle, PROCESS_HOST, binding.process_host_sha256)
    archive = bound_file(bundle, ORBIT_ARCHIVE, binding.archive_sha256)
    payload = orbit_member(archive, binding.orbit_sha256)
    # Recheck sources after reading inputs, still before any filesystem mutation.
    verify_source(native, binding.native_head)
    verify_source(bundle, binding.bundle_head)

    values = {
        "AFI003_NATIVE_ROOT": str(native),
        "AFI003_ORBIT_ROOT": str(output / "orbit"),
        "WALE_ORBIT_NATIVE_ROOT": str(native),
        "AFI003_FIXTURE_HOST": str(bundle / FIXTURE_HOST),
        "AFI003_OUTPUT_ROOT": str(output / "observations"),
        "AFI003_BROWSER_HOLD": "0",
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    export = "".join(f"{key}={value}\n" for key, value in values.items())
    created_output = False
    published = False
    temporary_env: Path | None = None
    try:
        output.mkdir(mode=0o700)
        created_output = True
        (output / "orbit").mkdir(mode=0o700)
        with (output / "orbit" / "orbit_server.py").open("xb") as target:
            os.chmod(target.fileno(), 0o600)
            target.write(payload)
        descriptor, name = tempfile.mkstemp(prefix=".native-fixtures-", dir=environment_file.parent)
        temporary_env = Path(name)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as target:
            target.write(export)
            target.flush()
            os.fsync(target.fileno())
        # A same-directory hard link is atomic and refuses an existing path,
        # unlike replace()/rename(), which could overwrite a racing destination.
        os.link(temporary_env, environment_file, follow_symlinks=False)
        published = True
    except OSError as error:
        if created_output:
            shutil.rmtree(output)
        raise FixtureError("cannot create fresh fixture destinations; no environment was published") from error
    finally:
        if temporary_env is not None:
            try:
                temporary_env.unlink(missing_ok=True)
            except OSError as error:
                # The env file and QA data already form a complete publication.
                # A retained private temporary link must not turn success into
                # an apparent refusal after consumers can read that publication.
                if not published:
                    raise FixtureError("cannot remove unpublished temporary environment file") from error
    return values


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--native-root", required=True)
    parser.add_argument("--bundle-root", required=True)
    parser.add_argument("--output-root", required=True)
    parser.add_argument("--env-file", required=True)
    args = parser.parse_args()
    try:
        prepare_fixtures(args.native_root, args.bundle_root, args.output_root, args.env_file,
                         binding=PRODUCTION_BINDING)
    except FixtureError as error:
        print(f"Native fixture preparation refused: {error}", file=sys.stderr)
        return 1
    print("Native fixture inputs verified and prepared; no fixture code was executed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
