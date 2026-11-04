import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

// Semantic parity with Proofloom's accepted provider-neutral v1 contract at
// 34ed5877b2a92c3b65081ad13b19803d44d8096d. This module performs no I/O and
// supplies no adoption, plan binding, runtime configuration, or execution grant.
export const HARNESS_PROFILE_CLAIM_BOUNDARY =
  'Proposed semantic requirements only. This profile does not approve adoption, ' +
  'grant permissions, configure a runtime, or authorize execution, release, or deployment.';

export interface HarnessTarget { kind: string; value: string }
export interface HarnessDecision { id: string; reason: string }
export interface HarnessProvenance {
  repositoryEvidenceIndexSha256: string;
  controlInventorySha256: string;
  requirementProfileSha256: string;
  gapAnalysisSha256: string;
  sourceRevision: string;
  compilerVersion: string;
  unresolvedDecisions: HarnessDecision[];
  unresolvedGaps: HarnessDecision[];
}
export interface HarnessSemanticRequirement {
  id: string;
  intent: string;
  category: string;
  subject: HarnessTarget;
  actions: string[];
  conditions: HarnessTarget[];
  scope: HarnessTarget;
  minimumEvidenceState: string;
}
export interface HarnessUnsupportedSemantic { semantic: string; reason: string }
export interface HarnessProjectionHint { semantic: string; hint: string }
export interface HarnessProfile {
  schemaVersion: 1;
  kind: 'HarnessProfile';
  state: 'PROPOSED';
  provenance: HarnessProvenance;
  requiredSemantics: HarnessSemanticRequirement[];
  unsupportedSemantics: HarnessUnsupportedSemantic[];
  runtimeProjectionHints: HarnessProjectionHint[];
  claimBoundary: string;
  id: string;
  profileSha256: string;
}

export class HarnessProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessProfileError';
  }
}

