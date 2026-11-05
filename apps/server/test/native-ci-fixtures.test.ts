import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const helper = resolve('scripts/prepare-native-fixtures.py');
const roots: string[] = [];
const childEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
const host = 'from pathlib import Path\nPath(__file__).with_suffix(".executed").write_text("unexpected execution")\nraise RuntimeError("synthetic host must never execute")\n';
const orbit = 'from pathlib import Path\nPath(__file__).with_suffix(".executed").write_text("unexpected execution")\nraise RuntimeError("synthetic orbit must never execute")\n';
const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: childEnv }).trim();
}

function commit(root: string): string {
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Fixture test', '-c', 'user.email=fixture@example.invalid',
    '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Synthetic fixture');
  return git(root, 'rev-parse', 'HEAD');
}

function archive(path: string, kind = 'regular'): void {
  execFileSync('python3', ['-c', `
import io, sys, tarfile
payload = ${JSON.stringify(orbit)}.encode()
kind = sys.argv[2]
with tarfile.open(sys.argv[1], 'w:gz', format=tarfile.USTAR_FORMAT) as output:
    if kind == 'extension':
        extension = tarfile.TarInfo('pax-header')
        extension.type = tarfile.XHDTYPE
        output.addfile(extension, io.BytesIO())
    member = tarfile.TarInfo('../orbit_server.py' if kind == 'traversal' else 'orbit_server.py')
    member.size = len(payload)
    if kind in ('symlink', 'hardlink'):
        member.type = tarfile.SYMTYPE if kind == 'symlink' else tarfile.LNKTYPE
        member.linkname = '/tmp/fixture-escape'
        member.size = 0
    output.addfile(member, io.BytesIO(payload))
    if kind == 'extra':
        extra = tarfile.TarInfo('extra.py')
        extra.size = 0
        output.addfile(extra, io.BytesIO())
    if kind == 'duplicate':
        output.addfile(member, io.BytesIO(payload))
`, path, kind], { env: childEnv });
}

function fixture(kind = 'regular') {
  const base = mkdtempSync(join(tmpdir(), 'native-ci-fixtures-'));
  roots.push(base);
  const native = join(base, 'native');
  const bundle = join(base, 'bundle');
  mkdirSync(native);
  mkdirSync(join(bundle, '.ci/af-crossrepo/inputs'), { recursive: true });
  mkdirSync(join(bundle, '.ci/af-crossrepo/host'), { recursive: true });
  for (const root of [native, bundle]) git(root, 'init', '-q');
  writeFileSync(join(native, 'README.md'), 'Synthetic native repository.\n');
  const fixtureHost = join(bundle, '.ci/af-crossrepo/host/fixture-host.py');
  const processHost = join(bundle, '.ci/af-crossrepo/host/orbit-process-host.py');
  const archivePath = join(bundle, '.ci/af-crossrepo/inputs/orbit-6c8-api.tar.gz');
  writeFileSync(fixtureHost, host);
  writeFileSync(processHost, host + '# process host\n');
  archive(archivePath, kind);
  const binding = {
    native_head: commit(native),
    bundle_head: commit(bundle),
    fixture_host_sha256: sha256(readFileSync(fixtureHost)),
    process_host_sha256: sha256(readFileSync(processHost)),
    archive_sha256: sha256(readFileSync(archivePath)),
    orbit_sha256: sha256(orbit),
  };
  return { base, native, bundle, fixtureHost, processHost, archivePath, binding,
    output: join(base, 'qa'), envFile: join(base, 'native.env') };
}

type Fixture = ReturnType<typeof fixture>;

