import Fastify from "fastify";
import { createHash } from "node:crypto";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyWaleReceiptEvidence } from "../src/integration/wale-run-lab-receipt-bundle.js";
import { describe, expect, it } from "vitest";
import { createDatabaseRepositories, openDatabase } from "../src/db/index.js";
import { createDatabaseFixture } from "./helpers/database-fixture.js";
import { registerWaleRunLabRoutes } from "../src/http/routes/wale-run-lab.js";
import { resolveEnvironment } from "../src/config/environment.js";
import type { AgentFlowContext } from "../src/http/context.js";
import type { WaleRunLabExperiment } from "../src/integration/wale-run-lab.js";
const token = "afi003_bridge_fixture_" + "x".repeat(32);
const experimentId = `exp_${"a".repeat(64)}`;
const prefix = `/api/wale/run-lab/experiments/${experimentId}`;
const environment = resolveEnvironment({AGENTFLOW_WALE_BRIDGE_TOKEN_SHA256:createHash("sha256").update(token).digest("hex")});
const experiment: WaleRunLabExperiment = {
  experimentId,runId:"run_AFI003",repositorySnapshot:{state:"VERIFIED",commit:"b".repeat(40),tree:"c".repeat(64),reason:null},
  frozenTask:{state:"VERIFIED",ids:["sha256:"+"d".repeat(16)],titleFingerprints:["sha256:"+"e".repeat(16)]},
  frozenRequirements:{state:"UNKNOWN",items:[],reason:"FROZEN_REQUIREMENTS_NOT_RETAINED_SEPARATELY"},
  acceptanceCriteria:{state:"VERIFIED",count:1,items:[{id:"sha256:"+"f".repeat(16),fingerprint:"sha256:"+"1".repeat(16)}]},
  parameters:{deliverySize:100,overflowBehavior:"SPLIT_OR_REPLAN",humanInterruptionBudget:0,authorityEscalationRequired:true,strategy:"NORMAL_EXECUTION",verificationProfile:"design-standard",verificationProfileReference:"devctl-design-standard",requiredCheckBindings:[{id:"unit",retainedReference:"npm-test"}],requiredChecksCannotBeBypassed:true,agentModel:null},
  authorityStateReference:"authority-"+"2".repeat(24),strategy:"NORMAL_EXECUTION",executionResult:{status:"UNKNOWN",completionState:"UNKNOWN",reason:"EXPERIMENT_NOT_EXECUTED"},verificationEvidence:{state:"UNKNOWN",reason:"EXPERIMENT_NOT_EXECUTED"},comparisonEligibility:{state:"UNKNOWN",reason:"EXACT_CASE_COMPARISON_NOT_BOUND"},candidateApplication:{authorized:false,reason:"SEPARATE_AUTHORITY_BOUND_STEP_REQUIRED"},claimBoundary:"Result applies to this exact run.",
};

