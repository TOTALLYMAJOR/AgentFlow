import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildHarnessProfile, HarnessProfileError, parseHarnessProfileSource, validateHarnessProfile } from '../src/harness/profile.js';
import type { HarnessProfile } from '../src/harness/profile.js';

function sourceDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// Exact proposed-v1.json from Proofloom 34ed5877b2a92c3b65081ad13b19803d44d8096d.
// Accepted schema task TTR-C992B68A725C46C05060; this is proposal integrity only.
const FROZEN_PROFILE: HarnessProfile = {
  "claimBoundary": "Proposed semantic requirements only. This profile does not approve adoption, grant permissions, configure a runtime, or authorize execution, release, or deployment.",
  "id": "HARNESS-57839A5B66EE93E3",
  "kind": "HarnessProfile",
  "profileSha256": "57839a5b66ee93e3a2b6ae186d343992b7027c1b112fa342c97f49779661fd2d",
  "provenance": {
    "compilerVersion": "1.0.0",
    "controlInventorySha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "gapAnalysisSha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    "repositoryEvidenceIndexSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "requirementProfileSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "sourceRevision": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    "unresolvedDecisions": [
      {
        "id": "DEC-1",
        "reason": "Owner review pending"
      }
    ],
    "unresolvedGaps": [
      {
        "id": "CONTROL-GAP-123",
        "reason": "Evidence missing"
      }
    ]
  },
  "requiredSemantics": [
    {
      "actions": [
        "require:criterion-id"
      ],
      "category": "EVAL",
      "conditions": [],
      "id": "05bc42b1c218902617446893964f487a027ef03a897e4f109602bc431acbda5c",
      "intent": "Constrain eval for the bounded task.",
      "minimumEvidenceState": "DECLARED",
      "scope": {
        "kind": "path",
        "value": "src/app.py"
      },
      "subject": {
        "kind": "eval",
        "value": "eval-control"
      }
    },
    {
      "actions": [
        "require:validation-receipt"
      ],
      "category": "EVIDENCE",
      "conditions": [],
      "id": "376f455c2f422ed9e3e3c96195509362e6e00231faa6d780810c556e60135f5e",
      "intent": "Constrain evidence for the bounded task.",
      "minimumEvidenceState": "DECLARED",
      "scope": {
        "kind": "path",
        "value": "src/app.py"
      },
      "subject": {
        "kind": "evidence",
        "value": "evidence-control"
      }
    },
    {
      "actions": [
        "require:before-commit"
      ],
      "category": "CHECKPOINT",
      "conditions": [],
      "id": "424a0cbdef34249978a1290c81dee0e03a4ae60fcfc17f5e60c6f0df054ffe5b",
      "intent": "Constrain checkpoints for the bounded task.",
      "minimumEvidenceState": "DECLARED",
      "scope": {
        "kind": "path",
        "value": "src/app.py"
      },
      "subject": {
        "kind": "checkpoints",
        "value": "checkpoints-control"
      }
    },
    {
      "actions": [
        "require:stop-on-failure"
      ],
      "category": "POLICY",
      "conditions": [],
      "id": "4d3a5659d2678dc2557befd3d8745261a86673e588ce17a3f932ddebfb53484c",
      "intent": "Constrain recovery for the bounded task.",
      "minimumEvidenceState": "DECLARED",
      "scope": {
        "kind": "path",
        "value": "src/app.py"
      },
      "subject": {
        "kind": "recovery",
        "value": "recovery-control"
      }
    },
    {
      "actions": [
        "require:owner-review"
      ],
      "category": "APPROVAL",
      "conditions": [],
      "id": "4e8f1961c591c35b44181877234e5ac668f15e62e65ff831d86aac1e3659628d",
      "intent": "Constrain approvals for the bounded task.",
      "minimumEvidenceState": "DECLARED",
      "scope": {
        "kind": "path",
        "value": "src/app.py"
      },
      "subject": {
        "kind": "approvals",
        "value": "approvals-control"
      }
    },
    {
      "actions": [
        "require:runtime-reference-only"
      ],
      "category": "SECRET",
      "conditions": [],
      "id": "5264005fa5cad211a79f084aa91f6dd7b3f96393e9b9eb28c3a657387d3cbc11",
      "intent": "Constrain secrets for the bounded task.",
      "minimumEvidenceState": "DECLARED",
      "scope": {
        "kind": "path",
        "value": "src/app.py"
      },
      "subject": {
        "kind": "secrets",
        "value": "secrets-control"
      }
    },
    {
      "actions": [
        "deny:automatic-deployment"
      ],
      "category": "DEPLOYMENT",
      "conditions": [],
      "id": "5a6cc27bd77baf9824099f5db773f733305f8471795200624b9e2529c7b4841f",
      "intent": "Constrain deployment for the bounded task.",
      "minimumEvidenceState": "DECLARED",
      "scope": {
        "kind": "path",
        "value": "src/app.py"
      },
      "subject": {
        "kind": "deployment",
        "value": "deployment-control"
      }
    },
    {
      "actions": [
        "require:architecture-reasoning"
      ],
      "category": "SKILL",
      "conditions": [],
      "id": "60be35fa3832ab05ec4eb65067de3829327ccf758460960869a6b9194ed85de6",
      "intent": "Constrain capabilities for the bounded task.",
      "minimumEvidenceState": "DECLARED",
      "scope": {
        "kind": "path",
        "value": "src/app.py"
      },
      "subject": {
        "kind": "capabilities",
        "value": "capabilities-control"
      }
    },
    {
      "actions": [
        "require:correlation-id"
      ],
      "category": "TRACE",
      "conditions": [],
      "id": "7cc0623ce3aee379b8cc6e70e148d2e602932ae6533503c67e388abdd98aa7f1",
      "intent": "Constrain tracing for the bounded task.",
      "minimumEvidenceState": "DECLARED",
      "scope": {
        "kind": "path",
        "value": "src/app.py"
      },
      "subject": {
        "kind": "tracing",
        "value": "tracing-control"
      }
    },
    {
      "actions": [
        "deny:unbounded-write"
      ],
      "category": "POLICY",
      "conditions": [],
      "id": "9404c9df8a65344167dc08354983b888770134b2b0b9e6683aa92927a017f3e2",
      "intent": "Constrain permissions for the bounded task.",
      "minimumEvidenceState": "DECLARED",
      "scope": {
        "kind": "path",
        "value": "src/app.py"
      },
      "subject": {
        "kind": "permissions",
        "value": "permissions-control"
      }
    },
    {
      "actions": [
        "require:governing-source"
      ],
      "category": "INSTRUCTION",
      "conditions": [],
      "id": "c58e6f0c97d5eedf44f0f484fe7e338100a8cff14559ad281d24814b10749d86",
      "intent": "Constrain instructions for the bounded task.",
      "minimumEvidenceState": "DECLARED",
      "scope": {
        "kind": "path",
        "value": "src/app.py"
      },
      "subject": {
        "kind": "instructions",
        "value": "instructions-control"
      }
    },
    {
      "actions": [
        "require:unit-governance"
      ],
      "category": "CI",
      "conditions": [],
      "id": "cef4021a5440087e6e5682c809642dbf5f5e9afc9a9db1496a4c9e5643fc2484",
      "intent": "Constrain validation for the bounded task.",
      "minimumEvidenceState": "DECLARED",
      "scope": {
        "kind": "path",
        "value": "src/app.py"
      },
      "subject": {
        "kind": "validation",
        "value": "validation-control"
      }
    },
    {
      "actions": [
        "require:graph-read"
      ],
      "category": "MCP",
      "conditions": [],
      "id": "e20a42a8fd37207a455768c254896fbec0c3c605915136ae9774a619da1690fc",
      "intent": "Constrain mcp for the bounded task.",
      "minimumEvidenceState": "DECLARED",
      "scope": {
        "kind": "path",
        "value": "src/app.py"
      },
      "subject": {
        "kind": "mcp",
        "value": "mcp-control"
      }
    },
    {
      "actions": [
        "require:owner-approval"
      ],
      "category": "RELEASE",
      "conditions": [],
      "id": "e9508018e07f326e568464095c71b4cc30392fbe50749f335106f9224c67f62e",
      "intent": "Constrain release for the bounded task.",
      "minimumEvidenceState": "DECLARED",
      "scope": {
        "kind": "path",
        "value": "src/app.py"
      },
      "subject": {
        "kind": "release",
        "value": "release-control"
      }
    },
    {
      "actions": [
        "require:source-read"
      ],
      "category": "TOOL",
      "conditions": [],
      "id": "eb08c8f23b4b9f9d0e4477712caa0a00f21904c2c414cb76eae97675a53e32db",
      "intent": "Constrain tools for the bounded task.",
      "minimumEvidenceState": "DECLARED",
      "scope": {
        "kind": "path",
        "value": "src/app.py"
      },
      "subject": {
        "kind": "tools",
        "value": "tools-control"
      }
    },
    {
      "actions": [
        "require:isolation"
      ],
      "category": "SANDBOX",
      "conditions": [],
      "id": "eeb722b5111cbee7cbf30459df5961feecc579cd27c1c8017e7946c55f0415df",
      "intent": "Constrain sandbox for the bounded task.",
      "minimumEvidenceState": "DECLARED",
      "scope": {
        "kind": "path",
        "value": "src/app.py"
      },
      "subject": {
        "kind": "sandbox",
        "value": "sandbox-control"
      }
    },
    {
      "actions": [
        "require:bounded-attempts"
      ],
      "category": "RETRY",
      "conditions": [],
      "id": "fadb905eb6781e773468ecef0000ad41cdac2806b60e81ba07db59ebcf832e19",
      "intent": "Constrain retries for the bounded task.",
      "minimumEvidenceState": "DECLARED",
      "scope": {
        "kind": "path",
        "value": "src/app.py"
      },
      "subject": {
        "kind": "retries",
        "value": "retries-control"
      }
    }
  ],
  "runtimeProjectionHints": [
    {
      "hint": "PREFER_STRONGER_ISOLATION",
      "semantic": "sandbox"
    }
  ],
  "schemaVersion": 1,
  "state": "PROPOSED",
  "unsupportedSemantics": [
    {
      "reason": "No portable mapping for this capability",
      "semantic": "mcp"
    }
  ]
};

