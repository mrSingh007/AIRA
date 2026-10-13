import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import express from 'express';
import pg from 'pg';
import cookieParser from 'cookie-parser';
import { initializeDatabase, mutate, pool, closeDatabase, acquireWorkerLock, databaseMetrics } from '../src/server/db.js';
import { emptyState, enqueue, type StoredProject } from '../src/server/state.js';
import { encrypt, hashToken, initializeSecurity } from '../src/server/security.js';
import { saveConcurrency } from '../src/server/project-agent-settings.js';
import { getRun, listRuns, reservationCounts, setLifecycle } from '../src/server/run-repository.js';
import { startWorker, stopWorker, wakeWorker, workerActivity, recoverInterruptedRuns, claimAvailableRuns } from '../src/server/worker.js';
import { openRunLog, readRunLogs, logBufferUsage, TOTAL_LOG_BUFFER_LIMIT, flushRunLogs } from '../src/server/run-logs.js';
import { api } from '../src/server/api.js';
import type { RunContext, RunResult, Ticket } from '../src/shared/types.js';

const enabled=process.env.AIRA_TEST_DATABASE_URL;
if(enabled) process.env.DATABASE_URL=enabled; // pool URL must also be provided before module import
const wait=async(fn:()=>boolean|Promise<boolean>,timeout=15000)=>{const start=Date.now();while(!await fn()){if(Date.now()-start>timeout)throw new Error('Timed out waiting for worker');await new Promise(r=>setTimeout(r,20));}};
const percentile=(samples:number[],p:number)=>[...samples].sort((a,b)=>a-b)[Math.min(samples.length-1,Math.floor(samples.length*p))];
test('real PostgreSQL: per-project scheduling, live edits, outcome retries, logs, recovery and 100 developers', {skip:!enabled,timeout:180000}, async()=>{
  process.env.APP_SECRET='concurrency-test-secret-32-characters-long';process.env.APP_URL='http://localhost:3000';initializeSecurity();
  const testStarted=performance.now();await initializeDatabase(); const unlock=await acquireWorkerLock();
  const prefix=randomUUID();const userId=prefix+'-user';const token='a'.repeat(64);
  const makeProject=(id:string):StoredProject=>({id,name:id,key:id,description:'',repository:'test/repo',baseBranch:'main',model:'fake',modelProvider:"ollama",sandboxProvider:'docker',dockerImage:'fake',e2bTemplate:'',roles:{[userId]:'admin'},githubConnected:true,githubIdentity:'test',hasOllamaKey:true,hasClaudeKey:true,hasE2bKey:true,secrets:{githubToken:encrypt('test-github-secret'),ollamaApiKey:encrypt('test-model-secret'),claudeApiKey:encrypt('test-claude-secret'),e2bApiKey:encrypt('test-e2b-secret')},steps:[{id:'definition',name:'Define',kind:'definition',instructions:'',model:'',requiredApprovals:0,approverIds:[],includePriorArtifacts:false,filename:'definition.md'}]});
  const projects=[makeProject(prefix+'-A'),makeProject(prefix+'-B')];projects[1].sandboxProvider='e2b';
  const fixtureTickets:Ticket[]=[];
  const addTickets=async(count:number,targets=projects)=>mutate(async(state,client)=>{
    for(const project of targets)for(let i=0;i<count;i++){
      const ticket:Ticket={id:randomUUID(),projectId:project.id,number:`TEST-${fixtureTickets.length}`,title:'Synthetic ticket',description:'x'.repeat(1000),attachments:[],workflowSnapshot:null,priority:'medium',status:'active',stepId:'definition',sprintId:null,createdBy:userId,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),closedAt:null,pullRequests:[]};
      fixtureTickets.push(ticket);state.tickets.push(ticket);await enqueue(state,ticket,project.steps[0],userId,null,client);
    }
  });
  await mutate(state=>{state.users.push({id:userId,name:'Load developer',email:prefix+'@test.invalid',passwordHash:'unused',mustChangePassword:false});state.projects.push(...projects);state.sessions.push({tokenHash:hashToken(token),userId,expiresAt:new Date(Date.now()+3600000).toISOString()});});
  const deferred=new Map<string,{context:RunContext;resolve:(result:RunResult)=>void;reject:(error:Error)=>void}>();
  let executions=0;
  const fake=async(context:RunContext,onLog:(s:string)=>Promise<void>,options:any)=>{
    executions++;for(let i=0;i<10;i++)await onLog(`Synthetic ordered log ${i} test-model-secret ${'progress '.repeat(20)}`);
    return new Promise<RunResult>((resolve,reject)=>{deferred.set(context.run.id,{context,resolve,reject});options.signal.addEventListener('abort',()=>{deferred.delete(context.run.id);reject(new Error('Cancelled fake sandbox'));},{once:true});});
  };
  const finish=(id:string)=>{deferred.get(id)!.resolve({reply:'Synthetic success',artifact:'Definition '+id});deferred.delete(id);};
  let server:ReturnType<typeof express.prototype.listen>|undefined;
  let queueAgeMs:number[]=[];
  const samples={reads:[] as number[],writes:[] as number[]};
  let singleProject: { active:number; readsP95Ms:number; writesP95Ms:number } | undefined;
  const batches:Array<{rss:number;heap:number;cpu:NodeJS.CpuUsage;durationMs:number}>=[];
  try{
    await addTickets(101);startWorker({execute:fake,pollMs:50});
    await wait(()=>deferred.size===200);
    assert.equal(deferred.size,200);let counts=await reservationCounts();assert.equal(counts.get(projects[0].id),100);assert.equal(counts.get(projects[1].id),100);
    const queuedDefaults=(await listRuns({status:'pending'})).filter(r=>projects.some(p=>p.id===r.projectId));assert.equal(queuedDefaults.length,2);queueAgeMs=queuedDefaults.map(r=>Date.now()-new Date(r.createdAt).getTime());
    const firstA=[...deferred.values()].find(r=>r.context.project.id===projects[0].id)!;
    finish(firstA.context.run.id);await wait(()=>executions===201);assert.equal((await reservationCounts()).get(projects[1].id),100);
    await mutate(async(_s,c)=>saveConcurrency(projects[1].id,101,c));wakeWorker();await wait(()=>deferred.size===201);
    await mutate(async(_s,c)=>saveConcurrency(projects[0].id,1,c));wakeWorker();assert.equal((await reservationCounts()).get(projects[0].id),100);
    // Claimed provider/model snapshots remain immutable after configuration switches.
    await mutate(state=>{const p=state.projects.find(p=>p.id===projects[0].id)!;p.sandboxProvider='e2b';p.model='changed';p.modelProvider='claude';p.secrets.claudeApiKey=encrypt('changed-claude-secret');p.secrets.ollamaApiKey=encrypt('changed-ollama-secret');});
    assert.equal(firstA.context.project.sandboxProvider,'docker');assert.equal(firstA.context.project.model,'fake');
    assert.equal(firstA.context.project.modelProvider,'ollama');
    assert.equal(firstA.context.credentials.claudeApiKey,'test-claude-secret');
    assert.equal(firstA.context.credentials.ollamaApiKey,'test-model-secret');
    const app=express();app.use(express.json());app.use(cookieParser());app.use('/api',api);server=app.listen(0,'127.0.0.1');
    await new Promise<void>(r=>server!.once('listening',r));const address=server.address();assert(address&&typeof address!=='string');const root=`http://127.0.0.1:${address.port}`;
    await Promise.all(Array.from({length:100},async(_,i)=>{
      for(let j=0;j<3;j++){
        const start=performance.now();const res=await fetch(`${root}/api/projects/${projects[i%2].id}`,{headers:{Cookie:`aira_session=${token}`}});assert.equal(res.status,200);const board=await res.json();samples.reads.push(performance.now()-start);assert(board.artifacts.every((a:any)=>a.content===""));assert.equal(board.messages.length,0);assert.equal(board.runs.some((r:any)=>'logs'in r),false);
        const writeStart=performance.now();const response=await fetch(`${root}/api/projects/${projects[i%2].id}/tickets`,{method:'POST',headers:{Cookie:`aira_session=${token}`,'Content-Type':'application/json'},body:JSON.stringify({title:`Board action ${i}-${j}`,description:'Ordinary workflow write'})});assert.equal(response.status,201);await response.json();samples.writes.push(performance.now()-writeStart);
      }
    }));
    // Lost acknowledgement after successful outcome commit must not execute again or duplicate artifacts/audits.
    const originalClientQuery=pg.Client.prototype.query;let loseCommit=true;
    const victim=[...deferred.values()].find(item=>item.context.project.id===projects[1].id)!.context.run.id;
    const outcomeClients=new WeakSet<object>();
    (pg.Client.prototype as any).query=function(...args:any[]){
      const promise=(originalClientQuery as any).apply(this,args);
      if(String(args[0]).startsWith('UPDATE aira_runs SET status=$2') && args[1]?.[0]===victim && args[1]?.[1]==='completed')outcomeClients.add(this);
      if(loseCommit&&args[0]==='COMMIT'&&outcomeClients.has(this)){loseCommit=false;return promise.then(()=>{throw new Error('Lost commit acknowledgement');});}
      return promise;
    };
    finish(victim);await wait(async()=>((await getRun(victim))?.status==='completed'));await wait(()=>!workerActivity().some(r=>r.runId===victim));pg.Client.prototype.query=originalClientQuery;assert.equal(loseCommit,false);
    assert.equal(executions,202);
    const failedPeer=[...deferred.values()].find(item=>item.context.project.id===projects[0].id)!;
    failedPeer.reject(new Error("One fake sandbox failed independently"));deferred.delete(failedPeer.context.run.id);
    await wait(async()=>((await getRun(failedPeer.context.run.id))?.status==='failed'));
    assert.equal((await reservationCounts()).get(projects[1].id),100);
    // Drain repeated batches with fake providers and realistic log traffic.
    for(let batch=0;batch<3;batch++){
      const started=performance.now();for(const id of [...deferred.keys()])finish(id);
      await wait(()=>workerActivity().length===0);
      const memory=process.memoryUsage();batches.push({rss:memory.rss,heap:memory.heapUsed,cpu:process.cpuUsage(),durationMs:performance.now()-started});
      if(batch<2){await mutate(async(_s,c)=>{for(const p of projects)await saveConcurrency(p.id,100,c);});await addTickets(100);wakeWorker();await wait(()=>deferred.size===200);}
    }
    await stopWorker(0);
    const completed=await getRun(victim);assert.equal(completed?.logSealed,true);const logs=await readRunLogs(victim);assert(!logs.tail.includes('test-model-secret'));assert(logs.tail.includes('[REDACTED]'));assert(logs.tail.indexOf('log 0')<logs.tail.indexOf('log 9'));assert.equal((await readRunLogs(victim,logs.version)).unchanged,true);
    // A published PR result survives lost transaction acknowledgement without agent or PR replay.
    const prRun=await mutate(async(state,client)=>{
      const project=state.projects.find(p=>p.id===projects[0].id)!;
      const step={...project.steps[0],id:'implement',kind:'implement' as const,name:'Implement'};project.steps.push(step);
      const ticket={...fixtureTickets[0],id:randomUUID(),number:'PR-1',stepId:step.id,pullRequests:[]};state.tickets.push(ticket);
      return enqueue(state,ticket,step,userId,null,client);
    });
    const beforePrExecutions=executions;startWorker({execute:fake,pollMs:50});await wait(()=>deferred.has(prRun.id));
    let prLost=true;const prClients=new WeakSet<object>();const queryBeforePr=pg.Client.prototype.query;
    (pg.Client.prototype as any).query=function(...args:any[]){
      const result=(queryBeforePr as any).apply(this,args);
      if(String(args[0]).startsWith('UPDATE aira_runs SET status=$2')&&args[1]?.[0]===prRun.id&&args[1]?.[1]==='completed')prClients.add(this);
      if(prLost&&args[0]==='COMMIT'&&prClients.has(this)){prLost=false;return result.then(()=>{throw new Error('Lost post-publication COMMIT acknowledgement');});}
      return result;
    };
    deferred.get(prRun.id)!.resolve({reply:'Published synthetic PR',prNumber:123,prUrl:'https://github.com/test/repo/pull/123'});deferred.delete(prRun.id);
    await wait(()=>!workerActivity().some(run=>run.runId===prRun.id));pg.Client.prototype.query=queryBeforePr;
    assert.equal(prLost,false);assert.equal(executions,beforePrExecutions+1);
    const {readState}=await import('../src/server/db.js');const prState=await readState();
    assert.equal(prState.tickets.find(t=>t.id===prRun.ticketId)!.pullRequests.filter(pr=>pr.runId===prRun.id).length,1);
    assert.equal(prState.audit.filter(a=>a.ticketId===prRun.ticketId&&a.action==='pull_request.created').length,1);
    await stopWorker(0);
    // Sustained one-project phase exercises the same 100 developers with 100 active jobs.
    await addTickets(100,[projects[0]]);startWorker({execute:fake,pollMs:50});await wait(()=>deferred.size===100);
    assert.equal((await reservationCounts()).get(projects[0].id),100);assert.equal((await reservationCounts()).get(projects[1].id),undefined);
    const oneReads:number[]=[];const oneWrites:number[]=[];
    const serverAddress=server!.address();assert(serverAddress&&typeof serverAddress!=='string');const oneRoot=`http://127.0.0.1:${serverAddress.port}`;
    await Promise.all(Array.from({length:100},async(_,i)=>{
      const began=performance.now();const response=await fetch(`${oneRoot}/api/projects/${projects[0].id}`,{headers:{Cookie:`aira_session=${token}`}});assert.equal(response.status,200);await response.json();oneReads.push(performance.now()-began);
      const writeBegan=performance.now();const result=await fetch(`${oneRoot}/api/projects/${projects[0].id}/tickets`,{method:'POST',headers:{Cookie:`aira_session=${token}`,'Content-Type':'application/json'},body:JSON.stringify({title:`Single-project board action ${i}`})});assert.equal(result.status,201);await result.json();oneWrites.push(performance.now()-writeBegan);
    }));
    singleProject={active:100,readsP95Ms:percentile(oneReads,.95),writesP95Ms:percentile(oneWrites,.95)};
    for(const id of [...deferred.keys()])finish(id);await wait(()=>workerActivity().length===0);await stopWorker(0);
    // Idempotent append retry after UPDATE succeeded but acknowledgement was lost.
    const logRun=await mutate(async(state,client)=>{const ticket={...fixtureTickets[0],id:randomUUID(),number:'LOG-1'};state.tickets.push(ticket);return enqueue(state,ticket,projects[0].steps[0],userId,null,client);});
    const logger=await openRunLog(logRun.id,['private-key']);await logger.write('exactly-once private-key');
    const originalQuery=pool.query.bind(pool);let lostAppend=true;(pool as any).query=async(...args:any[])=>{const result=await (originalQuery as any)(...args);if(lostAppend&&String(args[0]).startsWith('UPDATE aira_run_logs AS l')){lostAppend=false;throw new Error('Lost log acknowledgement');}return result;};
    await assert.rejects(logger.flush());await logger.flush();(pool as any).query=originalQuery;assert.equal((await readRunLogs(logRun.id)).tail.match(/exactly-once/g)?.length,1);
    for(let i=0;i<100;i++)await logger.write('x'.repeat(30000));assert(logBufferUsage().characters<=TOTAL_LOG_BUFFER_LIMIT);await logger.flush();assert((await readRunLogs(logRun.id)).tail.length<=200000);await logger.seal();await pool.query('UPDATE aira_run_logs SET sealed=false WHERE run_id=$1',[logRun.id]);
    // Restart preserves pending and fails running without repeating execution; pre-resource reservations release.
    await mutate(async(_s,c)=>{await saveConcurrency(projects[0].id,1,c);});const claims=await claimAvailableRuns();assert.equal(claims.length,1);await recoverInterruptedRuns();assert.equal((await getRun(logRun.id))?.status,'failed');assert.equal((await reservationCounts()).get(projects[0].id),undefined);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM aira_runs WHERE status=\'running\' AND project_id=ANY($1)',[projects.map(p=>p.id)])).rows[0].n,0);
    // Shutdown cancels every admitted job, stops claims, and retains durable pending peers.
    await mutate(async(_state,client)=>{await saveConcurrency(projects[0].id,2,client);await saveConcurrency(projects[1].id,5,client);});
    await addTickets(4);startWorker({execute:fake,pollMs:50});await wait(()=>deferred.size===6);
    const shutdownRuns=[...deferred.keys()];await stopWorker(0);
    for(const runId of shutdownRuns)assert.equal((await getRun(runId))?.status,'failed');
    const pendingBeforeRestart=(await listRuns({status:'pending'})).filter(r=>projects.some(p=>p.id===r.projectId)).map(r=>r.id);
    assert.equal(pendingBeforeRestart.length,2);await recoverInterruptedRuns();
    for(const runId of pendingBeforeRestart)assert.equal((await getRun(runId))?.status,'pending');
    assert.equal(workerActivity().length,0);assert.equal((await reservationCounts()).size,0);
    const measured={durationMs:performance.now()-testStarted,date:new Date().toISOString(),node:process.version,platform:process.platform,architecture:process.arch,hardware:{cpu:os.cpus()[0]?.model,cores:os.cpus().length,memoryBytes:os.totalmem()},dataset:{projects:2,agentTickets:fixtureTickets.length,boardWrites:400},workload:{activePerProject:100,totalActive:200,simulatedDevelopers:100,readSamples:samples.reads.length,writeSamples:samples.writes.length,provider:'deferred fake, PostgreSQL real'},queueAgeMsAtDefaultCapacity:queueAgeMs,verifiedReservationPhases:[{A:100,B:100},{A:100,B:101},{A:100,B:0}],injectedProviderFailures:1,singleProject,p95BoardReadMs:percentile(samples.reads,.95),p95WorkflowWriteMs:percentile(samples.writes,.95),batches,logBufferAfter:logBufferUsage(),databaseMetrics:databaseMetrics()};
    console.log('LOAD_RESULT '+JSON.stringify(measured));if(process.env.AIRA_LOAD_REPORT)await writeFile(process.env.AIRA_LOAD_REPORT,JSON.stringify(measured,null,2)+'\n');
    assert(singleProject!.readsP95Ms<1000,`Single-project board p95 ${singleProject!.readsP95Ms}`);assert(singleProject!.writesP95Ms<1000,`Single-project workflow p95 ${singleProject!.writesP95Ms}`);
    assert(measured.p95BoardReadMs<1000,`Board p95 ${measured.p95BoardReadMs}`);assert(measured.p95WorkflowWriteMs<1000,`Workflow p95 ${measured.p95WorkflowWriteMs}`);
  }finally{
    if(server)await new Promise<void>(r=>server!.close(()=>r()));await stopWorker(0);await flushRunLogs();
    await pool.query('DELETE FROM aira_runs WHERE project_id=ANY($1)',[projects.map(p=>p.id)]);await pool.query('DELETE FROM aira_project_agent_settings WHERE project_id=ANY($1)',[projects.map(p=>p.id)]);
    await mutate(state=>{state.projects=state.projects.filter(p=>!projects.some(x=>x.id===p.id));state.users=state.users.filter(u=>u.id!==userId);state.sessions=state.sessions.filter(s=>s.userId!==userId);const ticketIds=new Set(state.tickets.filter(t=>projects.some(p=>p.id===t.projectId)).map(t=>t.id));state.tickets=state.tickets.filter(t=>!ticketIds.has(t.id));state.artifacts=state.artifacts.filter(a=>!ticketIds.has(a.ticketId));state.audit=state.audit.filter(a=>!projects.some(p=>p.id===a.projectId));});
    await unlock();await closeDatabase();
  }
});
