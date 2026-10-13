import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";

const databaseUrl=process.env.AIRA_TEST_DATABASE_URL;
if(databaseUrl) process.env.DATABASE_URL=databaseUrl;
const integration=databaseUrl?test:test.skip;
const {initializeDatabase,mutate,readState,pool,closeDatabase,acquireWorkerLock}=await import("../src/server/db.js");
const {initializeSecurity}=await import("../src/server/security.js");
const {enqueue}=await import("../src/server/state.js");
const {getRun,reservationCounts}=await import("../src/server/run-repository.js");
const {startWorker,stopWorker,workerActivity}=await import("../src/server/worker.js");
const {flushRunLogs}=await import("../src/server/run-logs.js");
const projectId=randomUUID();const userId=randomUUID();const stepId=randomUUID();
let unlock:(()=>Promise<void>)|undefined;
const wait=async(predicate:()=>boolean|Promise<boolean>)=>{const deadline=Date.now()+10_000;while(!await predicate()){assert(Date.now()<deadline,"worker boundary did not settle");await new Promise(resolve=>setTimeout(resolve,10));}};
before(async()=>{
  if(!databaseUrl)return;
  process.env.APP_SECRET="worker-boundary-tests-secret-at-least32";process.env.APP_URL="http://localhost";initializeSecurity();
  await initializeDatabase();unlock=await acquireWorkerLock();
  await mutate(state=>{
    state.users.push({id:userId,name:"Boundary fixture",email:`${userId}@example.test`,passwordHash:"unused",mustChangePassword:false});
    state.projects.push({id:projectId,name:"Boundary fixture",key:"BOUNDARY",description:"",repository:"test/repo",baseBranch:"main",model:"original-claim-model",modelProvider:"ollama",sandboxProvider:"docker",dockerImage:"fixture",e2bTemplate:"",roles:{[userId]:"admin"},githubConnected:false,githubIdentity:"",hasOllamaKey:false,hasClaudeKey:false,hasE2bKey:false,secrets:{githubToken:"",ollamaApiKey:"",claudeApiKey:"",e2bApiKey:""},steps:[{id:stepId,name:"Define",kind:"definition",filename:"definition.md",instructions:"",model:"",requiredApprovals:0,approverIds:[],includePriorArtifacts:false}]});
  });
});
after(async()=>{
  if(databaseUrl){
    await stopWorker(0);await flushRunLogs();
    await pool.query("DELETE FROM aira_runs WHERE project_id=$1",[projectId]);
    await pool.query("DELETE FROM aira_project_agent_settings WHERE project_id=$1",[projectId]);
    await mutate(state=>{
      const ticketIds=new Set(state.tickets.filter(ticket=>ticket.projectId===projectId).map(ticket=>ticket.id));
      state.projects=state.projects.filter(project=>project.id!==projectId);state.users=state.users.filter(user=>user.id!==userId);
      state.tickets=state.tickets.filter(ticket=>!ticketIds.has(ticket.id));state.artifacts=state.artifacts.filter(artifact=>!ticketIds.has(artifact.ticketId));state.audit=state.audit.filter(event=>event.projectId!==projectId);
    });
    await unlock?.();
  }
  await closeDatabase();
});
async function queue(kind: "definition" | "implement" = "definition"){
  return mutate(async(state,client)=>{
    const project=state.projects.find(project=>project.id===projectId)!;
    let step=project.steps.find(step=>step.kind===kind);
    if(!step){step={...project.steps[0],id:randomUUID(),kind,name:"Implement"};project.steps.push(step);}
    const timestamp=new Date().toISOString();const ticket={id:randomUUID(),projectId,number:"BOUNDARY-1",title:"Boundary",description:"",attachments:[],workflowSnapshot:null,priority:"medium" as const,status:"active" as const,stepId:step.id,sprintId:null,createdBy:userId,createdAt:timestamp,updatedAt:timestamp,closedAt:null,pullRequests:[]};
    state.tickets.push(ticket);return enqueue(state,ticket,step,userId,null,client);
  });
}
integration("lost claim acknowledgement recovers one dispatch with its original settings snapshot",async()=>{
  const run=await queue();let executions=0;let claimedModel="";let lost=false;let unavailable=true;
  let resolveLost!:()=>void;const lostAcknowledgement=new Promise<void>(resolve=>{resolveLost=resolve;});
  const clients=new WeakSet<object>();const originalClientQuery=pg.Client.prototype.query;const originalPoolQuery=pool.query.bind(pool);
  (pg.Client.prototype as any).query=function(...args:any[]){
    const result=(originalClientQuery as any).apply(this,args);
    if(String(args[0]).startsWith("UPDATE aira_runs AS r SET status='running'")&&args[1]?.[0]===run.id)clients.add(this);
    if(!lost&&args[0]==="COMMIT"&&clients.has(this))return result.then(()=>{lost=true;resolveLost();throw new Error("Lost committed claim acknowledgement");});
    return result;
  };
  (pool as any).query=async(...args:any[])=>{
    if(unavailable&&String(args[0]).startsWith("SELECT id,status,phase,project_id,provider")){unavailable=false;throw new Error("Claim recovery read temporarily unavailable");}
    return (originalPoolQuery as any)(...args);
  };
  try{
    startWorker({pollMs:25,execute:async context=>{executions++;claimedModel=context.project.model;return{reply:"Recovered claim",artifact:"Recovered definition"};}});
    await lostAcknowledgement;
    await mutate(state=>{state.projects.find(project=>project.id===projectId)!.model="changed-after-claim";});
    await wait(async()=>Boolean((await getRun(run.id))?.logSealed));
    assert.equal(lost,true);assert.equal(unavailable,false);assert.equal(executions,1);assert.equal(claimedModel,"original-claim-model");
    assert.equal((await getRun(run.id))!.status,"completed");assert.equal((await reservationCounts()).get(projectId),undefined);
    assert.equal((await readState()).projects.find(project=>project.id===projectId)!.model,"changed-after-claim");
  }finally{(pg.Client.prototype as any).query=originalClientQuery;(pool as any).query=originalPoolQuery;await stopWorker(0);}
});
integration("a failed seal rolls back capacity release, then terminal seal and release commit together",async()=>{
  const run=await queue();let failed=false;let resolveFailure!:()=>void;
  const sealFailure=new Promise<void>(resolve=>{resolveFailure=resolve;});
  const originalClientQuery=pg.Client.prototype.query;
  (pg.Client.prototype as any).query=function(...args:any[]){
    const result=(originalClientQuery as any).apply(this,args);
    if(!failed&&String(args[0]).startsWith("UPDATE aira_run_logs SET sealed=true")&&args[1]?.[0]===run.id)return result.then(()=>{failed=true;resolveFailure();throw new Error("Failure at durable seal boundary");});
    return result;
  };
  try{
    startWorker({pollMs:25,execute:async()=>({reply:"Completed",artifact:"Atomic terminal definition"})});
    await sealFailure;
    // Wait until rollback completes; no unreserved/unsealed terminal state may be visible.
    await wait(async()=>Boolean((await getRun(run.id))?.status==="completed"));
    const unsettled=await getRun(run.id);assert.equal(unsettled!.logSealed,false);assert.equal((await reservationCounts()).get(projectId),1);
    await wait(async()=>Boolean((await getRun(run.id))?.logSealed));
    assert.equal((await reservationCounts()).get(projectId),undefined);assert.equal((await getRun(run.id))!.cleanupStatus,"complete");
  }finally{(pg.Client.prototype as any).query=originalClientQuery;await stopWorker(0);}
});
integration("shutdown during a committed claim prevents dispatch and settles the cancelled reservation",async()=>{
  const run=await queue();let executions=0;let resolveCommit!:()=>void;let releaseCommit!:()=>void;
  const committed=new Promise<void>(resolve=>{resolveCommit=resolve;});const release=new Promise<void>(resolve=>{releaseCommit=resolve;});
  const clients=new WeakSet<object>();const originalClientQuery=pg.Client.prototype.query;let held=false;
  (pg.Client.prototype as any).query=function(...args:any[]){
    const result=(originalClientQuery as any).apply(this,args);
    if(String(args[0]).startsWith("UPDATE aira_runs AS r SET status='running'")&&args[1]?.[0]===run.id)clients.add(this);
    if(!held&&args[0]==="COMMIT"&&clients.has(this))return result.then(async(value:any)=>{held=true;resolveCommit();await release;return value;});
    return result;
  };
  try{
    startWorker({pollMs:25,execute:async()=>{executions++;return{reply:"Should not execute",artifact:"Unexpected"};}});
    await committed;const stopping=stopWorker(0);releaseCommit();await stopping;
    assert.equal(executions,0);assert.equal(workerActivity().length,0);
    const cancelled=(await getRun(run.id))!;assert.equal(cancelled.status,"failed");assert.equal(cancelled.logSealed,true);assert.equal(cancelled.cleanupStatus,"complete");
    assert.equal((await reservationCounts()).get(projectId),undefined);
  }finally{releaseCommit();(pg.Client.prototype as any).query=originalClientQuery;await stopWorker(0);}
});

