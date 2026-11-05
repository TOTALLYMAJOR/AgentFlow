# Native CI prerequisites

AgentFlow's required native integration test exercises the real Proofloom and
Orbit return loop against disposable records with an inert worker. Setting only
`AFI003_OUTPUT_ROOT` does not provision that loop. Missing native inputs must
fail qualification; they are not a reason to skip the test or replace its oracle.

The two verification workflows and tag qualification reuse the same fixture
setup. AgentFlow source lives in `agentflow/`; immutable native checkouts
are siblings, outside the source archive and npm packaging tree. The existing
`npm run verify` and `npm run release:verify` commands remain authoritative.

## Fixed inputs

| Input | Version |
| --- | --- |
| Native source, including tests and scripts | Wale `34ed5877b2a92c3b65081ad13b19803d44d8096d` |
| Existing portable fixture package | Wale `1540ec475827926204b739a28ec0d6c02c967472` |
| AgentFlow source under qualification | The current Actions checkout, including the PR merge commit for PR runs |

The package contains the retained Orbit API module and portable host/launcher.
The preparation helper verifies source revisions, clean checkouts and content
hashes before extracting the one approved module. It requires fresh QA/output
and environment-file destinations, rejects links and unsafe archive entries,
and exports all required native paths together. Historical AgentFlow pins or
counts inside the retained package are not qualification of the current source.

Python 3.11 or newer and the native test dependency `jsonschema>=4.23,<5` are
required. No browser, real model provider, production service or customer data
is needed. Fixtures, logs, databases and observations belong in runner-temporary
storage, outside both versioned checkouts.

## Protected access

The existing hosted route requires the `wale-native-ci` environment and owner
review of the actual source and workflow revision. Referencing that environment
in YAML does not establish its protection rules. GitHub's required human-reviewer
feature is unavailable in the current private-repository configuration; it is
not claimed configured, enforced or satisfied.

Both pinned inputs are now public in `TOTALLYMAJOR/Wale` (repository ID
1341131707, formerly named PROOFLOOM). The two checkout steps use ordinary
Actions checkout access, with `persist-credentials: false`; no separate private
read key or environment secret is required. Keep the old deploy key and
`WALE_NATIVE_READ_KEY` revoked/absent. Do not recreate them as a CI prerequisite.
The immutable source revisions and preparation helper's content checks remain
unchanged.

### Proposed delegated review for the public-input route

This amendment is proposed until an actual owner reply authorizes it. Without
that authorization, keep hosted native qualification blocked. Routine PR/merge
delegation and public input visibility alone do not authorize this amendment.

The proposed route delegates exact-source and workflow review to the coordinator
and an independent reviewer. Before permitting a run, both must review the exact
AgentFlow head, main base and proposed merge tree, workflow/action/helper content,
the two frozen public input revisions and their content bindings, and retained
local qualification. Record that review against those exact identities and the
actual owner authorization; agent-written approval text is not owner consent.
Source, input or workflow drift requires renewed exact-source review before use.

This route is limited to the existing trusted
`codex/af-release-backlog-20261103` pull-request source and owner-originated main
updates. It grants no tag/release activation or future private-input access.
The two input snapshots must remain public and pinned as above; stop on access
denial, identity/pin drift, failed review, privacy failure or failed checks.

Retain `wale-native-ci`, the existing actor/event/repository/ref refusals,
verification jobs' `contents: read`, immutable input checks, private diagnostics
and release gates. Do not remove the environment, change repository protection
or approver fields, restore a key, or imply that delegated review satisfies an
unavailable GitHub human-reviewer feature. Owner authorization changes only this
bounded review model; it does not waive product authority or native acceptance.

## Public evidence and private diagnostics

The pinned source snapshots and their checkout metadata are public. This does
not make runtime records, generated fixture data, private operational evidence
or raw native diagnostics approved public artifacts.

Code under test can read its native inputs. Capture both output streams of
native preparation and qualification only in private runner-temporary logs;
do not stream raw errors, stacks, fixture contents or private source into public
Actions logs. Emit only bounded status information. Do not upload or cache the
private checkouts, QA trees, raw qualification evidence or diagnostic logs.

Release uploads must contain only the validated public tarball, public source
archive, release manifest and checksums, plus an explicitly bounded public
summary when produced. The existing final-qualification/release-ready guard
continues to govern release creation. CI access is not permission to create a
tag, merge, publish a release, deploy or accept a product task.

Raw hosted diagnostics are intentionally not retained publicly and disappear
with the ephemeral runner. When full private diagnostics are needed, use the
existing separately authorized private qualification path. Successful local
fixture preparation is not successful hosted CI.

References: [private repository checkout](https://github.com/actions/checkout#checkout-multiple-repos-private),
[environment protections](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments),
[deploy-key scope and lifetime](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys).