function first<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error('Expected a nonempty compatibility fixture');
  return value;
}

function rebuild(profile = structuredClone(FROZEN_PROFILE)): HarnessProfile {
  return buildHarnessProfile(
    profile.provenance,
    profile.requiredSemantics.map((semantic) => Object.fromEntries(Object.entries(semantic).filter(([key]) => key !== 'id'))),
    { unsupportedSemantics: profile.unsupportedSemantics, runtimeProjectionHints: profile.runtimeProjectionHints },
  );
}

// Independent test-side digest reconstruction ensures refusals exercise semantics
// even when a sender has recomputed both the semantic and envelope hashes.
function digest(value: unknown): string {
  function sorted(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(sorted);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, child]) => [key, sorted(child)]));
    }
    return item;
  }
  return createHash('sha256').update(JSON.stringify(sorted(value)), 'utf8').digest('hex');
}

function rehash(profile: HarnessProfile): HarnessProfile {
  for (const semantic of profile.requiredSemantics) {
    const identity = Object.fromEntries(Object.entries(semantic).filter(([key]) => !['id', 'minimumEvidenceState'].includes(key)));
    semantic.id = digest(identity);
  }
  profile.requiredSemantics.sort((a, b) => a.id.localeCompare(b.id));
  const stable = Object.fromEntries(Object.entries(profile).filter(([key]) => !['id', 'profileSha256'].includes(key)));
  profile.profileSha256 = digest(stable);
  profile.id = `HARNESS-${profile.profileSha256.slice(0, 16).toUpperCase()}`;
  return profile;
}

