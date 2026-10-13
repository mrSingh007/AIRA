import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomBytes } from "node:crypto";
import express from "express";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";

const databaseUrl = process.env.AIRA_TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
const { initializeDatabase, mutate, readState, pool, closeDatabase } = await import("../src/server/db.js");
const { api } = await import("../src/server/api.js");
const { id, now, enqueue, publicProject, ApiError } = await import("../src/server/state.js");
const { initializeSecurity, hashToken, encrypt, decrypt } = await import("../src/server/security.js");
const { effectiveConcurrency, saveConcurrency } = await import("../src/server/project-agent-settings.js");
const { getRun, listRuns, updateRun, setLifecycle, reservationCounts, recoverInterruptedRuns, claimRun, listLifecycles, enqueueRun } = await import("../src/server/run-repository.js");
const { openRunLog, readRunLogs } = await import("../src/server/run-logs.js");
const adminId: string = id();
const memberId: string = id();
const outsiderId: string = id();
const projectId = id();
const ticketId = id();
const stepId = id();
const cookies = [adminId,memberId,outsiderId].map(() => randomBytes(32).toString("hex"));
let server: Server;
let origin: string;
before(async () => {
  if (!databaseUrl) return;
  process.env.APP_SECRET = "test-secret-for-storage-and-api-123456789";
  process.env.APP_URL = "http://localhost";
  initializeSecurity();
  await initializeDatabase();
  await mutate(state => {
    for (const [index,userId] of [adminId,memberId,outsiderId].entries()) {
      state.users.push({id:userId,name:"Fixture",email:`${userId}@example.test`,passwordHash:"unused",mustChangePassword:false});
      state.sessions.push({userId,tokenHash:hashToken(cookies[index]),expiresAt:new Date(Date.now()+60_000).toISOString()});
    }
    state.projects.push({id:projectId,name:"Concurrent fixture",key:"FIX",description:"",repository:"",baseBranch:"main",model:"test",modelProvider:"ollama",sandboxProvider:"docker",dockerImage:"fixture",e2bTemplate:"",steps:[{id:stepId,name:"Define",kind:"definition",instructions:"",model:"",requiredApprovals:0,approverIds:[],includePriorArtifacts:false,filename:"definition.md"}],roles:{[adminId]:"admin",[memberId]:"member"},githubConnected:false,githubIdentity:"",hasOllamaKey:false,hasClaudeKey:false,hasE2bKey:false,secrets:{githubToken:"",ollamaApiKey:"",claudeApiKey:"",e2bApiKey:""}});
    state.tickets.push({id:ticketId,projectId,number:"FIX-1",title:"Concurrent test",description:"",attachments:[],workflowSnapshot:null,priority:"medium",status:"active",stepId,sprintId:null,createdBy:adminId,createdAt:now(),updatedAt:now(),closedAt:null,pullRequests:[]});
  });
  const app = express();
  app.use(express.json(),cookieParser());
  app.use("/api",api);
  app.use((error:any,_req:any,res:any,_next:any) => res.status(error instanceof ApiError ? error.status : error.name === "ZodError" ? 400 : 500).json({error:error.message}));
  server = app.listen(0,"127.0.0.1");
  await new Promise<void>(resolve => server.once("listening",resolve));
  origin = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
});
after(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  if (databaseUrl) {
    await pool.query("DELETE FROM aira_runs WHERE project_id=$1",[projectId]);
    await pool.query("DELETE FROM aira_project_agent_settings WHERE project_id=$1",[projectId]);
    await mutate(state => {
      const ticketIds=new Set(state.tickets.filter(ticket=>ticket.projectId===projectId).map(ticket=>ticket.id));
      const threadIds=new Set(state.threads.filter(thread=>ticketIds.has(thread.ticketId)).map(thread=>thread.id));
      const attachmentIds=new Set(state.tickets.filter(ticket=>ticketIds.has(ticket.id)).flatMap(ticket=>ticket.attachments.map(attachment=>attachment.id)));
      state.users=state.users.filter(user=>![adminId,memberId,outsiderId].includes(user.id));
      state.sessions=state.sessions.filter(session=>![adminId,memberId,outsiderId].includes(session.userId));
      state.projects=state.projects.filter(project=>project.id!==projectId);
      state.tickets=state.tickets.filter(ticket=>!ticketIds.has(ticket.id));
      state.sprints=state.sprints.filter(sprint=>sprint.projectId!==projectId);
      state.artifacts=state.artifacts.filter(artifact=>!ticketIds.has(artifact.ticketId));
      state.revisions=state.revisions.filter(artifact=>!ticketIds.has(artifact.ticketId));
      state.approvals=state.approvals.filter(approval=>!ticketIds.has(approval.ticketId));
      state.threads=state.threads.filter(thread=>!threadIds.has(thread.id));
      state.messages=state.messages.filter(message=>!threadIds.has(message.threadId));
      state.audit=state.audit.filter(event=>event.projectId!==projectId);
      for(const attachmentId of attachmentIds) delete state.attachmentData[attachmentId];
    });
  }
  await closeDatabase();
});
async function request(path:string,body?:unknown,user=0) {
  return fetch(`${origin}/api${path}`,{method:body===undefined?"GET":"PATCH",headers:{Cookie:`aira_session=${cookies[user]}`,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
}
integration("concurrent board polls share work while authorizing every requester", async (t) => {
  let release!: () => void;
  let began!: () => void;
  const hold = new Promise<void>(resolve => { release=resolve; });
  const started = new Promise<void>(resolve => { began=resolve; });
  const originalQuery = pool.query.bind(pool);
  let summaries = 0;
  const mocked = t.mock.method(pool,"query",async (...args:any[]) => {
    if (String(args[0]).includes("history_rank=1 OR reservation_held")) {
      summaries++;began();await hold;
    }
    return (originalQuery as any)(...args);
  });
  const requests = Promise.all(Array.from({length:8},(_,index)=>request(`/projects/${projectId}`,undefined,index%2)));
  try {
    await started;
    assert.equal((await request(`/projects/${projectId}`,undefined,2)).status,404);
    await new Promise(resolve=>setTimeout(resolve,20));
    release();
    const responses=await requests;
    const boards=await Promise.all(responses.map(async response=> {assert.equal(response.status,200);return response.json();}));
    assert.equal(summaries,1);
    for (const board of boards) {assert.equal(board.project.id,projectId);assert.equal("secrets" in board.project,false);}
  } finally {release();await requests;mocked.mock.restore();}
});
integration("sparse default, live overrides, admin authorization, and strict storage bounds", async () => {
  assert.equal(await effectiveConcurrency(projectId),100);
  assert.equal((await publicProject((await readState()).projects.find(p=>p.id===projectId)!)).maxConcurrentRuns,100);
  assert.equal((await request(`/projects/${projectId}`,{maxConcurrentRuns:200},1)).status,403);
  for (const value of [0,-1,1.5,"", "10",null,2_147_483_648]) assert.equal((await request(`/projects/${projectId}`,{maxConcurrentRuns:value})).status,400);
  assert.equal((await request(`/projects/${projectId}`,{maxConcurrentRuns:200})).status,200);
  assert.equal(await effectiveConcurrency(projectId),200);
  assert.equal((await (await request(`/auth/me`)).json()).projects.find((p:any)=>p.id===projectId).maxConcurrentRuns,200);
  const stored = (await readState()).projects.find(p=>p.id===projectId)!;
  assert.equal(Object.hasOwn(stored,"maxConcurrentRuns"),false);
  assert.equal(stored.dockerImage,"fixture");
});
integration("model provider settings require administrator access and keep encrypted keys private", async () => {
  assert.equal((await request(`/projects/${projectId}`, {modelProvider:"claude",claudeApiKey:"claude-private-test-key"},1)).status,403);
  assert.equal((await request(`/projects/${projectId}`, {modelProvider:"unsupported"})).status,400);
  const response=await request(`/projects/${projectId}`, {modelProvider:"claude",model:"claude-sonnet-4-6",claudeApiKey:"claude-private-test-key",ollamaApiKey:"ollama-private-test-key"});
  assert.equal(response.status,200);
  const publicSettings=await response.json();
  assert.equal(publicSettings.modelProvider,"claude");
  assert.equal(publicSettings.hasClaudeKey,true);
  assert.equal(publicSettings.hasOllamaKey,true);
  assert.equal("secrets" in publicSettings,false);
  assert.equal(JSON.stringify(publicSettings).includes("private-test-key"),false);
  let stored=(await readState()).projects.find(project=>project.id===projectId)!;
  assert.notEqual(stored.secrets.claudeApiKey,"claude-private-test-key");
  assert.equal(decrypt(stored.secrets.claudeApiKey),"claude-private-test-key");
  assert.equal(decrypt(stored.secrets.ollamaApiKey),"ollama-private-test-key");
  const savedClaudeKey=stored.secrets.claudeApiKey;
  const savedOllamaKey=stored.secrets.ollamaApiKey;
  assert.equal((await request(`/projects/${projectId}`,{modelProvider:"ollama"})).status,200);
  stored=(await readState()).projects.find(project=>project.id===projectId)!;
  assert.equal(stored.secrets.claudeApiKey,savedClaudeKey);
  assert.equal(stored.secrets.ollamaApiKey,savedOllamaKey);
  const cleared=await (await request(`/projects/${projectId}`,{claudeApiKey:""})).json();
  assert.equal(cleared.hasClaudeKey,false);
  assert.equal(cleared.hasOllamaKey,true);
});
integration("enqueue is atomic with chat/workflow and competing requests admit one run",async () => {
  const attempts = await Promise.allSettled([0,1].map(()=>mutate(async(state,client)=> {
    const ticket = state.tickets.find(t=>t.id===ticketId)!;
    const step = state.projects.find(p=>p.id===projectId)!.steps[0];
    return enqueue(state,ticket,step,adminId,null,client);
  })));
  assert.equal(attempts.filter(a=>a.status==="fulfilled").length,1);
  assert.equal((await listRuns({ticketId})).length,1);
  const before = (await readState()).audit.length;
  await assert.rejects(mutate(async(state,client)=>{ await saveConcurrency(projectId,7,client);state.audit.push({id:id(),projectId,ticketId:null,userId:adminId,action:"rollback",detail:"",createdAt:now()});throw new Error("rollback"); }));
  assert.equal(await effectiveConcurrency(projectId),200);
  assert.equal((await readState()).audit.length,before);
});
integration("bounded redacted idempotent log append, authorization and no board log hydration",async () => {
  const run = (await listRuns({ticketId}))[0];
  const logger = await openRunLog(run.id,["private-secret-123"]);
  await logger.write("private-secret-123 " + "x".repeat(220_000));
  await logger.flush();
  const logs = await readRunLogs(run.id);
  assert.equal(logs.tail.length,200_000);
  assert.equal(logs.tail.includes("private-secret-123"),false);
  assert.equal((await readRunLogs(run.id,logs.version)).unchanged,true);
  assert.equal((await request(`/runs/${run.id}/logs`,undefined,2)).status,404);
  const board = await (await request(`/projects/${projectId}`)).json();
  assert.equal(Object.hasOwn(board.runs[0],"logs"),false);
  await logger.seal();
  assert.equal((await getRun(run.id))!.logSealed,true);
});
integration("terminal outcomes keep cleanup quota until release; startup preserves queued jobs",async () => {
  const run = (await listRuns({ticketId}))[0];
  await setLifecycle(run.id,{reservationHeld:true,provider:"e2b",sandboxId:"fixture-resource",phase:"cleanup"});
  run.status="completed";run.finishedAt=now();await updateRun(run);
  assert.equal((await reservationCounts()).get(projectId),1);
  assert.equal((await getRun(run.id))!.cleanupStatus,"pending");
  await setLifecycle(run.id,{reservationHeld:false,phase:"settled",sandboxId:null,cleanupCredential:null});
  assert.equal((await reservationCounts()).get(projectId),undefined);
  await mutate(async(state,client)=> { const ticket=state.tickets.find(t=>t.id===ticketId)!; await enqueue(state,ticket,state.projects.find(p=>p.id===projectId)!.steps[0],adminId,null,client); });
  await mutate(async(_state,client)=> { await recoverInterruptedRuns(client); });
  assert.equal((await listRuns({ticketId,status:"pending"})).length,1);
});
integration("selected-ticket run history uses stable pagination and board remains light",async () => {
  const pending=(await listRuns({ticketId,status:"pending"}))[0];pending.status="failed";pending.finishedAt=now();await updateRun(pending);
  for(let index=0;index<53;index++) await mutate(async(state,client)=> {
    const ticket=state.tickets.find(t=>t.id===ticketId)!;
    const run=await enqueue(state,ticket,state.projects.find(p=>p.id===projectId)!.steps[0],adminId,null,client);
    run.status="completed";run.finishedAt=now();await updateRun(run,client);
  });
  const page1=await (await request(`/tickets/${ticketId}/detail`)).json();
  assert.equal(page1.runs.length,50);assert.ok(page1.nextRunsCursor);
  assert.deepEqual(page1.runsPageOldest,{id:page1.runs[0].id,createdAt:page1.runs[0].createdAt});
  assert.deepEqual(page1.auditPageOldest,{id:page1.audit[0].id,createdAt:page1.audit[0].createdAt});
  const page2=await (await request(`/tickets/${ticketId}/detail?runsBefore=${page1.nextRunsCursor}`)).json();
  assert.equal(page2.runs.length,6);
  assert.equal(new Set([...page1.runs,...page2.runs].map(r=>r.id)).size,55);
  const board=await (await request(`/projects/${projectId}`)).json();
  assert.equal(board.runs.length,1);assert.deepEqual(board.messages,[]);assert.deepEqual(board.threads,[]);
});

integration("claim enforces live limits across execution and cleanup, retaining original provider",async () => {
  const secondTicketId=id();
  await mutate(state=> {const first=state.tickets.find(t=>t.id===ticketId)!;state.tickets.push({...first,id:secondTicketId,number:"FIX-2"});});
  const queued=await Promise.all([ticketId,secondTicketId].map(ticket=>mutate(async(state,client)=>enqueue(state,state.tickets.find(t=>t.id===ticket)!,state.projects.find(p=>p.id===projectId)!.steps[0],adminId,null,client))));
  await mutate(async(_state,client)=>saveConcurrency(projectId,1,client));
  assert.equal(await mutate(async(_state,client)=>claimRun(queued[0].id,"docker",client)),true);
  assert.equal(await mutate(async(_state,client)=>claimRun(queued[1].id,"e2b",client)),false);
  const claimed=(await getRun(queued[0].id))!;claimed.status="completed";claimed.finishedAt=now();await updateRun(claimed);
  assert.equal(await mutate(async(_state,client)=>claimRun(queued[1].id,"e2b",client)),false);
  await mutate(async(_state,client)=>saveConcurrency(projectId,2,client));
  assert.equal(await mutate(async(_state,client)=>claimRun(queued[1].id,"e2b",client)),true);
  assert.equal((await reservationCounts()).get(projectId),2);
  await mutate(async(_state,client)=>saveConcurrency(projectId,1,client));
  assert.equal((await reservationCounts()).get(projectId),2);
  const provider=await pool.query("SELECT provider FROM aira_runs WHERE id=$1",[queued[0].id]);
  assert.equal(provider.rows[0].provider,"docker");
});
integration("operational writes are normalized and do not rewrite core settings",async () => {
  const before=await pool.query("SELECT document,updated_at FROM aira_state WHERE id=1");
  await mutate(state=> {state.tickets.find(t=>t.id===ticketId)!.title="Changed normalized record";});
  const after=await pool.query("SELECT document,updated_at FROM aira_state WHERE id=1");
  assert.deepEqual(after.rows[0],before.rows[0]);
  const record=await pool.query("SELECT document FROM aira_records WHERE kind='tickets' AND record_id=$1",[ticketId]);
  assert.equal(record.rows[0].document.title,"Changed normalized record");
});

integration("recovery retains confirmed disposal while marking unfinished outcome uncertain",async () => {
  const run=(await listRuns({projectId,status:"running"}))[0];
  assert.ok(run);
  await setLifecycle(run.id,{phase:"finalizing",sandboxId:null,cleanupCredential:null});
  await mutate(async(_state,client)=>recoverInterruptedRuns(client));
  const lifecycle=(await listLifecycles()).find(lifecycle=>lifecycle.runId===run.id)!;
  assert.equal(lifecycle.phase,"finalizing");
  assert.equal(lifecycle.sandboxId,null);
  assert.equal(lifecycle.cleanupCredential,null);
  assert.equal((await getRun(run.id))!.status,"failed");
});

integration("board previews stay bounded while authorized search retains full-description matching",async () => {
  await mutate(state=>{const ticket=state.tickets.find(ticket=>ticket.id===ticketId)!;ticket.description="preview ".repeat(100)+"unique-deep-search";});
  const board=await (await request(`/projects/${projectId}`)).json();assert.equal(board.tickets.find((t:any)=>t.id===ticketId).description.length,200);
  const detail=await (await request(`/tickets/${ticketId}/detail`)).json();assert(detail.ticket.description.includes("unique-deep-search"));
  const search=await (await request(`/projects/${projectId}/tickets/search?q=unique-deep-search`)).json();assert.deepEqual(search.ticketIds,[ticketId]);
  assert.equal((await request(`/projects/${projectId}/tickets/search?q=unique-deep-search`,undefined,2)).status,404);
});
integration("copy-on-write transactions retain prior snapshots and detach returned execution context",async () => {
  const previous=await readState();
  const previousTicket=previous.tickets.find(ticket=>ticket.id===ticketId)!;
  const previousTitle=previousTicket.title;
  const previousProject=previous.projects.find(project=>project.id===projectId)!;
  const originalModel=previousProject.model;
  const context=await mutate(async state=> {
    const ticket=state.tickets.find(ticket=>ticket.id===ticketId)!;
    const project=state.projects.find(project=>project.id===projectId)!;
    ticket.title="Copy-on-write result";
    await Promise.resolve();
    return {ticket,project,steps:[{step:project.steps[0]}]};
  });
  assert.equal(previousTicket.title,previousTitle);
  assert.equal(context.ticket.title,"Copy-on-write result");
  assert.equal(context.steps[0].step.id,stepId);
  assert.doesNotThrow(()=>JSON.stringify(context));
  await mutate(state=> {state.projects.find(project=>project.id===projectId)!.model="Later claim model";});
  assert.equal(previousProject.model,originalModel);
  assert.equal(context.project.model,originalModel);
  await assert.rejects(mutate(state=> {state.tickets.find(ticket=>ticket.id===ticketId)!.title="Uncommitted title";throw new Error("Rollback draft");}));
  assert.equal(context.ticket.title,"Copy-on-write result");
  assert.equal((await readState()).tickets.find(ticket=>ticket.id===ticketId)!.title,"Copy-on-write result");
});

integration("fresh enqueues use the database eligibility clock despite an ahead application clock",async () => {
  const futureTicketId=id();
  const futureRunId=id();
  await mutate(async(state,client)=> {
    const ticket={...state.tickets.find(ticket=>ticket.id===ticketId)!,id:futureTicketId,number:"CLOCK-1"};
    state.tickets.push(ticket);
    const run={id:futureRunId,projectId,ticketId:futureTicketId,stepId,threadId:null,kind:"definition" as const,status:"pending" as const,cleanupStatus:"none" as const,logSealed:false,error:null,createdAt:new Date(Date.now()+60_000).toISOString(),startedAt:null,finishedAt:null};
    await enqueueRun(run,projectId,client);
    await saveConcurrency(projectId,10,client);
  });
  const eligible=await pool.query("SELECT eligible_at <= now() AS ready FROM aira_runs WHERE id=$1",[futureRunId]);
  assert.equal(eligible.rows[0].ready,true);
  assert.equal(await mutate(async(_state,client)=>claimRun(futureRunId,"docker",client)),true);
});

integration("concurrency saves do not depend on unchanged GitHub credentials; token and repository changes are verified", async (t) => {
  const encryptedToken = encrypt("expired-fixture-github-token");
  await mutate(state => {
    const project = state.projects.find(project => project.id === projectId)!;
    project.repository = "owner/repo";
    project.secrets.githubToken = encryptedToken;
  });
  const originalFetch = globalThis.fetch;
  let verifications = 0;
  t.mock.method(globalThis, "fetch", (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith("https://api.github.com/")) {
      verifications++;
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    }
    return originalFetch(input, init);
  }) as typeof fetch);
  assert.equal((await request(`/projects/${projectId}`, { repository: "owner/repo", maxConcurrentRuns: 208 })).status, 200);
  assert.equal(verifications, 0);
  assert.equal(await effectiveConcurrency(projectId), 208);
  assert.equal((await request(`/projects/${projectId}`, { repository: "owner/repo", githubToken: "replacement-fixture-token", maxConcurrentRuns: 209 })).status, 502);
  assert.equal(verifications, 1);
  assert.equal((await request(`/projects/${projectId}`, { repository: "owner/changed-repository", maxConcurrentRuns: 209 })).status, 502);
  assert.equal(verifications, 2);
  assert.equal(await effectiveConcurrency(projectId), 208);
  const stored = (await readState()).projects.find(project => project.id === projectId)!;
  assert.equal(stored.repository, "owner/repo");
  assert.equal(stored.secrets.githubToken, encryptedToken);
});