function prepare(f: Fixture, overrides: Partial<{ native: string; bundle: string; output: string; envFile: string }> = {}, env: NodeJS.ProcessEnv = childEnv, failCleanup = false) {
  return spawnSync('python3', ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('native_fixtures', sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
values = json.loads(sys.argv[2])
if values.pop('fail_cleanup'):
    original_unlink = module.Path.unlink
    def refuse_completed_cleanup(path, *args, **kwargs):
        if path.name.startswith('.native-fixtures-') and module.Path(values['env_file']).exists():
            raise PermissionError('injected temporary-file cleanup failure')
        return original_unlink(path, *args, **kwargs)
    module.Path.unlink = refuse_completed_cleanup
binding = module.FixtureBinding(**values.pop('binding'))
try:
    module.prepare_fixtures(**values, binding=binding)
except module.FixtureError as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
`, helper, JSON.stringify({
    native_root: overrides.native ?? f.native,
    bundle_root: overrides.bundle ?? f.bundle,
    output_root: overrides.output ?? f.output,
    env_file: overrides.envFile ?? f.envFile,
    binding: f.binding,
    fail_cleanup: failCleanup,
  })], { encoding: 'utf8', env });
}

function expectRefusal(f: Fixture, result: ReturnType<typeof prepare>, reason: RegExp): void {
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toMatch(reason);
  expect(existsSync(f.output)).toBe(false);
  expect(existsSync(f.envFile)).toBe(false);
  expect(readdirSync(f.base).sort()).toEqual(['bundle', 'native']);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('native CI fixture preparation', () => {
  // Omitting extraction or any exported value breaks the actual downstream contract.
  it('prepares only the approved orbit member and a complete private environment without running code', () => {
    const f = fixture();
    const result = prepare(f);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(f.output, 'orbit/orbit_server.py'), 'utf8')).toBe(orbit);
    expect(readdirSync(f.output)).toEqual(['orbit']);
    expect(readdirSync(join(f.output, 'orbit'))).toEqual(['orbit_server.py']);
    expect(existsSync(f.fixtureHost.replace(/\.py$/, '.executed'))).toBe(false);
    expect(existsSync(f.processHost.replace(/\.py$/, '.executed'))).toBe(false);
    expect(existsSync(join(f.output, 'observations'))).toBe(false);
    expect(readFileSync(f.envFile, 'utf8')).toBe([
      `AFI003_NATIVE_ROOT=${f.native}`,
      `AFI003_ORBIT_ROOT=${join(f.output, 'orbit')}`,
      `WALE_ORBIT_NATIVE_ROOT=${f.native}`,
      `AFI003_FIXTURE_HOST=${f.fixtureHost}`,
      `AFI003_OUTPUT_ROOT=${join(f.output, 'observations')}`,
      'AFI003_BROWSER_HOLD=0',
      'PYTHONDONTWRITEBYTECODE=1',
      '',
    ].join('\n'));
    expect(lstatSync(f.envFile).mode & 0o777).toBe(0o600);
    expect(git(f.native, 'status', '--porcelain=v1', '--untracked-files=all')).toBe('');
    expect(git(f.bundle, 'status', '--porcelain=v1', '--untracked-files=all')).toBe('');
    expect(readdirSync(f.base).sort()).toEqual(['bundle', 'native', 'native.env', 'qa']);
  });

  // An unavoidable filesystem-fault injection checks the published result,
  // rather than call counts or behavior of a mock.
  it('retains success when temporary-file cleanup fails after atomic publication', () => {
    const f = fixture();
    const result = prepare(f, {}, childEnv, true);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(f.output, 'orbit/orbit_server.py'), 'utf8')).toBe(orbit);
    expect(readFileSync(f.envFile, 'utf8')).toContain(`AFI003_NATIVE_ROOT=${f.native}\n`);
    expect(lstatSync(f.envFile).mode & 0o777).toBe(0o600);
  });

  // Removing a binding check would allow an unapproved revision or private input.
  it.each(['native_head', 'bundle_head', 'fixture_host_sha256', 'process_host_sha256', 'archive_sha256', 'orbit_sha256'] as const)(
    'refuses mismatched %s before creating outputs', (key) => {
      const f = fixture();
      f.binding[key] = '0'.repeat(key.endsWith('_head') ? 40 : 64);
      expectRefusal(f, prepare(f), /revision|digest/i);
    });

  it.each(['native', 'bundle'] as const)('refuses dirty %s source before creating outputs', (root) => {
    const f = fixture();
    writeFileSync(join(f[root], 'untracked.txt'), 'unapproved\n');
    expectRefusal(f, prepare(f), /clean|dirty/i);
  });

  // Archive validation must run even when the archive's outer digest is approved.
  it.each(['traversal', 'symlink', 'hardlink', 'extra', 'duplicate', 'extension'])(
    'refuses a bound archive with %s entries', (kind) => {
      const f = fixture(kind);
      expectRefusal(f, prepare(f), /archive|member/i);
    });

  it('refuses an oversized archive before creating outputs', () => {
    const f = fixture();
    writeFileSync(f.archivePath, Buffer.alloc(9 * 1024 * 1024));
    f.binding.archive_sha256 = sha256(readFileSync(f.archivePath));
    f.binding.bundle_head = commit(f.bundle);
    expectRefusal(f, prepare(f), /size|large|bound/i);
  });

  it('refuses a symlinked source root', () => {
    const f = fixture();
    const alias = join(f.base, 'native-alias');
    symlinkSync(f.native, alias);
    const result = prepare(f, { native: alias });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toMatch(/canonical|symlink/i);
    expect(existsSync(f.output)).toBe(false);
    expect(existsSync(f.envFile)).toBe(false);
  });

  it('refuses a symlink in the bound private file path', () => {
    const f = fixture();
    rmSync(f.fixtureHost);
    symlinkSync(f.processHost, f.fixtureHost);
    f.binding.bundle_head = commit(f.bundle);
    expectRefusal(f, prepare(f), /symlink|regular/i);
  });

  it('refuses a nested directory masquerading as a source worktree', () => {
    const f = fixture();
    mkdirSync(join(f.native, 'nested'));
    expectRefusal(f, prepare(f, { native: join(f.native, 'nested') }), /worktree|root/i);
  });

  it('refuses output placement inside a source checkout', () => {
    const f = fixture();
    const result = prepare(f, { output: join(f.native, 'qa') });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toMatch(/outside|source/i);
    expect(existsSync(join(f.native, 'qa'))).toBe(false);
    expect(existsSync(f.envFile)).toBe(false);
  });

  it('preserves an existing QA directory and does not export environment', () => {
    const f = fixture();
    mkdirSync(f.output);
    writeFileSync(join(f.output, 'keep'), 'preserved');
    const result = prepare(f);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toMatch(/already exists|fresh/i);
    expect(readFileSync(join(f.output, 'keep'), 'utf8')).toBe('preserved');
    expect(existsSync(f.envFile)).toBe(false);
  });

  it('preserves an existing environment file and does not create QA output', () => {
    const f = fixture();
    writeFileSync(f.envFile, 'KEEP=value\n');
    const result = prepare(f);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toMatch(/already exists|fresh/i);
    expect(readFileSync(f.envFile, 'utf8')).toBe('KEEP=value\n');
    expect(existsSync(f.output)).toBe(false);
  });

  it('refuses environment newline injection before creating outputs', () => {
    const f = fixture();
    expectRefusal(f, prepare(f, { output: f.output + '\nINJECTED=value' }), /control|newline|invalid/i);
  });

  it('refuses the GitHub environment command channel as its export file', () => {
    const f = fixture();
    expectRefusal(f, prepare(f, {}, { ...childEnv, GITHUB_ENV: f.envFile }), /GITHUB_ENV|environment channel/i);
  });

  it('refuses symlinked destination parents without writing through them', () => {
    const f = fixture();
    const alias = join(f.base, 'alias');
    symlinkSync(f.base, alias);
    const result = prepare(f, { envFile: join(alias, 'native.env') });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toMatch(/canonical|symlink/i);
    expect(existsSync(f.output)).toBe(false);
    expect(existsSync(f.envFile)).toBe(false);
  });

  // The real CLI always uses production pins; library bindings cannot weaken it.
  it('rejects synthetic repositories through the production CLI', () => {
    const f = fixture();
    const result = spawnSync('python3', [helper, '--native-root', f.native, '--bundle-root', f.bundle,
      '--output-root', f.output, '--env-file', f.envFile], { encoding: 'utf8', env: childEnv });
    expectRefusal(f, result, /revision/i);
  });

  it('rejects CLI pin overrides', () => {
    const f = fixture();
    const result = spawnSync('python3', [helper, '--native-root', f.native, '--bundle-root', f.bundle,
      '--output-root', f.output, '--env-file', f.envFile, '--native-head', f.binding.native_head],
    { encoding: 'utf8', env: childEnv });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/unrecognized arguments/);
    expect(existsSync(f.output)).toBe(false);
    expect(existsSync(f.envFile)).toBe(false);
  });
});