describe('accepted Harness Profile v1 semantic prerequisite', () => {
  it('reproduces every byte-bound field of the frozen native compatibility fixture', () => {
    expect(validateHarnessProfile(FROZEN_PROFILE)).toEqual([]);
    const built = rebuild();
    expect(built).toEqual(FROZEN_PROFILE);
    expect(built.id).toBe('HARNESS-57839A5B66EE93E3');
    expect(built.profileSha256).toBe('57839a5b66ee93e3a2b6ae186d343992b7027c1b112fa342c97f49779661fd2d');
    expect(built.requiredSemantics).toHaveLength(17);
  });

  it('canonicalizes set-like inputs without changing the source or disclosing defaults', () => {
    const source = structuredClone(FROZEN_PROFILE);
    source.requiredSemantics.reverse();
    first(source.requiredSemantics).actions.push(...first(source.requiredSemantics).actions);
    const before = structuredClone(source);
    expect(rebuild(source)).toEqual(FROZEN_PROFILE);
    expect(source).toEqual(before);
    expect(validateHarnessProfile(rehash(source))).toEqual(['requiredSemantics.id does not match semantic identity']);
  });

  it.each([
    [null, 'Harness Profile must be an object'],
    [[], 'Harness Profile must be an object'],
    [{ schemaVersion: 2, kind: 'HarnessProfile', state: 'PROPOSED' }, 'unsupported schemaVersion'],
    [{ ...FROZEN_PROFILE, schemaVersion: true }, 'unsupported schemaVersion'],
    [{ ...FROZEN_PROFILE, kind: 'RuntimeProfile' }, 'unsupported kind'],
    [{ ...FROZEN_PROFILE, state: 'ADOPTED' }, 'state must remain PROPOSED'],
    [{ ...FROZEN_PROFILE, approved: true }, 'Harness Profile fields do not match the contract'],
  ])('refuses unsupported envelopes %#', (profile, error) => {
    expect(validateHarnessProfile(profile)).toEqual([error]);
  });

  it.each(Object.keys(FROZEN_PROFILE.provenance))('requires provenance field %s', (field) => {
    const profile = structuredClone(FROZEN_PROFILE);
    Reflect.deleteProperty(profile.provenance, field);
    expect(validateHarnessProfile(profile)).toEqual(['provenance fields do not match the contract']);
  });

  it('binds unresolved decisions and rejects duplicate decision identities', () => {
    const profile = structuredClone(FROZEN_PROFILE);
    profile.provenance.unresolvedDecisions.push({ id: 'DEC-1', reason: 'A different pending review' });
    expect(validateHarnessProfile(rehash(profile))).toEqual(['provenance.unresolvedDecisions ids must be unique']);
    const changed = structuredClone(FROZEN_PROFILE);
    first(changed.provenance.unresolvedGaps).reason = 'Current evidence still missing';
    expect(validateHarnessProfile(changed)).toEqual(['profile does not match canonical content or digest']);
    expect(rebuild(changed).profileSha256).not.toBe(FROZEN_PROFILE.profileSha256);
  });

  it('excludes evidence state from semantic identity while binding it to the profile digest', () => {
    const profile = structuredClone(FROZEN_PROFILE);
    first(profile.requiredSemantics).minimumEvidenceState = 'VERIFIED';
    const built = rebuild(profile);
    expect(first(built.requiredSemantics).id).toBe(first(FROZEN_PROFILE.requiredSemantics).id);
    expect(built.profileSha256).not.toBe(FROZEN_PROFILE.profileSha256);
  });

  it.each([
    ['category', (p: HarnessProfile) => { first(p.requiredSemantics).category = 'NETWORK'; }, 'category is unsupported'],
    ['evidence state', (p: HarnessProfile) => { first(p.requiredSemantics).minimumEvidenceState = 'ACCEPTED'; }, 'minimumEvidenceState is unsupported'],
    ['grant', (p: HarnessProfile) => { first(p.requiredSemantics).actions = ['grant:all']; }, 'bounded constraint'],
    ['unbounded action', (p: HarnessProfile) => { first(p.requiredSemantics).actions = ['require:all']; }, 'must be bounded'],
    ['provider', (p: HarnessProfile) => { first(p.requiredSemantics).intent = 'Require Codex isolation'; }, 'provider and runtime names'],
    ['unbounded permissions', (p: HarnessProfile) => {
      first(p.requiredSemantics).subject.kind = 'permissions';
      first(p.requiredSemantics).scope.kind = 'governance';
    }, 'permissions require a bounded scope'],
    ['semantic collision', (p: HarnessProfile) => { p.requiredSemantics.push(structuredClone(first(p.requiredSemantics))); }, 'unique requirements'],
    ['unsupported collision', (p: HarnessProfile) => { p.unsupportedSemantics.push(structuredClone(first(p.unsupportedSemantics))); }, 'name each semantic once'],
    ['hint collision', (p: HarnessProfile) => { p.runtimeProjectionHints.push(structuredClone(first(p.runtimeProjectionHints))); }, 'must be unique'],
  ] as const)('refuses rehashed %s', (_label, mutate, error) => {
    const profile = structuredClone(FROZEN_PROFILE);
    mutate(profile);
    expect(validateHarnessProfile(rehash(profile)).join(' ')).toContain(error);
    expect(() => rebuild(profile)).toThrow(HarnessProfileError);
  });

  it.each([
    '.', '*', '../src', 'src//app.py', './src/app.py', 'src/app.py/', '/etc/config', 'all',
  ])('rejects noncanonical or unbounded path %s after rehash', (target) => {
    const profile = structuredClone(FROZEN_PROFILE);
    first(profile.requiredSemantics).scope = { kind: 'path', value: target };
    expect(validateHarnessProfile(rehash(profile))).not.toEqual([]);
  });

  it.each([
    '0.0.0.0/0', '::/0', '/', 'https://', 'https://EXAMPLE.com', 'https://example.com/',
    'example.com/path', '-bad.example', 'example..com', 'example.com:443',
    'https://example.com/a\nb', 'https://example.com/a\tb', 'fe80::1%eth0',
    'https://[fe80::1%eth0]/path', '999.999.999.999', 'https://999.999.999.999/path',
    '192.0.2.1/24', 'https://api.example.com:0/path', 'https://api.example.com:65536/path',
    '[2001:db8::1]', 'https://api.example.com/a b',
  ])('refuses the native noncanonical domain case %s', (target) => {
    const profile = structuredClone(FROZEN_PROFILE);
    first(profile.requiredSemantics).scope = { kind: 'domain', value: target };
    expect(validateHarnessProfile(rehash(profile))).not.toEqual([]);
    expect(() => rebuild(profile)).toThrow(HarnessProfileError);
  });

  it.each([
    'api.example.com', 'https://api.example.com/v1', '192.0.2.0/24', '2001:db8::1',
    '2001:db8::1/128', 'https://api.example.com/CaseSensitive', 'https://api.example.com/a@b:c',
    'https://[2001:db8::1]/A@B:C', 'http://api.example.com:80/path',
  ])('accepts and preserves the native bounded domain case %s', (target) => {
    const profile = structuredClone(FROZEN_PROFILE);
    first(profile.requiredSemantics).scope = { kind: 'domain', value: target };
    const built = rebuild(profile);
    expect(validateHarnessProfile(built)).toEqual([]);
    expect(built.requiredSemantics.find((s) => s.scope.kind === 'domain')?.scope.value).toBe(target);
  });

  const textCarriers: Array<[string, (p: HarnessProfile, text: string) => void]> = [
    ['intent', (p, text) => { first(p.requiredSemantics).intent = text; }],
    ['subject', (p, text) => { first(p.requiredSemantics).subject.value = text; }],
    ['condition', (p, text) => { first(p.requiredSemantics).conditions = [{ kind: 'governance', value: text }]; }],
    ['scope', (p, text) => { first(p.requiredSemantics).scope = { kind: 'governance', value: text }; }],
    ['decision', (p, text) => { first(p.provenance.unresolvedDecisions).reason = text; }],
    ['gap', (p, text) => { first(p.provenance.unresolvedGaps).reason = text; }],
    ['unsupported', (p, text) => { first(p.unsupportedSemantics).reason = text; }],
  ];
  it.each(textCarriers)('refuses sensitive text in %s even with recomputed digests', (_label, mutate) => {
    for (const text of [
      'Already approved for execution.', 'approvedBy: repository-owner',
      'Approval receipt APPROVAL-123 confirms acceptance.', '"permissionGranted" = true',
      'Execution must be approved by owner; deployment is approved.',
      'No approval granted; approval has been granted.',
      'Authorization: Bearer sample-value', '"api.key" = "sample-value"',
      'API KEY: sample-value', 'https://user:password@example.com/private',
      'github_pat_samplevalue', 'ａｐｐｒｏｖｅｄＢｙ: repository-owner',
    ]) {
      const profile = structuredClone(FROZEN_PROFILE);
      mutate(profile, text);
      expect(validateHarnessProfile(rehash(profile)).join(' ')).toMatch(/secret value|authority claim/);
    }
  });

  it.each(textCarriers)('preserves unresolved approval language in %s', (_label, mutate) => {
    for (const text of [
      'Execution must be approved by the repository owner.',
      'No approval granted; execution remains blocked.',
      'Execution MUST\nbe APPROVED by the repository owner.',
      'Approval required; execution must remain blocked.',
    ]) {
      const profile = structuredClone(FROZEN_PROFILE);
      mutate(profile, text);
      expect(validateHarnessProfile(rebuild(profile))).toEqual([]);
    }
  });

  it('keeps unknown semantics and hints explicit and rejects their unknown fields', () => {
    const profile = structuredClone(FROZEN_PROFILE);
    expect(rebuild(profile).unsupportedSemantics).toEqual(FROZEN_PROFILE.unsupportedSemantics);
    Object.assign(first(profile.runtimeProjectionHints), { provider: 'example' });
    expect(validateHarnessProfile(rehash(profile))).toEqual(['runtimeProjectionHints fields do not match the contract']);
  });

  it.each([
    ['éapproved by repository owner', '76b08805e2f4ee5f70f0f28bdd0bcba5312a13a708ef0af37176cfc7144a157c'],
    ['Execution must be approved   by owner.', 'edc7e0e7186e8177e1f0e62ad803fa60acde754ae50d08dff407c857a160d204'],
    ['Execution must be approved\t\tby owner.', '91b5e16ce0d99828b79dc15118c02193e96bd774a58fc21f0c571c2a4ef1d343'],
    ['api_key\uFEFF=value', '147290072d9bbc063e1d78be519f245faf3f34b6a774fea19d6c4cc1550f1749'],
    ['Ångström 漢字 😀', '661f367ab961e63561251c17312e1b840fba4e2f0614b81f4e7868572e5a51d5'],
  ])('preserves the native Unicode text identity for %s', (intent, nativeDigest) => {
    const profile = structuredClone(FROZEN_PROFILE);
    first(profile.requiredSemantics).intent = intent;
    const built = rebuild(profile);
    expect(built.profileSha256).toBe(nativeDigest);
    expect(validateHarnessProfile(built)).toEqual([]);
  });

  it.each([
    'émust be approved by owner', 'Execution must\uFEFFbe approved by owner.',
    'Approval receipt ı confirms acceptance.', 'Require copılot isolation', 'Require copİlot isolation',
  ])('matches native Unicode authority/provider refusal for %s', (intent) => {
    const profile = structuredClone(FROZEN_PROFILE);
    first(profile.requiredSemantics).intent = intent;
    expect(() => rebuild(profile)).toThrow(/authority claim|provider and runtime names/);
    expect(validateHarnessProfile(rehash(profile)).join(' ')).toMatch(/authority claim|provider and runtime names/);
  });

  it('sorts decision IDs by Unicode code point and matches the native digest', () => {
    const profile = structuredClone(FROZEN_PROFILE);
    profile.provenance.unresolvedDecisions = [
      { id: '\u{10000}', reason: 'Pending' }, { id: '\uE000', reason: 'Pending' },
    ];
    const built = rebuild(profile);
    expect(built.provenance.unresolvedDecisions.map((item) => item.id)).toEqual(['\uE000', '\u{10000}']);
    expect(built.profileSha256).toBe('a4c376eb8f0447a5a5c758089a77195f7deee229948502f6afe5530e6d5320f3');
    expect(validateHarnessProfile(built)).toEqual([]);
  });

  it('does not treat canonically declared proposal state as profile adoption', () => {
    const built = rebuild();
    expect(built.state).toBe('PROPOSED');
    expect(built.claimBoundary).toBe(FROZEN_PROFILE.claimBoundary);
    expect(Object.keys(built)).not.toContain('approval');
    expect(Object.keys(built)).not.toContain('executionAuthorized');
  });

  it('rejects changed semantic identity, uppercase digest, and a changed claim boundary', () => {
    for (const mutate of [
      (p: HarnessProfile) => { first(p.requiredSemantics).id = '0'.repeat(64); },
      (p: HarnessProfile) => { p.profileSha256 = p.profileSha256.toUpperCase(); },
      (p: HarnessProfile) => { p.claimBoundary = 'Execution is authorized.'; },
    ]) {
      const profile = structuredClone(FROZEN_PROFILE);
      mutate(profile);
      expect(validateHarnessProfile(profile)).not.toEqual([]);
    }
  });
});