const PROVENANCE_FIELDS = [
  'repositoryEvidenceIndexSha256', 'controlInventorySha256', 'requirementProfileSha256',
  'gapAnalysisSha256', 'sourceRevision', 'compilerVersion', 'unresolvedDecisions', 'unresolvedGaps',
];
const SEMANTIC_FIELDS = [
  'intent', 'category', 'subject', 'actions', 'conditions', 'scope', 'minimumEvidenceState',
];
const PROFILE_FIELDS = [
  'schemaVersion', 'kind', 'state', 'provenance', 'requiredSemantics', 'unsupportedSemantics',
  'runtimeProjectionHints', 'claimBoundary', 'id', 'profileSha256',
];
const CATEGORIES = new Set([
  'INSTRUCTION', 'SKILL', 'HOOK', 'POLICY', 'TOOL', 'MCP', 'APPROVAL', 'SANDBOX', 'SECRET',
  'RETRY', 'CHECKPOINT', 'CI', 'ADR', 'ARCHITECTURE', 'SECURITY', 'EVIDENCE', 'TRACE', 'EVAL',
  'RELEASE', 'DEPLOYMENT',
]);
const EVIDENCE_STATES = new Set(['DECLARED', 'CONFIGURED', 'ENFORCED', 'OBSERVED', 'VERIFIED']);
const HINTS = new Set(['PREFER_STRONGER_ISOLATION', 'PREFER_READ_ONLY', 'PREFER_FEWER_RETRIES']);
const IDENTIFIER = /^[a-z][a-z0-9-]*$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const REVISION = /^[0-9a-f]{40}$/u;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/u;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const PROVIDER = /(?:^|[^a-z0-9])(codex|claude|gemini|copilot|agentflow)(?:$|[^a-z0-9])/iu;
const SECRET_VALUE = /(?:sk-[a-z0-9_-]{8,}|ghp_[a-z0-9]{8,}|akia[a-z0-9]{16}|github_pat_[a-z0-9_]+|authorization\s*[:=]\s*(?:bearer|basic)\s+\S+|[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/@\s]+@[^/\s]+|-----begin [^-]*private key-----|(?:token|password|secret|api[_-]?key)\s*[:=]\s*\S+)/iu;
const STRUCTURED_SECRET = /(?<![a-z0-9_-])['"]?(?:authorization|api[ ._-]*key|(?:access[ ._-]*)?token|password|secret)['"]?\s*[:=]\s*['"]?\S+/u;
const STRUCTURED_AUTHORITY = /(?<![a-z0-9_-])['"]?(?:approved[ ._-]*by|approval[ ._-]*(?:receipt|granted)|permissions?[ ._-]*granted|execution[ ._-]*authorized)['"]?\s*[:=]\s*['"]?\S+|(?<![a-z0-9_-])['"]?(?:approval|permissions?|execution)['"]?\s*[:=]\s*['"]?(?:granted|approved|authorized|accepted|may\s+proceed|can\s+proceed)\b/u;
const AUTHORITY_CLAIM = /\bapprovedby\s*[:=]\s*\S+|\bapproval\s+receipt(?:\s*[:=]\s*\S+|\s+[a-z][a-z0-9-]*\s+confirms\b)|\bapproved\s+by\b|\b(?:repository\s+)?owner\s+(?:has|had)\s+approved\b|\b(?:permission(?:s)?|approval)\s+(?:(?:is|was|has\s+been|have\s+been)\s+)?granted\b|\b(?:deployment|release|execution|permission(?:s)?|approval)\s+(?:is|was|has\s+been|have\s+been)\s+(?:approved|authorized|granted|accepted)\b|\bexecution\s+(?:(?:is|was|has\s+been)\s+authorized|(?:may|can)\s+proceed)\b|\b(?:already|owner|human)\s+approved\b|\bauthorized\s+to\s+execute\b|\bexecution\s+authorized\b/gu;
const PYTHON_SPACE_SOURCE = String.raw`[\p{White_Space}\u001c-\u001f]`;
const PYTHON_SPACE = new RegExp(PYTHON_SPACE_SOURCE + '+', 'gu');
const PYTHON_TRIM = new RegExp('^' + PYTHON_SPACE_SOURCE + '+|' + PYTHON_SPACE_SOURCE + '+$', 'gu');
const PYTHON_TRIM_END = new RegExp(PYTHON_SPACE_SOURCE + '+$', 'gu');
const HAS_PYTHON_SPACE = new RegExp(PYTHON_SPACE_SOURCE, 'u');

// Native text checks run after Python whitespace has collapsed to spaces.
// Preserve Python's Unicode word boundaries and extra dotted/dotless-I matches.
function nativeTextPattern(pattern: RegExp): RegExp {
  let source = pattern.source
    .replaceAll("\\b", "(?:(?<=[\\p{L}\\p{N}_])(?![\\p{L}\\p{N}_])|(?<![\\p{L}\\p{N}_])(?=[\\p{L}\\p{N}_]))")
    .replaceAll("\\s", ' ')
    .replaceAll("\\S", '[^ ]');
  if (pattern.ignoreCase) source = source.replaceAll('i', '[iİı]').replaceAll('a-z', 'a-zİı');
  return new RegExp(source, pattern.flags);
}
const NATIVE_SECRET_VALUE = nativeTextPattern(SECRET_VALUE);
const NATIVE_STRUCTURED_SECRET = nativeTextPattern(STRUCTURED_SECRET);
const NATIVE_STRUCTURED_AUTHORITY = nativeTextPattern(STRUCTURED_AUTHORITY);
const NATIVE_AUTHORITY_CLAIM = nativeTextPattern(new RegExp(AUTHORITY_CLAIM.source, 'giu'));
const NATIVE_PROVIDER = nativeTextPattern(PROVIDER);
const NEGATED_AUTHORITY = nativeTextPattern(/\b(?:not(?:\s+yet)?|no|never)$/u);
const REQUIRED_AUTHORITY = nativeTextPattern(/\b(?:must\s+be|should\s+be|to\s+be)$/u);

