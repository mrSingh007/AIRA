import test from 'node:test';
import assert from 'node:assert/strict';
import { fairAdmissions } from '../src/server/scheduler.js';
const queue = (projectId: string, count: number) => Array.from({length:count},(_,i)=>({id:`${projectId}-${i}`,ticketId:`${projectId}-${i}`,projectId}));
test('default limits admit 200 across two projects with FIFO and independent refill',()=>{
  const queues = new Map([['A',queue('A',101)],['B',queue('B',101)]]);
  const counts = new Map<string,number>(); let cursor: string|undefined; const admitted: string[]=[];
  for(let i=0;i<8;i++){
    const batch=fairAdmissions(queues,new Map(),counts,cursor); cursor=batch.lastProject;
    for(const run of batch.admitted){counts.set(run.projectId,(counts.get(run.projectId)||0)+1);admitted.push(run.id);}
  }
  assert.equal(admitted.length,200);assert.equal(counts.get('A'),100);assert.equal(counts.get('B'),100);
  assert.deepEqual(admitted.slice(0,4),['A-0','B-0','A-1','B-1']);
  counts.set('A',99);assert.deepEqual(fairAdmissions(queues,new Map(),counts,cursor).admitted.map(r=>r.id),['A-100']);
});
test('live reductions preserve reservations; increases and cleanup releases admit next jobs',()=>{
  const queues=new Map([['A',queue('A',10)],['B',queue('B',10)]]);
  const first=fairAdmissions(queues,new Map([['A',2],['B',5]]),new Map(),undefined);
  assert.equal(first.admitted.filter(r=>r.projectId==='A').length,2);assert.equal(first.admitted.filter(r=>r.projectId==='B').length,5);
  assert.equal(fairAdmissions(queues,new Map([['A',1],['B',5]]),new Map([['A',2],['B',5]]),undefined).admitted.length,0);
  assert.equal(fairAdmissions(queues,new Map([['A',3],['B',5]]),new Map([['A',2],['B',5]]),undefined).admitted[0].id,'A-2');
});
test('duplicate ticket IDs cannot enter a batch and deep queues cannot starve peers',()=>{
  const queues=new Map([['A',queue('A',1000)],['B',queue('B',1)]]);
  queues.get('A')![1].ticketId='A-0';
  const result=fairAdmissions(queues,new Map([['A',200]]),new Map(),undefined,32);
  assert.equal(result.admitted[1].projectId,'B');
  assert.equal(new Set(result.admitted.map(r=>r.ticketId)).size,result.admitted.length);
});

test('custom limits above 100 fill across bounded batches without becoming a global ceiling',()=>{
  const queues=new Map([['A',queue('A',151)],['B',queue('B',176)],['C',queue('C',11)]]);
  const limits=new Map([['A',150],['B',175],['C',10]]);
  const reservations=new Map<string,number>();
  let cursor:string|undefined;
  const started=new Map<string,string[]>();
  for(let batch=0;batch<20;batch++){
    const result=fairAdmissions(queues,limits,reservations,cursor,17);
    assert(result.admitted.length<=17);
    cursor=result.lastProject;
    for(const run of result.admitted){
      reservations.set(run.projectId,(reservations.get(run.projectId)||0)+1);
      const history=started.get(run.projectId)||[];history.push(run.id);started.set(run.projectId,history);
    }
  }
  assert.deepEqual([...reservations.entries()].sort(),[['A',150],['B',175],['C',10]]);
  for(const [projectId,count] of limits){
    assert.deepEqual(started.get(projectId),queue(projectId,count).map(run=>run.id));
    assert.equal(queues.get(projectId)?.length,1);
  }
  assert.equal(fairAdmissions(queues,limits,reservations,cursor).admitted.length,0);
  reservations.set('B',174);
  assert.deepEqual(fairAdmissions(queues,limits,reservations,cursor).admitted.map(run=>run.id),['B-175']);
});

test('one-project admission batches rotate the next chance to another eligible project',()=>{
  const queues=new Map([['A',queue('A',1000)],['B',queue('B',3)],['C',queue('C',3)]]);
  const admitted:string[]=[];
  const reservations=new Map<string,number>();
  let cursor:string|undefined;
  for(let batch=0;batch<9;batch++){
    const result=fairAdmissions(queues,new Map([['A',1000]]),reservations,cursor,1);
    const run=result.admitted[0];assert(run);
    admitted.push(run.id);reservations.set(run.projectId,(reservations.get(run.projectId)||0)+1);
    cursor=result.lastProject;
  }
  assert.deepEqual(admitted,['A-0','B-0','C-0','A-1','B-1','C-1','A-2','B-2','C-2']);
});