describe('exact Harness Profile source boundary', () => {
  function parse(source: string) {
    const bytes = Buffer.from(source, 'utf8');
    return parseHarnessProfileSource(bytes, sourceDigest(bytes));
  }

  it('retains exact UTF-8 content separately from the canonical profile digest', () => {
    const sourceText = JSON.stringify(FROZEN_PROFILE, null, 2) + '\r\n';
    const bytes = Buffer.from(sourceText);
    const result = parseHarnessProfileSource(bytes, sourceDigest(bytes));
    expect(result).toEqual({ sourceText, sourceSha256: sourceDigest(bytes), profile: FROZEN_PROFILE });
    expect(result.sourceSha256).not.toBe(result.profile.profileSha256);
    bytes.fill(0);
    expect(result.sourceText).toBe(sourceText);
    expect(result.profile.state).toBe('PROPOSED');
  });

  it('accepts native-compatible formatting without silently replacing the reviewed bytes', () => {
    const compact = JSON.stringify(FROZEN_PROFILE);
    const indented = '\t\n' + JSON.stringify(FROZEN_PROFILE, null, 4) + '\r\n';
    const first = parse(compact), second = parse(indented);
    expect(first.profile).toEqual(second.profile);
    expect(first.sourceSha256).not.toBe(second.sourceSha256);
    expect(first.sourceText).toBe(compact);
    expect(second.sourceText).toBe(indented);
  });

  it.each(['1.0', '1e0', '1E+0', '10e-1', '0.1e1'])('refuses the float token %s before object parsing erases its type', (token) => {
    const source = JSON.stringify(FROZEN_PROFILE).replace('"schemaVersion":1', `"schemaVersion":${token}`);
    expect(validateHarnessProfile(JSON.parse(source))).toEqual([]);
    expect(() => parse(source)).toThrow('unsupported schemaVersion token');
  });

  it('uses decoded keys and the actual last JSON member just like the native parser', () => {
    const source = JSON.stringify(FROZEN_PROFILE);
    expect(parse(source.replace('"schemaVersion":1', '"\\u0073chemaVersion":1')).profile).toEqual(FROZEN_PROFILE);
    expect(parse(source.replace('"schemaVersion":1', '"schemaVersion":1.0,"schemaVersion":1')).profile).toEqual(FROZEN_PROFILE);
    expect(() => parse(source.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1e0'))).toThrow('unsupported schemaVersion token');
  });

  it('does not interpret text inside a requirement as a JSON version token', () => {
    const profile = structuredClone(FROZEN_PROFILE);
    first(profile.requiredSemantics).intent = 'Observe the text "schemaVersion":1.0 without granting authority.';
    const built = rebuild(profile);
    expect(parse(JSON.stringify(built)).profile).toEqual(built);
  });

  it.each([
    ['missing digest', ''], ['uppercase digest', 'A'.repeat(64)],
    ['changed digest', '0'.repeat(64)], ['semantic digest instead of source digest', FROZEN_PROFILE.profileSha256],
  ])('refuses %s', (_label, supplied) => {
    const bytes = Buffer.from(JSON.stringify(FROZEN_PROFILE));
    expect(() => parseHarnessProfileSource(bytes, supplied)).toThrow(HarnessProfileError);
  });

  it('refuses changed bytes even when parsed semantics are identical', () => {
    const bytes = Buffer.from(JSON.stringify(FROZEN_PROFILE));
    const changed = Buffer.concat([bytes, Buffer.from('\n')]);
    expect(() => parseHarnessProfileSource(changed, sourceDigest(bytes))).toThrow('source bytes do not match supplied digest');
  });

  it('hashes and decodes only the supplied byte view', () => {
    const bytes = Buffer.from(JSON.stringify(FROZEN_PROFILE));
    const padded = Buffer.concat([Buffer.from('prefix'), bytes, Buffer.from('suffix')]);
    const view = padded.subarray(6, 6 + bytes.length);
    expect(parseHarnessProfileSource(view, sourceDigest(bytes)).profile).toEqual(FROZEN_PROFILE);
  });

  it.each([[0xff], [0xc0, 0x80], [0xe2, 0x82], [0xed, 0xa0, 0x80]])('refuses invalid UTF-8 bytes %j', (...values: number[]) => {
    const bytes = Uint8Array.from(values);
    expect(() => parseHarnessProfileSource(bytes, sourceDigest(bytes))).toThrow('source must contain valid UTF-8');
  });

  it('does not silently remove a byte-order mark', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(FROZEN_PROFILE))]);
    expect(() => parseHarnessProfileSource(bytes, sourceDigest(bytes))).toThrow('source must contain valid JSON');
  });

  it.each(['', '{', '{"sample":"private-placeholder",}', 'null trailing'])('refuses malformed JSON without echoing source content', (source) => {
    expect(() => parse(source)).toThrow(/^source must contain valid JSON$/);
  });

  it.each(['null', '[]', 'true', '1', '"profile"'])('refuses a non-profile JSON root %s', (source) => {
    expect(() => parse(source)).toThrow('Harness Profile must be an object');
  });

  it('replays semantic validation after verifying the source digest', () => {
    for (const mutate of [
      (profile: Record<string, unknown>) => { profile.state = 'APPROVED'; },
      (profile: Record<string, unknown>) => { profile.schemaVersion = 2; },
      (profile: Record<string, unknown>) => { profile.profileSha256 = 'f'.repeat(64); },
      (profile: Record<string, unknown>) => { profile.executionAuthorized = true; },
    ]) {
      const profile = structuredClone(FROZEN_PROFILE) as unknown as Record<string, unknown>;
      mutate(profile);
      expect(() => parse(JSON.stringify(profile))).toThrow(HarnessProfileError);
    }
  });
});