integration("claim recovery waits for an unresolved original commit before deciding dispatch",async()=>{
  const run=await queue();let executions=0;let recoveryStarted=false;let committed=false;let injected=false;
  let heldClient:any;let originalRelease:((...args:any[])=>void)|undefined;
  const clients=new WeakSet<object>();const originalClientQuery=pg.Client.prototype.query;const originalPoolQuery=pool.query.bind(pool);
  let finishOriginalCommit:Promise<void>|undefined;
  const commitOriginal=()=>finishOriginalCommit??=(async()=>{
    assert.equal(executions,0);
    await (originalClientQuery as any).call(heldClient,"COMMIT");committed=true;
    heldClient.release=originalRelease;originalRelease?.();
  })();
  (pg.Client.prototype as any).query=function(...args:any[]){
    if(String(args[0]).startsWith("UPDATE aira_runs AS r SET status='running'")&&args[1]?.[0]===run.id)clients.add(this);
    if(!injected&&args[0]==="COMMIT"&&clients.has(this)){
      injected=true;heldClient=this;originalRelease=(this as any).release;(this as any).release=()=>{};
      return Promise.reject(new Error("Connection acknowledgement lost while original commit is unresolved"));
    }
    if(this===heldClient&&!committed&&args[0]==="ROLLBACK")return Promise.resolve({rows:[],rowCount:0});
    return (originalClientQuery as any).apply(this,args);
  };
  (pool as any).query=(...args:any[])=>{
    if(String(args[0]).startsWith("SELECT id,status,phase,project_id,provider")){
      recoveryStarted=true;assert.match(String(args[0]),/FOR UPDATE/);
      // The row lock must keep the read waiting until the server resolves the
      // original transaction, rather than observing its old pending version.
      setTimeout(()=>{void commitOriginal();},25);
    }
    return (originalPoolQuery as any)(...args);
  };
  try{
    startWorker({pollMs:25,execute:async()=>{executions++;assert.equal(committed,true);return{reply:"Resolved claim",artifact:"No duplicate dispatch"};}});
    await wait(async()=>Boolean((await getRun(run.id))?.logSealed));
    assert.equal(injected,true);assert.equal(recoveryStarted,true);assert.equal(executions,1);
    assert.equal((await getRun(run.id))!.status,"completed");
  }finally{
    if(heldClient&&!committed)await commitOriginal();
    if(finishOriginalCommit)await finishOriginalCommit;
    (pg.Client.prototype as any).query=originalClientQuery;(pool as any).query=originalPoolQuery;await stopWorker(0);
  }
});