describe("Wale public HTTP boundary",()=>{
  it.each([undefined,"Bearer wrong","Bearer "+"z".repeat(43)])("rejects unauthorized malformed and oversized bodies before parsing (%s)",async authorization=>{
    const app=Fastify();registerWaleRunLabRoutes(app,{environment} as AgentFlowContext);
    try{
      for(const payload of ["{","x".repeat(1024*1024+1)]){
        const response=await app.inject({method:"POST",url:"/api/wale/run-lab/experiments",headers:{"content-type":"application/json",...(authorization?{authorization}:{})},payload});
        expect(response.statusCode).toBe(401);expect(response.json()).toMatchObject({error:{code:"WALE_BRIDGE_AUTHENTICATION_FAILED"}});expect(response.headers["cache-control"]).toBe("no-store");expect(response.body).not.toContain(token);expect(response.body).not.toContain(process.cwd());
      }
    }finally{await app.close();}
  });
  it("bounds authorized bodies and refuses private or unsupported request fields",async()=>{
    const app=Fastify();registerWaleRunLabRoutes(app,{environment} as AgentFlowContext);
    try{
      const headers={authorization:`Bearer ${token}`,"content-type":"application/json"};
      const large=await app.inject({method:"POST",url:"/api/wale/run-lab/experiments",headers,payload:JSON.stringify({padding:"x".repeat(1024*1024+1)})});expect(large.statusCode).toBe(413);
      for(const extra of [{taskValidationRuntime:{enabled:true}},{runtime:true},{privatePath:"/private/secret"}]){
        const response=await app.inject({method:"POST",url:"/api/wale/run-lab/experiments",headers,payload:{sourceBuildId:"source",experiment:{...experiment,...extra}}});expect(response.statusCode).toBe(400);expect(response.body).not.toContain("/private/secret");
      }
    }finally{await app.close();}
  });
  it("retains one native binding across duplicate, ambiguous and restarted Start observations",async()=>{
    const fixture=createDatabaseFixture();let app=Fastify();let dispatches=0;let database=fixture.database;
    try{
      let store=createDatabaseRepositories(database);
      store.repositories.create({id:"repo-fixture",name:"temporary fixture",localPath:fixture.directory,configPath:".agentflow.yaml",baseBranch:"main"});
      store.builds.create({id:"build-fixture",repositoryId:"repo-fixture",backlogPath:"BACKLOG.md",baseCommit:"b".repeat(40),integrationBranch:"integration/fixture",status:"ready"});
      store.events.appendExperimentBinding("build-fixture",experiment);
      const coordinator={start:async(id:string)=>{dispatches++;store.builds.transition(id,"running");store.events.append({buildId:id,type:"build.started",payload:{privateValue:"/not-public"}});throw new Error("Transport outcome ambiguous");}};
      registerWaleRunLabRoutes(app,{store,environment,coordinator} as unknown as AgentFlowContext);
      const request=(url=prefix+"/start",method:"GET"|"POST"="POST")=>app.inject({method,url,headers:{authorization:`Bearer ${token}`},...(method==="POST"?{payload:{}}:{})});
      expect((await request()).statusCode).toBe(409);expect(dispatches).toBe(1);
      expect((await request()).json()).toMatchObject({bridgeBuildReference:"build-fixture",status:"running"});expect(dispatches).toBe(1);
      expect((await request(prefix.replace(experimentId,`exp_${"9".repeat(64)}`)+"/start")).statusCode).toBe(404);expect(dispatches).toBe(1);
      const ineligible=await app.inject({method:"POST",url:"/api/wale/run-lab/experiments",headers:{authorization:`Bearer ${token}`},payload:{sourceBuildId:"unknown-source",experiment}});expect(ineligible.statusCode).toBe(409);expect(ineligible.json()).toMatchObject({error:{code:"WALE_BRIDGE_ADMISSION_REJECTED"}});
      const events=await request(prefix+"/events?limit=1","GET");expect(events.statusCode).toBe(200);expect(events.body).not.toContain("privateValue");expect(events.body).not.toContain("/not-public");
      const first=events.json<{events:Array<{sequence:number}>;cursor:number;hasMore:boolean}>();expect(first.events).toHaveLength(1);expect(first.hasMore).toBe(true);
      const next=(await request(prefix+`/events?after=${first.cursor}&limit=1`,"GET")).json<{events:Array<{sequence:number}>;cursor:number;hasMore:boolean}>();expect(next.events[0]?.sequence).toBeGreaterThan(first.cursor);expect(next.hasMore).toBe(false);
      expect((await request(prefix+"/events?after=-1","GET")).statusCode).toBe(400);
      expect((await request(prefix+"/receipt","GET")).statusCode).toBe(409);
      await app.close();database.close();database=openDatabase(fixture.databasePath);store=createDatabaseRepositories(database);app=Fastify();
      registerWaleRunLabRoutes(app,{store,environment,coordinator} as unknown as AgentFlowContext);
      expect((await request()).json()).toMatchObject({experimentId,bridgeBuildReference:"build-fixture",status:"running"});expect(dispatches).toBe(1);
      store.builds.transition("build-fixture","paused");expect((await request()).json()).toMatchObject({error:{code:"WALE_EXPERIMENT_REQUIRES_EXPLICIT_RESUME"}});expect(dispatches).toBe(1);
      expect(store.events.findByExperimentId(experimentId)?.buildId).toBe("build-fixture");
    }finally{await app.close();if(database.open)database.close();fixture.cleanup();}
  });
  it("refuses excessive evidence count and sparse oversized evidence before reading bytes",async()=>{
    const root=await mkdtemp(path.join(tmpdir(),"afi003-evidence-bound-"));
    try {
      const sourcePath=path.join(root,"oversized.json");
      await writeFile(sourcePath,"");const file=await open(sourcePath,"r+");try{await file.truncate(64*1024*1024+1);}finally{await file.close();}
      const source={sourcePath,relativePath:"artifacts/oversized.json",sha256:"a".repeat(64)};
      await expect(verifyWaleReceiptEvidence([source])).rejects.toThrow("Receipt evidence unavailable");
      await expect(verifyWaleReceiptEvidence(Array.from({length:257},(_,index)=>({...source,relativePath:`artifacts/${index}.json`})))).rejects.toThrow("Receipt evidence unavailable");
    }finally{await rm(root,{recursive:true,force:true});}
  });

});
