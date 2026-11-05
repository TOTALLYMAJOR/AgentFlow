/** Local trusted fixture qualification. Never registers or dispatches this checkout. */
import { spawn, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, chmod, access, copyFile, mkdtemp, open, readdir, rename, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../apps/server/src/http/app.js";
import { resolveEnvironment } from "../apps/server/src/config/environment.js";
import { makeDesignIntelligenceReceipt } from "../apps/server/src/integration/design-intelligence-receipt.js";
import { canonicalJsonSha256, GovernedTaskHandoffSchema } from "../apps/server/src/integration/design-intelligence.js";
const execute = promisify(execFile);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T | undefined>, label: string, timeout = 45_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await read(); if (result !== undefined) return result; await pause(100); }
  throw new Error(`Timed out waiting for ${label}`);
}
async function jsonFile<T>(file: string): Promise<T | undefined> { try { return JSON.parse(await readFile(file, "utf8")) as T; } catch { return undefined; } }
function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`Explicit fixture configuration required: ${name}`); return path.resolve(value); }
type BridgeMarkerWriter = (file: FileHandle, contents: string) => Promise<void>;
async function publishSourceReady(file: string, contents: string, write: BridgeMarkerWriter = async (handle, payload) => { await handle.writeFile(payload); }): Promise<void> {
  const pending = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.pending`);
  const handle = await open(pending, "wx", 0o600);
  try {
    try { await write(handle, contents); } finally { await handle.close(); }
    await rename(pending, file);
  } finally { await rm(pending, { force: true }); }
}

describe("AFI-003 source-ready publication", () => {
  it("keeps the receiver-ready path absent until the complete payload can be read", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "afi003-ready-publication-"));
    const ready = path.join(directory, "source-ready.json");
    const contents = JSON.stringify({ url: "http://127.0.0.1:47821", token: "inert-marker-test" });
    let started = () => {}; let release = () => {};
    const writing = new Promise<void>((resolve) => { started = resolve; });
    const proceed = new Promise<void>((resolve) => { release = resolve; });
    const publication = publishSourceReady(ready, contents, async (handle, payload) => {
      started(); await proceed; await handle.writeFile(payload);
    });
    try {
      await writing;
      await expect(access(ready)).rejects.toMatchObject({ code: "ENOENT" });
      release(); await publication;
      expect(await readFile(ready, "utf8")).toBe(contents);
      const received = await execute("python3", ["-c", "import json,pathlib,sys;print(json.dumps(json.loads(pathlib.Path(sys.argv[1]).read_text())))", ready]);
      expect(JSON.parse(received.stdout)).toEqual(JSON.parse(contents));
      expect(await readdir(directory)).toEqual(["source-ready.json"]);
    } finally { release(); await publication.catch(() => {}); await rm(directory, { recursive: true, force: true }); }
  });

  it("does not expose a partial payload after a failed write and preserves unrelated files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "afi003-ready-write-failure-"));
    const ready = path.join(directory, "source-ready.json");
    const unrelated = path.join(directory, "unrelated.txt"); await writeFile(unrelated, "retained");
    try {
      await expect(publishSourceReady(ready, JSON.stringify({ url: "inert", token: "inert" }), async (handle, payload) => {
        await handle.writeFile(payload.slice(0, 4));
        throw new Error("inert write failure after partial bytes");
      })).rejects.toThrow("inert write failure after partial bytes");
      await expect(access(ready)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(unrelated, "utf8")).toBe("retained");
      expect(await readdir(directory)).toEqual(["unrelated.txt"]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe("AFI-003 genuine local native return loop", () => {
  it("refuses missing fixture provider configuration rather than inheriting ambient Codex", () => {
    expect(() => required("AFI003_UNSET_FIXTURE_PROVIDER_SENTINEL")).toThrow("Explicit fixture configuration required");
  });
  it("executes only the temporary fixture through native HTTP/coordinator, receipt and frozen Proofloom", async () => {
    const output = required("AFI003_OUTPUT_ROOT");
    const hostScript = required("AFI003_FIXTURE_HOST");
    const nativeRoot = required("AFI003_NATIVE_ROOT");
    await mkdir(output, { recursive: true });
    const control = path.join(output, `run-${Date.now()}`); await mkdir(control);
    const provider = path.join(control, "fixture-provider.mjs");
    const sentinel = path.join(control, "fixture-provider-calls.jsonl");
    // Explicit executable I/O double. It has no child-process/network calls or real provider fallback.
    await writeFile(provider, `#!/usr/bin/env node\nimport {readFileSync,appendFileSync,mkdirSync,writeFileSync} from 'node:fs';\nreadFileSync(0,'utf8');\nappendFileSync(${JSON.stringify(sentinel)}, JSON.stringify({executable:process.argv[1],cwd:process.cwd()})+'\\n');\nlet mode; do { try { mode=JSON.parse(readFileSync(${JSON.stringify(path.join(control, 'provider-mode.json'))},'utf8')).mode; } catch { mode='complete'; } if(mode==='hold') await new Promise(r=>setTimeout(r,100)); } while(mode==='hold');\nif(mode==='fail')process.exit(23);\nmkdirSync('src/contracts',{recursive:true});writeFileSync('src/contracts/result.txt',mode==='invalid-check'?'invalid\\n':mode==='overflow'?'qualified\\n'+'extra\\n'.repeat(32):'qualified\\n');\nprocess.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({status:'completed',summary:'Explicit fixture-only worker',validation_notes:['Native validator must run npm test'],handoff_notes:['No provider API invoked']})}})+'\\n');\n`);
    await chmod(provider, 0o700);
    expect(path.isAbsolute(provider)).toBe(true); await access(provider);
    const host = spawn("python3", [hostScript, control], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let hostLog = ""; host.stdout.on("data", (chunk: Buffer) => { hostLog += chunk.toString(); }); host.stderr.on("data", (chunk: Buffer) => { hostLog += chunk.toString(); });
    const token = "afi003_fixture_only_token_" + "x".repeat(30);
    const environment = resolveEnvironment({ AGENTFLOW_HOME: path.join(control, "agentflow-home"), AGENTFLOW_CODEX_BIN: provider, AGENTFLOW_DEFAULT_AGENT_PROVIDER: "codex", AGENTFLOW_LOG_LEVEL: "silent", AGENTFLOW_WALE_BRIDGE_TOKEN_SHA256: createHash("sha256").update(token).digest("hex") });
    let built: Awaited<ReturnType<typeof buildApp>> | undefined;
    let restoreDecisionCapture = () => {};
    try {
      type Fixture = {consumerRoot: string; executionRoot: string; evidenceRoot: string; handoffPath: string; receiptPath: string; b0: string};
      const fixture = await until(() => jsonFile<Fixture>(path.join(control, "fixture.json")), "native governed fixture");
      const corpus = [{"é-authority/文.md": {z:2,A:1},"AGENTS.md":true,"adapters/a":null},{"adapters/a":null,"AGENTS.md":true,"é-authority/文.md": {A:1,z:2}}];
      const canonical = await execute("python3",["-c","import json,sys;from design_intelligence.agentflow_contracts import canonical_json_sha256;print(json.dumps([canonical_json_sha256(v) for v in json.loads(sys.argv[1])]))",JSON.stringify(corpus)],{cwd:nativeRoot,env:{...process.env,PYTHONDONTWRITEBYTECODE:"1"}});
      expect(JSON.parse(canonical.stdout)).toEqual(corpus.map(canonicalJsonSha256));
      await writeFile(path.join(control,"canonical-parity.json"),canonical.stdout);
      const git = async (...args: string[]) => (await execute("git", ["-C", fixture.executionRoot, ...args])).stdout.trim();
      await execute("git", ["-C", fixture.consumerRoot, "worktree", "add", "-b", "afi003-execution", fixture.executionRoot, fixture.b0]);
      expect(path.resolve(fixture.executionRoot)).not.toBe(path.resolve(process.cwd()));
      await mkdir(path.join(fixture.executionRoot, "artifacts"), { recursive: true });
      await copyFile(fixture.handoffPath, path.join(fixture.executionRoot, "artifacts/handoff.json"));
      await git("add", "artifacts/handoff.json"); await git("commit", "-m", "fixture handoff carrier");
      built = await buildApp({ environment, staticRoot: false, logger: false });
      let {app, context} = built;
      app.addHook("onSend",async(request,reply,payload)=>{if(request.url.startsWith("/api/wale/"))await writeFile(path.join(control,"actual-bridge-http.jsonl"),JSON.stringify({method:request.method,url:request.url,requestBody:request.body,status:reply.statusCode,responseBody:typeof payload==="string"?payload:Buffer.isBuffer(payload)?payload.toString():null})+"\n",{flag:"a"});return payload;});
      const address = await app.listen({host:"127.0.0.1",port:0});
      const http = async (route: string, payload?: unknown, authorized = false) => {
        const response = await fetch(address+route, {method: payload === undefined ? "GET" : "POST",headers:{"content-type":"application/json",...(authorized ? {authorization:`Bearer ${token}`} : {})},...(payload === undefined ? {} : {body:JSON.stringify(payload)})});
        const text = await response.text(); const body = text ? JSON.parse(text) as Record<string, unknown> : {};
        await writeFile(path.join(control, "http.jsonl"), JSON.stringify({route,status:response.status,body})+"\n",{flag:"a"});
        return {status:response.status,body,headers:response.headers};
      };
      const registered = await http("/api/repositories", {path:fixture.executionRoot}); expect(registered.status,JSON.stringify(registered.body)).toBe(201);
      const repositoryId = registered.body.id;
      const carrierHandoff = path.join(fixture.executionRoot,"artifacts/handoff.json");
      const approvedBytes = await readFile(carrierHandoff);
      await writeFile(path.join(control,"approved-native-handoff.json"),approvedBytes);
      const approvedObject = JSON.parse(approvedBytes.toString()) as Record<string,unknown>;
      const approvedCanonical=await jsonFile<{rawCanonicalSha256:string;normalizedCanonicalSha256:string}>(path.join(control,"native-approved-canonical.json"));expect(approvedCanonical).toBeDefined();expect(approvedCanonical?.rawCanonicalSha256).toBe(approvedCanonical?.normalizedCanonicalSha256);expect(canonicalJsonSha256(approvedObject)).toBe(approvedCanonical?.rawCanonicalSha256);expect(canonicalJsonSha256(GovernedTaskHandoffSchema.parse(approvedObject))).toBe(approvedCanonical?.rawCanonicalSha256);

      for(const mutation of [{...approvedObject,schemaVersion:"2.0.0"},{...approvedObject,taskValidationRuntime:{enabled:true}},{...approvedObject,runtime:{required:true}},{...approvedObject,authority:{status:"APPROVED",approvedBy:"forged"}},{...approvedObject,tasks:[]}]) {
        try {
          await writeFile(carrierHandoff,JSON.stringify(mutation));
          const refused=await http("/api/design-intelligence/handoffs/import",{repositoryId,handoffPath:"artifacts/handoff.json"});
          expect(refused.status,JSON.stringify(refused.body)).toBeGreaterThanOrEqual(400);
        } finally {await writeFile(carrierHandoff,approvedBytes);}
      }
      const authorityPath=path.join(fixture.executionRoot,"AGENTS.md");const authorityBytes=await readFile(authorityPath);
      try {
        await writeFile(authorityPath,Buffer.concat([authorityBytes,Buffer.from("\nunauthorized dirty authority\n")]));
        const dirty=await http("/api/design-intelligence/handoffs/import",{repositoryId,handoffPath:"artifacts/handoff.json"});expect(dirty.status).toBe(409);expect(dirty.body).toMatchObject({error:{code:"GOVERNED_HANDOFF_NOT_EXECUTABLE"}});
      }finally {await writeFile(authorityPath,authorityBytes);}
      expect(context.store.builds.list({limit:100})).toHaveLength(0);await expect(access(sentinel)).rejects.toThrow();
      const imported = await http("/api/design-intelligence/handoffs/import",{repositoryId,handoffPath:"artifacts/handoff.json"}); expect(imported.status,JSON.stringify(imported.body)).toBe(200);
      await git("add","BACKLOG.design-intelligence.proposed.md");await git("commit","-m","fixture reviewed backlog carrier");
      const b1 = await git("rev-parse","HEAD");expect(b1).not.toBe(fixture.b0);
      const planned = await http("/api/plans",{repositoryId,backlogPath:"BACKLOG.design-intelligence.proposed.md"}); expect(planned.status,JSON.stringify(planned.body)).toBe(201);
      const created = await http("/api/builds",{planId:planned.body.id}); expect(created.status,JSON.stringify(created.body)).toBe(201);
      const sourceBuild = String(created.body.id);
      expect(context.store.builds.getById(sourceBuild).status).toBe("ready");
      await expect(access(sentinel)).rejects.toThrow(); // preparation never calls a worker
      // Read actual native rows at the persistence seam. Final rows can change;
      // never reconstruct a past source digest from the final integrated state.
      const captureDecisionSources = () => ({
        build: context.store.builds.getById(sourceBuild),
        tasks: context.store.tasks.listForBuild(sourceBuild).map(task => ({
          task, attempts: context.store.tasks.listAttempts(task.id).map(attempt => ({
            attempt, changedFiles: context.store.tasks.listChangedFiles(task.id, attempt.attempt),
          })),
        })),
        events: context.store.events.listForBuild(sourceBuild, {limit:10000}),
      });
      const decisionSamples = new Map<string, ReturnType<typeof captureDecisionSources>>();
      const appendNativeEvent = context.store.events.append.bind(context.store.events);
      const decisionCapture = vi.spyOn(context.store.events, "append").mockImplementation(input => {
        if(input.buildId === sourceBuild && input.type === "governor.decision") {
          decisionSamples.set(String(input.payload?.recordHash), captureDecisionSources());
        }
        return appendNativeEvent(input);
      });
      restoreDecisionCapture = () => decisionCapture.mockRestore();
      const governor = await http(`/api/builds/${sourceBuild}/governor/evaluate`,{});expect(governor.status).toBe(200);expect(governor.body.acknowledgement).toMatchObject({acknowledged:true});
      const start = await http(`/api/builds/${sourceBuild}/start`,{});expect(start.status,JSON.stringify(start.body)).toBe(200);
      await until(async()=>{const build=context.store.builds.getById(sourceBuild);if(build.status==="paused"){await writeFile(path.join(control,"source-native-paused-records.json"),JSON.stringify({build,tasks:context.store.tasks.listForBuild(sourceBuild),validations:context.store.validations.listForBuild(sourceBuild),events:context.store.events.listForBuild(sourceBuild,{limit:10000})},null,2));throw new Error("Native source build paused at a genuine authority/evidence gate; see retained source-native-paused-records.json");}return ["completed","failed","cancelled"].includes(build.status)?build:undefined;},"native source build terminal");
      expect(context.store.builds.getById(sourceBuild).status,JSON.stringify(context.store.events.listForBuild(sourceBuild))).toBe("completed");
      const tasks=context.store.tasks.listForBuild(sourceBuild);expect(tasks).toHaveLength(1);expect(tasks[0]).toMatchObject({backlogTaskId:"AF-001",state:"integrated"});
      expect(context.store.validations.listForBuild(sourceBuild).map(v=>v.validationType)).toEqual(expect.arrayContaining(["task","integration"]));
      const emitted = await makeDesignIntelligenceReceipt(context,sourceBuild);
      const sourceEvents=context.store.events.listForBuild(sourceBuild,{limit:10000});expect(sourceEvents.some(event=>event.type==="evidence.native_validation_certified")).toBe(true);
      const focusedArtifact=emitted.receipt.evidence.artifacts.find(artifact=>artifact.class==="focused tests");expect(focusedArtifact).toBeDefined();
      const focusedSource=emitted.sources.find(source=>source.relativePath===focusedArtifact?.path);if(focusedSource===undefined)throw new Error("Native focused tests certificate bytes missing");
      expect(JSON.parse(await readFile(focusedSource.sourcePath,"utf8"))).toMatchObject({kind:"agentflow/native-task-validation-evidence",schemaVersion:"1.0.0",handoffSha256:emitted.receipt.handoff.sha256,producer:{buildId:sourceBuild,backlogTaskId:"AF-001",attempt:1},artifact:{name:"focused tests",type:"agentflow/native-task-validation-evidence",version:"1.0.0"}});

      // Join decision-time references to real persisted rows and current
      // approval bytes, then join the retained export to those exact events.
      const nativeBuild = context.store.builds.getById(sourceBuild);
      if(nativeBuild.planId === null) throw new Error("Native source build has no immutable plan");
      const nativePlan = context.store.plans.getById(nativeBuild.planId);
      const approvedHandoff = GovernedTaskHandoffSchema.parse(approvedObject);
      expect(nativePlan.lockedAt).not.toBeNull();
      expect(nativePlan.normalizedPlan.governedHandoff).toMatchObject({id:approvedHandoff.handoffId,sha256:canonicalJsonSha256(approvedHandoff),governedBaseCommit:fixture.b0,executionBaseCommit:b1});
      expect(nativeBuild.normalizedPlan).toEqual(nativePlan.normalizedPlan);
      const decisions = sourceEvents.filter(event => event.type === "governor.decision");
      const acknowledgements = sourceEvents.filter(event => event.type === "governor.intervention_acknowledged");
      expect(decisions.length).toBeGreaterThanOrEqual(2);
      expect(acknowledgements.map(event => event.payload.invocationSource)).toEqual(expect.arrayContaining(["local-http-api","agentflow-coordinator"]));
      await writeFile(path.join(control,"source-decision-time-records.json"),JSON.stringify([...decisionSamples].map(([recordHash,snapshot])=>({recordHash,snapshot})),null,2));
      for(const decision of decisions) {
        const sample = decisionSamples.get(String(decision.payload.recordHash));
        if(sample === undefined) throw new Error("Decision has no captured native source rows");
        expect(decision.payload).toMatchObject({
          authorityObservation:{handoffId:approvedHandoff.handoffId,handoffSha256:canonicalJsonSha256(approvedHandoff),baseCommit:approvedHandoff.repository.baseCommit,snapshotSha256:approvedHandoff.repository.snapshotSha256,authorityStateSha256:approvedHandoff.authority.stateSha256,governanceReportSha256:approvedHandoff.authority.governanceReportSha256,authoritySources:approvedHandoff.authority.sources},
          nativeSources:{
            build:{id:sourceBuild,repositoryId:nativeBuild.repositoryId,planId:nativePlan.id,baseCommit:b1,sha256:canonicalJsonSha256(sample.build)},
            handoff:{id:approvedHandoff.handoffId,sha256:canonicalJsonSha256(approvedHandoff),governedBaseCommit:fixture.b0},
            tasks:sample.tasks.map(({task,attempts})=>({id:task.id,buildId:task.buildId,backlogTaskId:task.backlogTaskId,baseCommit:task.baseCommit,resultCommit:task.resultCommit,integrationCommit:task.integrationCommit,sha256:canonicalJsonSha256(task),attempts:attempts.map(({attempt,changedFiles})=>({id:attempt.id,buildId:attempt.buildId,taskId:attempt.taskId,attempt:attempt.attempt,resultCommit:attempt.resultCommit,sha256:canonicalJsonSha256(attempt),changedFilesSha256:canonicalJsonSha256(changedFiles)}))})),
            events:{throughSequence:sample.events.at(-1)?.sequence??0,count:sample.events.length,sha256:canonicalJsonSha256(sample.events)},
          },
        });
        expect(sample.events).toEqual(sourceEvents.filter(event => event.sequence < decision.sequence));
      }
      const initialSample = decisionSamples.get(String(decisions[0]?.payload.recordHash));
      expect(initialSample?.tasks[0]?.task).toMatchObject({baseCommit:null,resultCommit:null,integrationCommit:null});
      const certificateBody = JSON.parse(await readFile(focusedSource.sourcePath,"utf8")) as {producer:{taskId:string;attempt:number;resultCommit:string}};
      expect(certificateBody.producer).toMatchObject({taskId:tasks[0]?.id,attempt:tasks[0]?.attempt,resultCommit:tasks[0]?.resultCommit});
      const certifiedDecision = decisions.find(event => ((event.payload.nativeSources as {certificates:unknown[]}).certificates).length > 0);
      expect(certifiedDecision?.payload).toMatchObject({nativeSources:{certificates:[{id:focusedArtifact?.id,sha256:focusedArtifact?.sha256,...certificateBody.producer}]}});
      for(const acknowledgement of acknowledgements) {
        const decision = decisions.find(event => event.payload.recordHash === acknowledgement.payload.decisionRecordHash);
        expect(decision).toBeDefined();
        expect(acknowledgement.sequence).toBeGreaterThan(decision?.sequence ?? 0);
        expect(acknowledgement.payload).toMatchObject({action:"CONTINUE",acknowledged:true,details:{acknowledgementAvailable:true,receiptPersistAttempted:true}});
      }
      // invocationSource identifies a service route, not an authenticated human.
      // Acknowledgement and before/after readback do not establish causal effect.
      const provenanceArtifact = emitted.receipt.evidence.artifacts.find(artifact => artifact.class === "agentflow:governor-provenance");
      const provenanceSource = emitted.sources.find(source => source.relativePath === provenanceArtifact?.path);
      if(provenanceArtifact === undefined || provenanceSource === undefined) throw new Error("Native Governor provenance bytes missing");
      const provenanceBytes = await readFile(provenanceSource.sourcePath);
      expect(createHash("sha256").update(provenanceBytes).digest("hex")).toBe(provenanceArtifact.sha256);
      const provenance = JSON.parse(provenanceBytes.toString()) as {buildId:string;handoffSha256:string;sourceEventWatermark:number;events:typeof sourceEvents};
      expect(provenance).toMatchObject({kind:"agentflow/governor-provenance",buildId:sourceBuild,handoffSha256:emitted.receipt.handoff.sha256,sourceEventWatermark:emitted.sourceEventWatermark});
      expect(provenance.events).toEqual(sourceEvents.filter(event => event.type.startsWith("governor.")));
      // Existing export validation authenticates these retained bytes. It does
      // not independently certify every nativeSources semantic claim.
      const substituted = structuredClone(provenance);
      const substitutedDecision = substituted.events.find(event => event.type === "governor.decision");
      if(substitutedDecision === undefined) throw new Error("Missing substitution subject");
      ((substitutedDecision.payload.nativeSources as {build:{planId:string}}).build).planId = "plan_substituted";
      try {
        await writeFile(provenanceSource.sourcePath,JSON.stringify(substituted));
        await expect(makeDesignIntelligenceReceipt(context,sourceBuild)).rejects.toMatchObject({code:"RECEIPT_EVIDENCE_CHANGED"});
        await writeFile(path.join(control,"provenance-substitution-refusal.json"),JSON.stringify({classification:"RETAINED_BYTE_SUBSTITUTION_REFUSED_NOT_SEMANTIC_ATTESTATION",originalSha256:provenanceArtifact.sha256,substitutedSha256:createHash("sha256").update(JSON.stringify(substituted)).digest("hex"),code:"RECEIPT_EVIDENCE_CHANGED"},null,2));
      } finally { await writeFile(provenanceSource.sourcePath,provenanceBytes); }
      expect((await makeDesignIntelligenceReceipt(context,sourceBuild)).receipt).toEqual(emitted.receipt);

      expect(emitted.receipt).toMatchObject({schemaVersion:"1.1.0",build:{status:"completed",baseCommit:b1,governedBaseCommit:fixture.b0}});
      await writeFile(fixture.receiptPath,JSON.stringify(emitted.receipt));
      await writeFile(path.join(control,"source-receipt.json"),JSON.stringify(emitted.receipt));
      await writeFile(path.join(control,"source-native-completed-records.json"),JSON.stringify({build:context.store.builds.getById(sourceBuild),tasks,validations:context.store.validations.listForBuild(sourceBuild),events:context.store.events.listForBuild(sourceBuild,{limit:10000}),artifacts:context.store.artifacts.listForBuild(sourceBuild)},null,2));
      const sourceEvidence=path.join(control,"source-evidence");await mkdir(sourceEvidence);
      for(const source of emitted.sources){const target=path.join(sourceEvidence,source.relativePath);await mkdir(path.dirname(target),{recursive:true});await copyFile(source.sourcePath,target);}

      for(const source of emitted.sources){const target=path.join(fixture.evidenceRoot,source.relativePath);await mkdir(path.dirname(target),{recursive:true});await copyFile(source.sourcePath,target);}
      const auditScript="import json,sys;from design_intelligence.agentflow_contracts import audit_agentflow_build_receipt,audit_governed_handoff_repository;result=audit_agentflow_build_receipt(sys.argv[1],handoff_path=sys.argv[2],evidence_root=sys.argv[4]);result['currentAdmission']=audit_governed_handoff_repository(json.load(open(sys.argv[2])),sys.argv[3]);print(json.dumps(result))";
      const audit=await execute("python3",["-c",auditScript,fixture.receiptPath,fixture.handoffPath,fixture.consumerRoot,fixture.evidenceRoot],{cwd:nativeRoot,env:{...process.env,PYTHONDONTWRITEBYTECODE:"1"}});
      await writeFile(path.join(control,"source-proofloom-audit.json"),audit.stdout);expect(JSON.parse(audit.stdout)).toMatchObject({status:"PASS",executionComplete:true,currentAdmission:{currencyVerified:true}});
      expect(await git("status","--porcelain")).toBe("");
      await publishSourceReady(path.join(control,"source-ready.json"),JSON.stringify({url:address,token}));
      const browser=await until(()=>{if(host.exitCode!==null)throw new Error(`Native/Orbit fixture host exited: ${hostLog}`);return jsonFile<{nativeUrl:string;orbitUrl:string}>(path.join(control,"browser-ready.json"));},"frozen native and Orbit HTTP hosts");
      const cookies=new Map<string,string>();let csrf="";
      const nativeHttp=async(route:string,payload?:unknown)=>{
        const response=await fetch(browser.orbitUrl+route,{method:payload===undefined?"GET":"POST",headers:{"content-type":"application/json",Origin:browser.orbitUrl,Cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join("; "),...(csrf?{"X-Wale-CSRF-Token":csrf}:{})},...(payload===undefined?{}:{body:JSON.stringify(payload)})});
        for(const field of response.headers.getSetCookie()){const item=field.split(";",1)[0]??"";const split=item.indexOf("=");if(split>0)cookies.set(item.slice(0,split),item.slice(split+1));}
        const next=response.headers.get("X-Wale-CSRF-Token");if(next)csrf=next;
        const text=await response.text();const body=text?JSON.parse(text) as Record<string,unknown>:{};
        await writeFile(path.join(control,"proofloom-http.jsonl"),JSON.stringify({route,status:response.status,body})+"\n",{flag:"a"});return {status:response.status,body};
      };
      const orbitBootstrap=await nativeHttp("/api/orbit/bootstrap");expect(orbitBootstrap.status).toBe(200);csrf=String(orbitBootstrap.body.csrfToken);const connected=await nativeHttp("/api/orbit/connect",{pin:"2468"});expect(connected.status,JSON.stringify(connected.body)).toBe(200);expect((await nativeHttp("/api/run-lab")).status).toBe(200);
      expect((await nativeHttp("/api/run-lab/experiments",{parameters:{deliverySize:0}})).status).toBe(400);
      const mainPrepared=await nativeHttp("/api/run-lab/experiments",{parameters:{deliverySize:1000,humanInterruptionBudget:1,strategy:"NORMAL_EXECUTION",verificationProfile:"design-standard"}});
      expect(mainPrepared.status,JSON.stringify(mainPrepared.body)).toBe(200);const mainExperiment=String(mainPrepared.body.experimentId);
      expect(mainPrepared.body).toMatchObject({executionAvailability:{available:true},candidateApplication:{authorized:false}});
      expect(context.store.events.findByExperimentId(mainExperiment)).toBeUndefined();
      const consumerAuthority=path.join(fixture.consumerRoot,"AGENTS.md");const consumerAuthorityBytes=await readFile(consumerAuthority);
      try{await writeFile(consumerAuthority,Buffer.concat([consumerAuthorityBytes,Buffer.from("\ncurrent snapshot drift\n")]));const dirty=await nativeHttp(`/api/run-lab/experiments/${mainExperiment}/start`,{});expect(dirty.status).toBe(409);expect(context.store.events.findByExperimentId(mainExperiment)).toBeUndefined();}finally{await writeFile(consumerAuthority,consumerAuthorityBytes);}
      await writeFile(path.join(control,"provider-mode.json"),JSON.stringify({mode:"hold"}));
      const starts=await Promise.all([nativeHttp(`/api/run-lab/experiments/${mainExperiment}/start`,{}),nativeHttp(`/api/run-lab/experiments/${mainExperiment}/start`,{})]);
      expect(starts.every(result=>result.status===200),JSON.stringify(starts)).toBe(true);
      const bound=await until(async()=>context.store.events.findByExperimentId(mainExperiment),"native main experiment binding");const mainBuild=bound.buildId;
      await until(async()=>context.store.tasks.listForBuild(mainBuild).some(task=>task.state==="running")?true:undefined,"native main worker running");
      expect(context.store.builds.getById(mainBuild).baseCommit).toBe(b1);
      const replay=await http("/api/wale/run-lab/experiments",{sourceBuildId:sourceBuild,experiment:bound.payload},true);expect(replay.status).toBe(200);expect(replay.body).toMatchObject({bridgeBuildReference:mainBuild});
      const conflict=await http("/api/wale/run-lab/experiments",{sourceBuildId:sourceBuild,experiment:{...bound.payload,runId:"run_substituted"}},true);expect(conflict.status).toBe(409);
      expect(context.store.builds.list({limit:100})).toHaveLength(2);
      const mainGovernor=await http(`/api/builds/${mainBuild}/governor/evaluate`,{});expect(mainGovernor.status).toBe(200);expect(mainGovernor.body.acknowledgement).toMatchObject({acknowledged:true});
      await writeFile(path.join(control,"provider-mode.json"),JSON.stringify({mode:"complete"}));
      await until(async()=>{const build=context.store.builds.getById(mainBuild);if(build.status==="paused"){await writeFile(path.join(control,"main-native-paused-records.json"),JSON.stringify({build,tasks:context.store.tasks.listForBuild(mainBuild),validations:context.store.validations.listForBuild(mainBuild),events:context.store.events.listForBuild(mainBuild,{limit:10000})},null,2));throw new Error("Native main experiment paused at genuine gate");}return ["completed","failed","cancelled"].includes(build.status)?build:undefined;},"native main experiment terminal");
      expect(context.store.builds.getById(mainBuild).status).toBe("completed");
      await writeFile(path.join(control,"main-native-completed-records.json"),JSON.stringify({build:context.store.builds.getById(mainBuild),tasks:context.store.tasks.listForBuild(mainBuild),validations:context.store.validations.listForBuild(mainBuild),events:context.store.events.listForBuild(mainBuild,{limit:10000}),artifacts:context.store.artifacts.listForBuild(mainBuild)},null,2));

      expect((await readFile(sentinel,"utf8")).trim().split("\n")).toHaveLength(2); // source plus exactly one main attempt, despite duplicate Starts
      const bundleResponse=await http(`/api/wale/run-lab/experiments/${mainExperiment}/receipt`,undefined,true);expect(bundleResponse.status).toBe(200);
      await writeFile(path.join(control,"main-bundle.json"),JSON.stringify(bundleResponse.body));
      const bundle=bundleResponse.body as unknown as {receipt:unknown;receiptSha256:string;evidence:Array<{index:number;path:string;sha256:string;bytes:number}>};
      expect(bundle.receiptSha256).toBe(canonicalJsonSha256(bundle.receipt));expect(Object.hasOwn(bundle,"eventWatermark")).toBe(false);const currentWatermark=context.store.events.getLatestSequence(mainBuild);const watermarkStatus=await http(`/api/wale/run-lab/experiments/${mainExperiment}`,undefined,true);expect(watermarkStatus.status).toBe(200);expect(watermarkStatus.body.lastEventSequence).toBe(currentWatermark);
      const mainEvidence=path.join(control,"main-evidence");await mkdir(mainEvidence);const mainReceiptPath=path.join(mainEvidence,"receipt.json");await writeFile(mainReceiptPath,JSON.stringify(bundle.receipt));
      for(const evidence of bundle.evidence){const response=await fetch(`${address}/api/wale/run-lab/experiments/${mainExperiment}/evidence/${evidence.index}`,{headers:{authorization:`Bearer ${token}`}});expect(response.status).toBe(200);const bytes=Buffer.from(await response.arrayBuffer());expect(bytes.length).toBe(evidence.bytes);expect(createHash("sha256").update(bytes).digest("hex")).toBe(evidence.sha256);const target=path.join(mainEvidence,evidence.path);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,bytes);}
      const mainAudit=await execute("python3",["-c",auditScript,mainReceiptPath,fixture.handoffPath,fixture.consumerRoot,mainEvidence],{cwd:nativeRoot,env:{...process.env,PYTHONDONTWRITEBYTECODE:"1"}});await writeFile(path.join(control,"main-proofloom-audit.json"),mainAudit.stdout);expect(JSON.parse(mainAudit.stdout)).toMatchObject({status:"PASS",executionComplete:true,currentAdmission:{currencyVerified:true}});
      const retainedEvidence=bundle.evidence[0];if(retainedEvidence===undefined)throw new Error("Native main receipt has no evidence");const tamperPath=path.join(mainEvidence,retainedEvidence.path);const retainedBytes=await readFile(tamperPath);try{await writeFile(tamperPath,"tampered retained bytes");const rejected=await execute("python3",["-c",auditScript,mainReceiptPath,fixture.handoffPath,fixture.consumerRoot,mainEvidence],{cwd:nativeRoot,env:{...process.env,PYTHONDONTWRITEBYTECODE:"1"}});expect(JSON.parse(rejected.stdout)).toMatchObject({status:"FAIL",executionComplete:false});await writeFile(path.join(control,"tampered-proofloom-audit.json"),rejected.stdout);}finally{await writeFile(tamperPath,retainedBytes);}
      await writeFile(path.join(control,"main-native-records.json"),JSON.stringify({build:context.store.builds.getById(mainBuild),tasks:context.store.tasks.listForBuild(mainBuild),validations:context.store.validations.listForBuild(mainBuild),events:context.store.events.listForBuild(mainBuild,{limit:10000}),currentWatermark,bundle},null,2));
      const observed=await until(async()=>{const result=await nativeHttp(`/api/run-lab/experiments/${mainExperiment}`);return (result.body.observation as Record<string,unknown>|undefined)?.auditState==="PASS"?result:undefined;},"actual native Proofloom main receipt audit");
      expect(observed.body).toMatchObject({status:"completed",observation:{auditState:"PASS",ownerAcceptance:"NOT_RECORDED"}});
      const overflowCookies=new Map<string,string>();let overflowCsrf="";
      const overflowHttp=async(route:string,payload?:unknown)=>{
        const response=await fetch(browser.nativeUrl+route,{method:payload===undefined?"GET":"POST",headers:{"content-type":"application/json",Origin:browser.nativeUrl,Cookie:[...overflowCookies].map(([k,v])=>`${k}=${v}`).join("; "),...(overflowCsrf?{"X-Wale-CSRF-Token":overflowCsrf}:{})},...(payload===undefined?{}:{body:JSON.stringify(payload)})});
        for(const field of response.headers.getSetCookie()){const item=field.split(";",1)[0]??"";const split=item.indexOf("=");if(split>0)overflowCookies.set(item.slice(0,split),item.slice(split+1));}
        const next=response.headers.get("X-Wale-CSRF-Token");if(next)overflowCsrf=next;const text=await response.text();const body=text?JSON.parse(text) as Record<string,unknown>:{};
        await writeFile(path.join(control,"overflow-proofloom-http.jsonl"),JSON.stringify({route,status:response.status,body})+"\n",{flag:"a"});return {status:response.status,body};
      };
      expect((await overflowHttp("/api/access",{pin:"2468"})).status).toBe(204);expect((await overflowHttp("/api/bootstrap")).status).toBe(200);expect((await overflowHttp("/api/run-lab")).status).toBe(200);
      await writeFile(path.join(control,"provider-mode.json"),JSON.stringify({mode:"overflow"}));
      const overflowPrepared=await overflowHttp("/api/run-lab/experiments",{parameters:{deliverySize:1,humanInterruptionBudget:1,strategy:"NORMAL_EXECUTION",verificationProfile:"design-standard"}});expect(overflowPrepared.status).toBe(200);const overflowExperiment=String(overflowPrepared.body.experimentId);expect(overflowExperiment).not.toBe(mainExperiment);
      const overflowStart=await overflowHttp(`/api/run-lab/experiments/${overflowExperiment}/start`,{});expect(overflowStart.status,JSON.stringify(overflowStart.body)).toBe(200);
      const overflowBinding=await until(async()=>context.store.events.findByExperimentId(overflowExperiment),"overflow native binding");const overflowBuild=overflowBinding.buildId;
      await until(async()=>{const build=context.store.builds.getById(overflowBuild);return ["completed","failed","cancelled","paused"].includes(build.status)?build:undefined;},"native overflow refusal");
      const overflowEvents=context.store.events.listForBuild(overflowBuild,{limit:10000});
      const overflowMetric=overflowEvents.find(event=>event.type==="wale.delivery_size_evaluated");expect(overflowMetric?.payload).toMatchObject({accepted:false,ceiling:1,incrementalTextChurn:33,cumulativeTextChurn:33,metric:"CUMULATIVE_ALL_TEXT_CHURN_PROXY",eligibleSourceLoc:null,profileExecution:"UNKNOWN",checkExecution:"UNKNOWN"});
      const overflowTasks=context.store.tasks.listForBuild(overflowBuild);expect(overflowTasks.some(task=>task.state==="integrated")).toBe(false);expect(overflowTasks.some(task=>task.errorCode==="WALE_DELIVERY_SIZE_EXCEEDED")).toBe(true);
      await writeFile(path.join(control,"overflow-native-records.json"),JSON.stringify({build:context.store.builds.getById(overflowBuild),tasks:overflowTasks,validations:context.store.validations.listForBuild(overflowBuild),events:overflowEvents},null,2));
      if(context.store.builds.getById(overflowBuild).status==="paused"){const cancelled=await http(`/api/builds/${overflowBuild}/cancel`,{});expect(cancelled.status).toBe(200);}
      expect(context.store.builds.listActive()).toHaveLength(0);
      // The I/O double reports completion but emits invalid output. The unchanged
      // declared native check must refuse it before integration/certification.
      await writeFile(path.join(control,"provider-mode.json"),JSON.stringify({mode:"invalid-check"}));
      const failedCheckPrepared=await overflowHttp("/api/run-lab/experiments",{parameters:{deliverySize:999,humanInterruptionBudget:1,strategy:"NORMAL_EXECUTION",verificationProfile:"design-standard"}});expect(failedCheckPrepared.status).toBe(200);const failedCheckExperiment=String(failedCheckPrepared.body.experimentId);
      const failedCheckStart=await overflowHttp(`/api/run-lab/experiments/${failedCheckExperiment}/start`,{});expect(failedCheckStart.status,JSON.stringify(failedCheckStart.body)).toBe(200);
      const failedCheckBinding=await until(async()=>context.store.events.findByExperimentId(failedCheckExperiment),"failed-check native binding");const failedCheckBuild=failedCheckBinding.buildId;
      await until(async()=>{const build=context.store.builds.getById(failedCheckBuild);return ["failed","cancelled","paused"].includes(build.status)?build:undefined;},"actual declared native check refusal");
      const failedCheckTasks=context.store.tasks.listForBuild(failedCheckBuild);const failedCheckValidations=context.store.validations.listForBuild(failedCheckBuild);const failedCheckEvents=context.store.events.listForBuild(failedCheckBuild,{limit:10000});
      expect(failedCheckValidations.some(item=>item.validationType==="task"&&item.status==="failed"&&item.exitCode!==0)).toBe(true);expect(failedCheckTasks.some(task=>task.state==="integrated")).toBe(false);expect(failedCheckEvents.some(event=>event.type==="integration.completed"||event.type==="evidence.native_validation_certified")).toBe(false);
      await writeFile(path.join(control,"failed-check-native-records.json"),JSON.stringify({build:context.store.builds.getById(failedCheckBuild),tasks:failedCheckTasks,validations:failedCheckValidations,events:failedCheckEvents},null,2));
      if(context.store.builds.getById(failedCheckBuild).status==="paused"){expect((await http(`/api/builds/${failedCheckBuild}/cancel`,{})).status).toBe(200);}
      expect(context.store.builds.listActive()).toHaveLength(0);
      await writeFile(path.join(control,"provider-mode.json"),JSON.stringify({mode:"complete"}));
      const restored=await nativeHttp("/api/run-lab/experiments",{parameters:{deliverySize:1000,humanInterruptionBudget:1,strategy:"NORMAL_EXECUTION",verificationProfile:"design-standard"}});expect(restored.status).toBe(200);expect(restored.body.experimentId).toBe(mainExperiment);const restoredCurrent=await nativeHttp("/api/run-lab/experiments/current");expect(restoredCurrent.status).toBe(200);expect(restoredCurrent.body).toMatchObject({prepared:{experimentId:mainExperiment},observation:{auditState:"PASS",lastKnown:{status:"completed"}}});
      await writeFile(path.join(output,"active-fixture.json"),JSON.stringify({control,...browser,orbitBase:browser.orbitUrl,agentflowUrl:address,sourceBuild,mainBuild,mainExperiment,overflowBuild,overflowExperiment,b0:fixture.b0,b1,fixtureProvider:provider,claimBoundary:"Temporary native fixture; explicit worker I/O double; zero real provider executable calls"},null,2));
      // Actual service close/recreation uses the same SQLite runtime and native recovery.
      let transportUp=true;let lastControl="";
      if(process.env.AFI003_BROWSER_HOLD === "1") await until(async()=>{
        const command=await jsonFile<{requestId:string;action:"stop"|"restart"}>(path.join(control,"transport-control.json"));
        if(command&&command.requestId!==lastControl){lastControl=command.requestId;if(transportUp){await app.close();transportUp=false;built=undefined;}if(command.action==="restart"){built=await buildApp({environment,staticRoot:false,logger:false});app=built.app;context=built.context;await app.listen({host:"127.0.0.1",port:Number(new URL(address).port)});transportUp=true;}await writeFile(path.join(control,"transport-ack.json"),JSON.stringify({requestId:command.requestId,action:command.action,transport:transportUp?"up":"down"}));}
        try{await access(path.join(control,"browser-done"));return true;}catch{return undefined;}
      },"external frozen Orbit browser qualification",1_800_000);
      const lines=(await readFile(sentinel,"utf8")).trim().split("\n").map(line=>JSON.parse(line) as {executable:string;cwd:string});
      expect(lines.length).toBeGreaterThanOrEqual(1);expect(lines.every(row=>row.executable===provider&&row.cwd.startsWith(environment.worktreesPath))).toBe(true);
      expect(GovernedTaskHandoffSchema.safeParse({...(JSON.parse(await readFile(fixture.handoffPath,"utf8")) as Record<string, unknown>),taskValidationRuntime:{enabled:true}}).success).toBe(false);
      await writeFile(path.join(control,"qualification.json"),JSON.stringify({sourceBuild,b0:fixture.b0,b1,sourceReceiptSha256:canonicalJsonSha256(emitted.receipt),fixtureProviderCalls:lines.length,realProviderExecutableCalls:0,sourceAudit:JSON.parse(audit.stdout) as unknown,mainBuild,mainExperiment,overflowBuild,overflowExperiment,mainAudit:JSON.parse(mainAudit.stdout) as unknown},null,2));
    } finally {
      restoreDecisionCapture();
      await writeFile(path.join(control,"stop"),"");
      if(built) await built.app.close();
      await Promise.race([new Promise<void>(resolve=>host.once("exit",()=>resolve())),pause(3000)]);if(host.exitCode===null)host.kill("SIGTERM");
      await writeFile(path.join(control,"fixture-host.log"),hostLog);
    }
  }, 1_900_000);
});