function fail(message: string): never { throw new HarnessProfileError(message); }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fields(value: unknown, required: readonly string[], label: string): Record<string, unknown> {
  if (!object(value) || Object.keys(value).length !== required.length ||
      required.some((key) => !Object.hasOwn(value, key))) {
    fail(`${label} fields do not match the contract`);
  }
  return value;
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}
function match(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || pattern.exec(value)?.[0] !== value) fail(`${label} has an unsupported format`);
  return value;
}

// Python sorts Unicode by code point; JavaScript's default sort uses UTF-16 units.
function compare(left: string, right: string): number {
  const a = Array.from(left), b = Array.from(right);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const difference = (a[i]?.codePointAt(0) ?? 0) - (b[i]?.codePointAt(0) ?? 0);
    if (difference) return difference;
  }
  return a.length - b.length;
}
function canonicalJson(value: unknown): string {
  if (typeof value === 'string') {
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
      fail('canonical content must contain valid Unicode');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (object(value)) {
    return `{${Object.keys(value).sort(compare).map((key) =>
      `${canonicalJson(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  // The closed contract has no other numeric data besides schemaVersion = 1.
  if (value === null || typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  return fail('canonical content must contain JSON values');
}
function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} must be a non-empty canonical string`);
  const stripped = value.replace(PYTHON_TRIM, '');
  if (!stripped || value !== stripped) fail(`${label} must be a non-empty canonical string`);
  // NFKC handles compatibility letters. Sharp-s is the remaining casefold
  // expansion that can form ASCII words in the native sensitive-text patterns.
  const analysis = value.normalize('NFKC').toLowerCase().replace(/ß/gu, 'ss')
    .replace(/[“”]/gu, '"').replace(/[‘’]/gu, "'").replace(PYTHON_SPACE, ' ');
  if (NATIVE_SECRET_VALUE.test(analysis) || NATIVE_STRUCTURED_SECRET.test(analysis)) {
    fail(`${label} must not contain a secret value`);
  }
  if (NATIVE_STRUCTURED_AUTHORITY.test(analysis)) fail(`${label} must not contain an authority claim`);
  for (const found of analysis.matchAll(NATIVE_AUTHORITY_CLAIM)) {
    const preceding = analysis.slice(0, found.index).replace(PYTHON_TRIM_END, '');
    if ((/^(approved by|authorized to execute|permission|approval|execution|release|deployment)/u.test(found[0]) &&
         NEGATED_AUTHORITY.test(preceding)) ||
        (/^(approved by|authorized to execute)/u.test(found[0]) &&
         REQUIRED_AUTHORITY.test(preceding))) continue;
    fail(`${label} must not contain an authority claim`);
  }
  return value;
}

function record(value: unknown, label: string): HarnessDecision {
  const input = fields(value, ['id', 'reason'], label);
  return { id: text(input.id, `${label}.id`), reason: text(input.reason, `${label}.reason`) };
}
function provenance(value: unknown): HarnessProvenance {
  const input = fields(value, PROVENANCE_FIELDS, 'provenance');
  function records(field: string): HarnessDecision[] {
    const result = array(input[field], `provenance.${field}`).map((item) => record(item, field));
    if (new Set(result.map((item) => item.id)).size !== result.length) {
      fail(`provenance.${field} ids must be unique`);
    }
    return result.sort((a, b) => compare(a.id, b.id));
  }
  return {
    repositoryEvidenceIndexSha256: match(input.repositoryEvidenceIndexSha256, SHA256, 'provenance.repositoryEvidenceIndexSha256'),
    controlInventorySha256: match(input.controlInventorySha256, SHA256, 'provenance.controlInventorySha256'),
    requirementProfileSha256: match(input.requirementProfileSha256, SHA256, 'provenance.requirementProfileSha256'),
    gapAnalysisSha256: match(input.gapAnalysisSha256, SHA256, 'provenance.gapAnalysisSha256'),
    sourceRevision: match(input.sourceRevision, REVISION, 'provenance.sourceRevision'),
    compilerVersion: match(input.compilerVersion, VERSION, 'provenance.compilerVersion'),
    unresolvedDecisions: records('unresolvedDecisions'),
    unresolvedGaps: records('unresolvedGaps'),
  };
}

function normalizedPosixPath(value: string): string {
  const prefix = value.startsWith('//') && !value.startsWith('///') ? '//' : value.startsWith('/') ? '/' : '';
  return prefix + value.split('/').filter((part) => part !== '' && part !== '.').join('/') || '.';
}
function canonicalAddress(value: string): string | undefined {
  const version = isIP(value);
  if (version === 4) return value;
  if (version === 6) return new URL(`http://[${value}]/`).hostname.slice(1, -1);
  return undefined;
}
function addressBits(address: string): bigint {
  if (isIP(address) === 4) {
    return address.split('.').reduce((bits, part) => (bits << 8n) | BigInt(part), 0n);
  }
  const [left = '', right] = address.split('::');
  const leading = left ? left.split(':') : [];
  const trailing = right ? right.split(':') : [];
  const groups = right === undefined ? leading : [...leading, ...Array<string>(8 - leading.length - trailing.length).fill('0'), ...trailing];
  return groups.reduce((bits, part) => (bits << 16n) | BigInt(`0x${part}`), 0n);
}
function boundedDomain(value: string, label: string): void {
  const bounded = (): never => fail(`${label}.value must be a bounded domain target`);
  const normalized = (): never => fail(`${label}.value must be a normalized domain target`);
  if (value.startsWith('[') || value.includes('%') || HAS_PYTHON_SPACE.test(value)) normalized();
  if (value.includes('/') && !value.includes('://')) {
    const parts = value.split('/');
    const address = canonicalAddress(parts[0] ?? '');
    const prefixText = parts[1] ?? '';
    if (parts.length !== 2 || !address || !/^[0-9]+$/u.test(prefixText)) bounded();
    const networkAddress = address ?? bounded();
    const prefix = Number(prefixText), bits = isIP(networkAddress) === 4 ? 32 : 128;
    if (prefix <= 0 || prefix > bits || `${address}/${prefix}` !== value ||
        (addressBits(networkAddress) & ((1n << BigInt(bits - prefix)) - 1n)) !== 0n) bounded();
    return;
  }
  const address = canonicalAddress(value);
  if (address !== undefined) {
    if (address === '0.0.0.0' || address === '::' || address !== value) bounded();
    return;
  }
  // Parse without WHATWG URL normalization, which would silently repair host,
  // port, dot-path, and default-port inputs rejected by the native contract.
  let scheme = '', rest = value;
  if (value.includes('://')) {
    const split = value.indexOf('://');
    scheme = value.slice(0, split).toLowerCase();
    rest = value.slice(split + 3);
    if (!['http', 'https'].includes(scheme)) bounded();
  }
  const parsed = /^([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/u.exec(rest) ?? bounded();
  const netloc = parsed[1] ?? '', path = parsed[2] ?? '', query = parsed[3], fragment = parsed[4];
  if (!netloc || netloc.includes('@') || query || fragment || (path && !scheme)) bounded();
  let host: string, portText: string | undefined;
  if (netloc.startsWith('[')) {
    const end = netloc.indexOf(']');
    if (end < 0) bounded();
    host = netloc.slice(1, end).toLowerCase();
    const suffix = netloc.slice(end + 1);
    if (suffix) { if (!suffix.startsWith(':')) bounded(); portText = suffix.slice(1); }
    if (isIP(host) !== 6) bounded();
  } else {
    const pieces = netloc.split(':');
    if (pieces.length > 2) bounded();
    host = (pieces[0] ?? '').toLowerCase();
    portText = pieces[1];
  }
  let port: number | undefined;
  if (portText !== undefined && portText !== '') {
    if (!/^[0-9]+$/u.test(portText)) bounded();
    port = Number(portText);
    if (port <= 0 || port > 65535 || !scheme) bounded();
  }
  if (!host) bounded();
  const hostAddress = canonicalAddress(host);
  if (hostAddress !== undefined) {
    if (hostAddress === '0.0.0.0' || hostAddress === '::' || hostAddress !== host) bounded();
  } else if (/^[0-9.]+$/u.test(host) || host.split('.').some((part) => !HOST_LABEL.test(part))) bounded();
  const canonicalHost = host.includes(':') ? `[${host}]` : host;
  const canonicalNetloc = port === undefined ? canonicalHost : `${canonicalHost}:${port}`;
  if (netloc !== canonicalNetloc || path === '/' ||
      (path && (path.split('/').includes('..') || normalizedPosixPath(path) !== path))) normalized();
}
function target(value: unknown, label: string): HarnessTarget {
  const input = fields(value, ['kind', 'value'], label);
  const kind = text(input.kind, `${label}.kind`), result = text(input.value, `${label}.value`);
  if (result.includes('*') || ['.', 'all', 'any', 'everything'].includes(result.toLowerCase())) {
    fail(`${label}.value must be bounded`);
  }
  if (kind === 'path' && (result.startsWith('/') || result.split('/').includes('..') || normalizedPosixPath(result) !== result)) {
    fail(`${label}.value must be a normalized relative path`);
  }
  if (kind === 'domain') boundedDomain(result, label);
  return { kind, value: result };
}
function action(value: unknown): string {
  const result = text(value, 'requiredSemantics.actions');
  const parsed = /^(require|deny|observe|verify|limit):([a-z][a-z0-9-]*)$/u.exec(result);
  if (!parsed) fail('requiredSemantics.actions must express a bounded constraint');
  if (['all', 'any', 'everything'].includes(parsed[2] ?? '')) fail('requiredSemantics.actions must be bounded');
  return result;
}
function semantic(value: unknown): HarnessSemanticRequirement {
  if (!object(value)) fail('requiredSemantics must contain objects');
  const input = fields(value, [...SEMANTIC_FIELDS, ...(Object.hasOwn(value, 'id') ? ['id'] : [])], 'requiredSemantics');
  const category = text(input.category, 'requiredSemantics.category');
  if (!CATEGORIES.has(category)) fail('requiredSemantics.category is unsupported');
  const actions = [...new Set(array(input.actions, 'requiredSemantics.actions').map(action))].sort(compare);
  if (!actions.length) fail('requiredSemantics.actions must not be empty');
  const conditions = array(input.conditions, 'requiredSemantics.conditions')
    .map((item) => target(item, 'requiredSemantics.conditions')).sort((a, b) => compare(sha256(a), sha256(b)));
  if (new Set(conditions.map(sha256)).size !== conditions.length) fail('requiredSemantics.conditions must be unique');
  const identity = {
    intent: text(input.intent, 'requiredSemantics.intent'),
    category,
    subject: target(input.subject, 'requiredSemantics.subject'),
    actions,
    conditions,
    scope: target(input.scope, 'requiredSemantics.scope'),
  };
  const minimumEvidenceState = text(input.minimumEvidenceState, 'minimumEvidenceState');
  if (!EVIDENCE_STATES.has(minimumEvidenceState)) fail('minimumEvidenceState is unsupported');
  if (identity.subject.kind === 'permissions' && !['path', 'domain'].includes(identity.scope.kind)) {
    fail('permissions require a bounded scope');
  }
  if (NATIVE_PROVIDER.test(canonicalJson(identity))) {
    fail('provider and runtime names belong in projection metadata, not canonical semantics');
  }
  const id = sha256(identity);
  if (Object.hasOwn(input, 'id') && input.id !== id) fail('requiredSemantics.id does not match semantic identity');
  return { id, ...identity, minimumEvidenceState };
}
function unsupported(value: unknown): HarnessUnsupportedSemantic {
  const input = fields(value, ['semantic', 'reason'], 'unsupportedSemantics');
  const name = text(input.semantic, 'unsupportedSemantics.semantic');
  if (!IDENTIFIER.test(name)) fail('unsupportedSemantics.semantic must be a neutral identifier');
  return { semantic: name, reason: text(input.reason, 'unsupportedSemantics.reason') };
}
function hint(value: unknown): HarnessProjectionHint {
  const input = fields(value, ['semantic', 'hint'], 'runtimeProjectionHints');
  const name = text(input.semantic, 'runtimeProjectionHints.semantic');
  const preference = text(input.hint, 'runtimeProjectionHints.hint');
  if (!IDENTIFIER.test(name) || !HINTS.has(preference)) fail('runtimeProjectionHints must use neutral, supported hints');
  return { semantic: name, hint: preference };
}

/** Build a canonical proposal. It conveys no adoption or execution authority. */
export function buildHarnessProfile(
  provenanceInput: unknown,
  requiredSemantics: unknown,
  options: { unsupportedSemantics?: unknown; runtimeProjectionHints?: unknown } = {},
): HarnessProfile {
  const bound = provenance(provenanceInput);
  const requirements = array(requiredSemantics, 'requiredSemantics').map(semantic).sort((a, b) => compare(a.id, b.id));
  if (!requirements.length || new Set(requirements.map((item) => item.id)).size !== requirements.length) {
    fail('requiredSemantics must contain unique requirements');
  }
  const unsupportedSemantics = array(options.unsupportedSemantics === undefined ? [] : options.unsupportedSemantics, 'unsupportedSemantics')
    .map(unsupported).sort((a, b) => compare(a.semantic, b.semantic));
  if (new Set(unsupportedSemantics.map((item) => item.semantic)).size !== unsupportedSemantics.length) {
    fail('unsupportedSemantics must name each semantic once');
  }
  const runtimeProjectionHints = array(options.runtimeProjectionHints === undefined ? [] : options.runtimeProjectionHints, 'runtimeProjectionHints')
    .map(hint).sort((a, b) => compare(a.semantic, b.semantic) || compare(a.hint, b.hint));
  if (new Set(runtimeProjectionHints.map((item) => canonicalJson([item.semantic, item.hint]))).size !== runtimeProjectionHints.length) {
    fail('runtimeProjectionHints must be unique');
  }
  const stable = {
    schemaVersion: 1 as const, kind: 'HarnessProfile' as const, state: 'PROPOSED' as const,
    provenance: bound, requiredSemantics: requirements, unsupportedSemantics, runtimeProjectionHints,
    claimBoundary: HARNESS_PROFILE_CLAIM_BOUNDARY,
  };
  const profileSha256 = sha256(stable);
  return { ...stable, id: `HARNESS-${profileSha256.slice(0, 16).toUpperCase()}`, profileSha256 };
}

/**
 * Validate an already parsed object's canonical proposal integrity, not admission.
 * Parsing erases numeric token spelling (1, 1.0, 1e0); serialized canonical-byte
 * validation belongs to a future accepted carrier and is not supplied here.
 */
export function validateHarnessProfile(value: unknown): string[] {
  if (!object(value)) return ['Harness Profile must be an object'];
  if (!Number.isInteger(value.schemaVersion) || value.schemaVersion !== 1) return ['unsupported schemaVersion'];
  if (value.kind !== 'HarnessProfile') return ['unsupported kind'];
  if (value.state !== 'PROPOSED') return ['state must remain PROPOSED'];
  try {
    fields(value, PROFILE_FIELDS, 'Harness Profile');
    const expected = buildHarnessProfile(value.provenance, value.requiredSemantics, {
      unsupportedSemantics: value.unsupportedSemantics,
      runtimeProjectionHints: value.runtimeProjectionHints,
    });
    return canonicalJson(value) === canonicalJson(expected) ? [] : ['profile does not match canonical content or digest'];
  } catch (error) {
    if (error instanceof HarnessProfileError || error instanceof TypeError || error instanceof RangeError) return [error.message];
    throw error;
  }
}