for(const kind of ["definition","implement"] as const) integration(`cache hydration waits for unresolved ${kind} outcome and includes its operational result`,async()=>{
  const run=await queue(kind);let executions=0;let committed=false;let injected=false;let hydrationStarted=false;let hydrated=false;
  let heldClient:any;let originalRelease:((...args:any[])=>void)|undefined;let commitPromise:Promise<void>|undefined;
  let resolveLost!:()=>void;const lost=new Promise<void>(resolve=>{resolveLost=resolve;});
  const clients=new WeakSet<object>();const originalClientQuery=pg.Client.prototype.query;
  const commitOriginal=()=>commitPromise??=(async()=>{
    assert.equal(hydrated,false,"cache hydrated before the original transaction settled");
    await (originalClientQuery as any).call(heldClient,"COMMIT");committed=true;
    heldClient.release=originalRelease;originalRelease?.();
  })();
  (pg.Client.prototype as any).query=function(...args:any[]){
    if(String(args[0]).startsWith("UPDATE aira_runs SET status=$2")&&args[1]?.[0]===run.id&&args[1]?.[1]==="completed")clients.add(this);
    if(!injected&&args[0]==="COMMIT"&&clients.has(this)){
      injected=true;heldClient=this;originalRelease=(this as any).release;(this as any).release=()=>{};
      return Promise.reject(new Error("Original outcome commit acknowledgement lost"));
    }
    if(this===heldClient&&!committed&&args[0]==="ROLLBACK"){resolveLost();return Promise.resolve({rows:[],rowCount:0});}
    if(injected&&!committed&&String(args[0]).startsWith("SELECT jsonb_build_object")){
      hydrationStarted=true;assert.match(String(args[0]),/FOR UPDATE/);
      setTimeout(()=>{void commitOriginal();},25);
    }
    return (originalClientQuery as any).apply(this,args);
  };
  try{
    startWorker({pollMs:25,execute:async()=>{executions++;return kind==="definition"?{reply:"Definition persisted",artifact:"Committed after uncertainty"}:{reply:"PR published",prNumber:321,prUrl:"https://github.com/test/repo/pull/321"};}});
    await lost;
    const snapshot=await readState();hydrated=true;
    assert.equal(hydrationStarted,true);assert.equal(committed,true);
    assert.equal(snapshot.audit.filter(event=>event.ticketId===run.ticketId&&event.action==="run.completed").length,1);
    if(kind==="definition")assert.equal(snapshot.artifacts.find(artifact=>artifact.ticketId===run.ticketId)!.content,"Committed after uncertainty");
    else{
      assert.equal(snapshot.tickets.find(ticket=>ticket.id===run.ticketId)!.pullRequests.filter(pr=>pr.runId===run.id).length,1);
      assert.equal(snapshot.audit.filter(event=>event.ticketId===run.ticketId&&event.action==="pull_request.created").length,1);
    }
    await wait(async()=>Boolean((await getRun(run.id))?.logSealed));assert.equal(executions,1);
  }finally{
    if(heldClient&&!committed)await commitOriginal();if(commitPromise)await commitPromise;
    (pg.Client.prototype as any).query=originalClientQuery;await stopWorker(0);
  }
});
