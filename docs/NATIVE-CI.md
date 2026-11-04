# Native CI prerequisites

AgentFlow's required native integration test exercises the real Proofloom and
Orbit return loop against disposable records with an inert worker. Setting only
`AFI003_OUTPUT_ROOT` does not provision that loop. Missing native inputs must
fail qualification; they are not a reason to skip the test or replace its oracle.

The two verification workflows and tag qualification reuse the same fixture
setup. Public AgentFlow source lives in `agentflow/`; protected native checkouts
are siblings, outside the source archive and npm packaging tree. The existing
`npm run verify` and `npm run release:verify` commands remain authoritative.

## Fixed inputs

| Input | Version |
| --- | --- |
| Native source, including tests and scripts | PROOFLOOM `34ed5877b2a92c3b65081ad13b19803d44d8096d` |
| Existing private portable fixture package | PROOFLOOM `1540ec475827926204b739a28ec0d6c02c967472` |
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

Hosted native qualification requires an administrator-configured environment
named `wale-native-ci`, with required owner review of the actual source and
workflow revision. Referencing that environment in YAML does not establish that
its protection rules or credentials have been configured. Configure protection
before enabling the credential.

Use a dedicated **read-only deploy key scoped to PROOFLOOM**, stored only as the
environment secret `WALE_NATIVE_READ_KEY`. Pass it only to the private checkout
steps, with `persist-credentials: false`. The ordinary Actions repository token
is not cross-repository private-read authorization. Do not use an account SSH
key, publish a private key, enable repository writes, or place the credential
in a job-wide environment variable.

The native-input preflight also refuses fork and Dependabot execution and
unexpected repositories, actors or refs. It does not make unreviewed code safe:
the protected environment's exact-source review is the trust boundary. A failed
or unapproved preflight must not produce a successful qualification check.

Deploy keys do not expire automatically. Record the key's owner and purpose,
rotate it as needed, and revoke it and the environment secret when this access
is no longer required. Creating the credential or changing its trust scope
requires the repository owner's authorization.

## Public evidence and private diagnostics

Private checkout actions can expose the private repository name, pinned commit
hashes and subjects, filesystem paths and ordinary Git diagnostics. The owner
must authorize that limited metadata disclosure before hosted activation.
`show-progress: false` reduces progress output; it does not silence checkout.
This exception does not authorize disclosure of private file contents.

Code under test can read its private inputs. Capture both output streams of
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
