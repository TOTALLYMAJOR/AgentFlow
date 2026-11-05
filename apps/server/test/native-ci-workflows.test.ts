import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface RunStep {
  name?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

interface Workflow {
  jobs: Record<string, { steps: RunStep[] }>;
}

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function workflow(path: string): Workflow {
  return parse(readFileSync(resolve(repositoryRoot, path), 'utf8')) as Workflow;
}

function scriptFor(step: RunStep | undefined): string {
  if (!step?.run) throw new Error('Expected an executable workflow step');
  return step.run;
}

function runWithPrivateOutput(script: string, exitCode: number) {
  const root = mkdtempSync(join(tmpdir(), 'native-ci-workflow-'));
  temporaryDirectories.push(root);
  const binaryDirectory = join(root, 'bin');
  mkdirSync(binaryDirectory);
  writeFileSync(join(binaryDirectory, 'npm'), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$RUNNER_TEMP/npm-arguments"\nprintf "%s\\n" "private-stdout-canary"\nprintf "%s\\n" "private-stderr-canary" >&2\nexit "$COMMAND_EXIT"\n', { mode: 0o700 });
  const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binaryDirectory}:${process.env.PATH ?? ''}`,
      RUNNER_TEMP: root,
      GITHUB_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_JOB: 'native-test',
      GITHUB_REF_NAME: 'v0.0.0',
      COMMAND_EXIT: String(exitCode),
    },
  });
  return { ...result, root };
}

function nativeActionSteps(): RunStep[] {
  return (parse(readFileSync(resolve(repositoryRoot, '.github/actions/native-fixtures/action.yml'), 'utf8')) as {
    runs: { steps: RunStep[] };
  }).runs.steps;
}

function releaseFixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-ci-release-'));
  temporaryDirectories.push(root);
  const releaseRoot = join(root, 'release');
  mkdirSync(releaseRoot);
  const artifactNames = ['agentflow-0.3.0.tgz', 'agentflow-v0.3.0-source.tar.gz', 'release-manifest.json', 'SHA256SUMS'] as const;
  for (const name of artifactNames) writeFileSync(join(releaseRoot, name), 'public-artifact');
  const artifacts: { tarball: string; sourceArchive: string } = { tarball: artifactNames[0], sourceArchive: artifactNames[1] };
  const evidence = {
    finalQualification: true,
    releaseReady: true,
    artifacts,
    privateDiagnostics: 'private-release-canary',
  };
  writeFileSync(join(releaseRoot, 'release-evidence.json'), JSON.stringify(evidence));
  writeFileSync(join(releaseRoot, 'private.log'), 'private-release-canary');
  return { root, releaseRoot, artifactNames, evidence };
}

function runReleaseStep(name: string, root: string, extraEnvironment: Record<string, string> = {}) {
  const step = workflow('.github/workflows/quality-and-release.yml').jobs.release?.steps.find((candidate) => candidate.name === name);
  expect(step?.run).toBeDefined();
  return spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', scriptFor(step)], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      RUNNER_TEMP: root,
      GITHUB_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_JOB: 'release',
      GITHUB_REF_NAME: 'v0.3.0',
      NATIVE_QUALIFICATION_OUTCOME: 'success',
      ...extraEnvironment,
    },
  });
}

describe('native CI confidentiality', () => {
  for (const [path, job, command] of [
    ['.github/workflows/quality-and-release.yml', 'quality', 'npm run verify'],
    ['.github/workflows/quality-and-release.yml', 'release', 'npm run release:verify'],
    ['.github/workflows/verify.yml', 'verify', 'npm run verify'],
  ] as const) {
    for (const exitCode of [0, 7]) {
      it(`${job} keeps both output streams private while preserving exit ${exitCode}`, () => {
        // Removing either redirection or masking a failing command breaks this contract.
        const step = workflow(path).jobs[job]?.steps.find((candidate) => candidate.run?.includes(command));
        expect(step?.run).toBeDefined();
        const result = runWithPrivateOutput(scriptFor(step), exitCode);
        expect(result.status).toBe(exitCode);
        expect(`${result.stdout}${result.stderr}`).not.toContain('private-stdout-canary');
        expect(`${result.stdout}${result.stderr}`).not.toContain('private-stderr-canary');
        expect(readFileSync(join(result.root, 'npm-arguments'), 'utf8')).toBe(job === 'release' ? 'run release:verify -- --tag v0.0.0\n' : 'run verify\n');
        const privateDirectory = readdirSync(result.root).find((name) => name.startsWith('native-'));
        if (!privateDirectory) throw new Error('Expected private diagnostics');
        const privateRoot = join(result.root, privateDirectory);
        const logName = readdirSync(privateRoot)[0];
        if (!logName) throw new Error('Expected a private log');
        const logPath = join(privateRoot, logName);
        expect(readFileSync(logPath, 'utf8')).toContain('private-stdout-canary\nprivate-stderr-canary');
        expect(statSync(privateRoot).mode & 0o777).toBe(0o700);
        expect(statSync(logPath).mode & 0o777).toBe(0o600);
      });
    }
  }
});

describe('public release artifact boundary', () => {
  it('stages only the four public artifacts and a bounded qualification summary', () => {
    // Uploading the raw release directory would disclose the private evidence canary.
    const { root, artifactNames } = releaseFixture();
    const result = runReleaseStep('Stage public qualification artifacts', root);
    expect(result.status).toBe(0);
    const destination = join(root, 'public-release');
    expect(readdirSync(destination).sort()).toEqual([...artifactNames, 'qualification-summary.json'].sort());
    expect(JSON.parse(readFileSync(join(destination, 'qualification-summary.json'), 'utf8'))).toEqual({ qualified: true });
    expect(`${result.stdout}${result.stderr}`).not.toContain('private-release-canary');
  });

  it('retains only a negative summary when qualification failed', () => {
    const { root } = releaseFixture();
    const result = runReleaseStep('Stage public qualification artifacts', root, { NATIVE_QUALIFICATION_OUTCOME: 'failure' });
    expect(result.status).toBe(0);
    expect(readdirSync(join(root, 'public-release'))).toEqual(['qualification-summary.json']);
    expect(JSON.parse(readFileSync(join(root, 'public-release', 'qualification-summary.json'), 'utf8'))).toEqual({ qualified: false });
  });

  for (const readinessField of ['finalQualification', 'releaseReady'] as const) {
    it(`retains a negative summary when a successful command leaves ${readinessField} false`, () => {
      // A successful command is insufficient if its final release evidence refuses readiness.
      const { root, releaseRoot, evidence } = releaseFixture();
      evidence[readinessField] = false;
      writeFileSync(join(releaseRoot, 'release-evidence.json'), JSON.stringify(evidence));
      const result = runReleaseStep('Stage public qualification artifacts', root);
      expect(result.status).not.toBe(0);
      expect(readdirSync(join(root, 'public-release'))).toEqual(['qualification-summary.json']);
      expect(JSON.parse(readFileSync(join(root, 'public-release', 'qualification-summary.json'), 'utf8'))).toEqual({ qualified: false });
    });
  }

  for (const malformed of ['traversal', 'symlink', 'duplicate', 'empty', 'symlink-release-root'] as const) {
    it(`refuses ${malformed} artifact paths without publishing diagnostics`, () => {
      const { root, releaseRoot, evidence } = releaseFixture();
      if (malformed === 'traversal') evidence.artifacts.tarball = '../private-release-canary';
      if (malformed === 'duplicate') evidence.artifacts.tarball = evidence.artifacts.sourceArchive;
      if (malformed === 'empty') evidence.artifacts.tarball = '';
      if (malformed === 'symlink') {
        rmSync(join(releaseRoot, evidence.artifacts.tarball));
        symlinkSync('private.log', join(releaseRoot, evidence.artifacts.tarball));
      }
      writeFileSync(join(releaseRoot, 'release-evidence.json'), JSON.stringify(evidence));
      if (malformed === 'symlink-release-root') {
        const alternate = join(root, 'private-release-canary');
        mkdirSync(alternate);
        for (const name of readdirSync(releaseRoot)) writeFileSync(join(alternate, name), readFileSync(join(releaseRoot, name)));
        rmSync(releaseRoot, { recursive: true });
        symlinkSync(alternate, releaseRoot);
      }
      const result = runReleaseStep('Stage public qualification artifacts', root);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).not.toContain('private-release-canary');
      expect(readdirSync(join(root, 'public-release'))).toEqual(['qualification-summary.json']);
      expect(JSON.parse(readFileSync(join(root, 'public-release', 'qualification-summary.json'), 'utf8'))).toEqual({ qualified: false });
    });
  }

  it('stops before invoking publication when the final qualification guard fails', () => {
    // A child shell must honor the guard even while its parent captures the exit status.
    const { root, releaseRoot, evidence } = releaseFixture();
    evidence.releaseReady = false;
    writeFileSync(join(releaseRoot, 'release-evidence.json'), JSON.stringify(evidence));
    const binaryDirectory = join(root, 'bin');
    mkdirSync(binaryDirectory);
    writeFileSync(join(binaryDirectory, 'gh'), '#!/bin/bash\ntouch "$RUNNER_TEMP/publication-invoked"\n', { mode: 0o700 });
    const result = runReleaseStep('Create GitHub release', root, { PATH: `${binaryDirectory}:${process.env.PATH ?? ''}` });
    expect(result.status).not.toBe(0);
    expect(existsSync(join(root, 'publication-invoked'))).toBe(false);
    expect(`${result.stdout}${result.stderr}`).not.toContain('release-evidence.json');
  });
});

describe('native fixture access preflight', () => {
  it('uses the two immutable public snapshots without a private fixture credential', () => {
    const actionPath = resolve(repositoryRoot, '.github/actions/native-fixtures/action.yml');
    const actionText = readFileSync(actionPath, 'utf8');
    const action = parse(actionText) as { inputs?: unknown };
    expect(action.inputs).toBeUndefined();
    expect(actionText).not.toContain('ssh-key:');
    expect(actionText).not.toContain('native-read-key');
    const checkouts = nativeActionSteps().filter((step) => step.uses === 'actions/checkout@v6');
    expect(checkouts.map((step) => step.with?.repository)).toEqual(['TOTALLYMAJOR/Wale', 'TOTALLYMAJOR/Wale']);
    expect(checkouts.map((step) => step.with?.ref)).toEqual([
      '34ed5877b2a92c3b65081ad13b19803d44d8096d',
      '1540ec475827926204b739a28ec0d6c02c967472',
    ]);
    for (const step of checkouts) expect(step.with?.['persist-credentials']).toBe(false);
    for (const path of ['.github/workflows/verify.yml', '.github/workflows/quality-and-release.yml']) {
      expect(readFileSync(resolve(repositoryRoot, path), 'utf8')).not.toContain('WALE_NATIVE_READ_KEY');
    }
  });

  const trustedPullRequest = {
    NATIVE_EVENT_NAME: 'pull_request',
    NATIVE_REPOSITORY: 'TOTALLYMAJOR/AgentFlow',
    NATIVE_REPOSITORY_OWNER: 'TOTALLYMAJOR',
    NATIVE_ACTOR: 'TOTALLYMAJOR',
    NATIVE_REF: 'refs/pull/11/merge',
    NATIVE_HEAD_REPOSITORY: 'TOTALLYMAJOR/AgentFlow',
    NATIVE_HEAD_REF: 'codex/af-release-backlog-20261103',
  };

  for (const [name, overrides, accepted] of [
    ['owner pull request from the approved source', {}, true],
    ['owner pull request with equivalent repository casing', { NATIVE_REPOSITORY: 'totallymajor/agentflow', NATIVE_REPOSITORY_OWNER: 'totallymajor', NATIVE_ACTOR: 'totallymajor', NATIVE_HEAD_REPOSITORY: 'totallymajor/agentflow' }, true],
    ['owner push to main', { NATIVE_EVENT_NAME: 'push', NATIVE_REF: 'refs/heads/main' }, true],
    ['owner release tag', { NATIVE_EVENT_NAME: 'push', NATIVE_REF: 'refs/tags/v0.3.0' }, true],
    ['fork pull request', { NATIVE_HEAD_REPOSITORY: 'external/AgentFlow' }, false],
    ['coherent foreign repository context', { NATIVE_REPOSITORY: 'external/AgentFlow', NATIVE_REPOSITORY_OWNER: 'external', NATIVE_ACTOR: 'external', NATIVE_HEAD_REPOSITORY: 'external/AgentFlow' }, false],
    ['Dependabot pull request', { NATIVE_ACTOR: 'dependabot[bot]' }, false],
    ['unapproved source branch', { NATIVE_HEAD_REF: 'feature/unreviewed' }, false],
    ['pull request target event', { NATIVE_EVENT_NAME: 'pull_request_target' }, false],
    ['non-owner push', { NATIVE_EVENT_NAME: 'push', NATIVE_REF: 'refs/heads/main', NATIVE_ACTOR: 'contributor' }, false],
    ['other push branch', { NATIVE_EVENT_NAME: 'push', NATIVE_REF: 'refs/heads/feature' }, false],
  ] as const) {
    it(`${accepted ? 'accepts' : 'refuses'} ${name} before private access`, () => {
      // Weakening the event/actor/source guard must expose a rejected execution here.
      const steps = nativeActionSteps();
      const firstNativeCheckout = steps.findIndex((step) => step.with?.repository === 'TOTALLYMAJOR/Wale');
      const guardIndex = steps.findIndex((step) => step.name === 'Authorize native fixture access');
      expect(guardIndex).toBeGreaterThanOrEqual(0);
      expect(firstNativeCheckout).toBeGreaterThan(guardIndex);
      const guard = steps[guardIndex];
      const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', `${scriptFor(guard)}\nprintf 'private-access-reached\\n'`], {
        encoding: 'utf8',
        env: { ...process.env, ...trustedPullRequest, ...overrides },
      });
      expect(result.status === 0).toBe(accepted);
      expect(result.stdout.includes('private-access-reached')).toBe(accepted);
      expect(result.stderr).toBe('');
    });
  }
});