describe("AFI-003 capability receipt audit", () => {
  it.skipIf(process.env.AFI003_CAPABILITY_EXPORT === undefined)("independently audits actual native record-derived export and refuses tampered plan bytes", async () => {
    // Explicit descriptor from the real native-producer fixture. It carries no
    // caller observation PASS and is never an execution approval or provider claim.
    const descriptor=required("AFI003_CAPABILITY_EXPORT");const nativeRoot=required("AFI003_NATIVE_ROOT");
    const input=await jsonFile<{classification:string;receipt:unknown;handoff:unknown;binding:unknown;evidenceRoot:string}>(descriptor);if(input===undefined)throw new Error("Missing explicit native capability fixture");
    expect(input.classification).toBe("ACTUAL_NATIVE_PRODUCER_UNIT_FIXTURE_NOT_HTTP_OR_PROVIDER");
    const audit=async()=>{const result=await execute("python3",["-B","-c","import json,sys;from design_intelligence.agentflow_contracts import audit_capability_plan_receipt;d=json.load(open(sys.argv[1]));print(json.dumps(audit_capability_plan_receipt(d['binding'],d['receipt'],handoff=d['handoff'],evidence_root=d['evidenceRoot'])))",descriptor],{cwd:nativeRoot,env:{...process.env,PYTHONDONTWRITEBYTECODE:"1"}});return JSON.parse(result.stdout) as {status:string;capabilityVerified:boolean};};
    expect(await audit()).toMatchObject({status:"PASS",capabilityVerified:true});
    const receipt=input.receipt as {evidence:{artifacts:Array<{class:string;path:string}>}};const plan=receipt.evidence.artifacts.find(item=>item.class==="capability-plan");if(plan===undefined)throw new Error("Actual export is missing plan");
    const planPath=path.join(input.evidenceRoot,plan.path);const bytes=await readFile(planPath);
    try{await writeFile(planPath,"tampered");expect(await audit()).toMatchObject({status:"FAIL",capabilityVerified:false});}finally{await writeFile(planPath,bytes);}
  });
});
