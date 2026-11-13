// A single remote intent routed to an existing guarded local adapter.
// Do not introduce an unrestricted script/coordinate executor.
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {jsonResult} from './common.mjs';
import {browserAction,validateFormFields} from './browser-actions.mjs';
import {appTask} from './app-task.mjs';
import {validateAppTask} from './app-task-contract.mjs';
import {createAppExecuteJournal} from './app-execute-journal.mjs';

const ALLOWED_MODES=new Set(['browser_form','app_task']);
const READ_ONLY_INTENTS=new Set(['inspect','find','find_post']);
const NON_SUCCESS_STATUSES=new Set(['blocked','outcome_unknown','ready_for_review',
  'inspection_unavailable','planned','needs_exact_post_url','preview_only',
  'unavailable','multiple_candidates','no_matching_own_posts']);
const TASK_KEYS=new Set(['app','intent','query','channel','post_url','replacement_text',
  'expected_text','expected_value_token','window_id','pid','control_id',
  'expected_name','expected_role','target_id']);
const REQUEST_KEYS=new Set(['mode','target_id','origin','endpoint','fields','task',
  'dry_run','commit','operation_id','timeout_ms']);
const defaultJournal=createAppExecuteJournal();
const has=(o,p)=>Object.hasOwn(o,p);
const object=value=>value && typeof value==='object'&&!Array.isArray(value);
const uuid=value=>typeof value==='string'&&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const opaqueHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const DEADLINE_EXCEEDED=Symbol('app_execute_deadline');

// The adapter may finish after this call returns; timeout is not cancellation.
// Keep a mutation's journal ID reserved and never auto-retry an uncertain result.
async function withDeadline(action,timeoutMs){
  let timer;
  try{
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(DEADLINE_EXCEEDED),timeoutMs);
      }),
    ]);
  }finally{clearTimeout(timer);}
}

export function validateAppExecute(args={}){
  if(!object(args)||Object.keys(args).some(key=>!REQUEST_KEYS.has(key)))
    throw new Error('app_execute received an unsupported argument');
  const mode=args.mode;
  if(!ALLOWED_MODES.has(mode))throw new Error('app_execute mode must be browser_form or app_task');
  if(args.commit!=null && typeof args.commit!=='boolean'||
     args.dry_run!=null && typeof args.dry_run!=='boolean'||
     args.commit===true&&args.dry_run===true)
    throw new Error('commit and dry_run are mutually exclusive booleans');
  const timeout_ms=args.timeout_ms==null?10000:Number(args.timeout_ms);
  if(!Number.isInteger(timeout_ms)||timeout_ms<100||timeout_ms>12000)
    throw new Error('app_execute timeout must be 100..12000 ms');
  if(args.operation_id!=null&&!uuid(args.operation_id))
    throw new Error('operation_id must be an explicit UUID');
  if(mode==='browser_form'){
    if(has(args,'task'))throw new Error('browser_form does not accept an app task');
    if(typeof args.target_id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(args.target_id))
      throw new Error('browser_form requires an exact browser target_id');
    let parsed;
    try{parsed=new URL(args.origin);}catch{throw new Error('browser_form requires an exact origin')}
    if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||
      parsed.pathname!=='/'||parsed.search||parsed.hash||
      parsed.origin!==args.origin)
      throw new Error('browser_form requires an exact URL origin without path or credentials');
    if(args.endpoint!=null&&(typeof args.endpoint!=='string'||args.endpoint.length>256))
      throw new Error('Invalid CDP endpoint');
    return {mode,target_id:args.target_id,origin:parsed.origin,
      fields:validateFormFields(args.fields),commit:args.commit===true,
      dry_run:args.dry_run===true,timeout_ms,
      ...(args.endpoint?{endpoint:args.endpoint}:{})};
  }
  if(has(args,'origin')||has(args,'endpoint')||has(args,'fields')||has(args,'target_id'))
    throw new Error('app_task mode does not accept browser form arguments');
  if(!object(args.task)||Object.keys(args.task).some(key=>!TASK_KEYS.has(key)))
    throw new Error('app_task mode requires a closed task object');
  const task={...args.task};
  validateAppTask({...task,dry_run:args.dry_run===true||args.commit!==true,
    ...(['edit_post','set_control_text'].includes(task.intent)?{commit:args.commit===true}:{})});
  return {mode,task,commit:args.commit===true,dry_run:args.dry_run===true,timeout_ms};
}

const planned=(plan,{readOnly=false}={})=>jsonResult({
  status:'planned',mode:plan.mode,executed:false,verified:false,
  screenshot_used:false,requires_commit:!readOnly,
  ...(plan.mode==='browser_form'?{
    field_count:plan.fields.length,target_id:plan.target_id,origin:plan.origin,
  }:{intent:plan.task.intent,app:plan.task.app}),
});

export async function appExecute(args={},adapters={}){
  const plan=validateAppExecute(args);
  const readOnly=plan.mode==='app_task'&&READ_ONLY_INTENTS.has(plan.task.intent);
  if(plan.dry_run||(!plan.commit&&!readOnly))return planned(plan,{readOnly});
  if(plan.commit&&!args.operation_id)
    throw new Error('Mutating app_execute requires a caller-supplied operation_id UUID');
  // For read-only app work, no replay journal is necessary.
  const fingerprint=plan.commit?opaqueHash(plan):null;
  const operationJournal=adapters.operationJournal||defaultJournal;
  if(plan.commit){
    const reservation=operationJournal.begin(args.operation_id,fingerprint);
    if(reservation.replayed)return jsonResult({...reservation.result,replayed:true});
  }
  const started=performance.now();
  let outcome;
  try{
    if(plan.mode==='browser_form'){
      const run=adapters.browserAction||browserAction;
      const response=await withDeadline(()=>run({action:'fill_form',
        target_id:plan.target_id,expected_origin:plan.origin,
        fields:plan.fields,timeout_ms:plan.timeout_ms,
        ...(plan.endpoint?{endpoint:plan.endpoint}:{})}),plan.timeout_ms);
      const data=response?.structuredContent;
      const verified=response?.isError!==true&&
        data?.target_id===plan.target_id&&data?.action==='fill_form'&&
        data?.result?.verified===true&&
        data?.result?.filled===plan.fields.length&&
        data?.result?.verified_fields===plan.fields.length&&
        data?.result?.submitted===false;
      outcome={status:verified?'completed':'outcome_unknown',
        executed:true,verified,mode:plan.mode,target_id:plan.target_id,
        field_count:plan.fields.length,screenshot_used:false,
        submitted:verified?false:null,via:'guarded_local_browser_dom',
        ...(verified?{}:{reason:'form_readback_unverified'})};
    }else{
      const run=adapters.appTask||appTask;
      const response=await withDeadline(()=>run({...plan.task,
        ...(['edit_post','set_control_text'].includes(plan.task.intent)?
          {commit:plan.commit}:{})}),plan.timeout_ms);
      const data=response?.structuredContent;
      const status=data?.status||'outcome_unknown';
      const toolFailed=response?.isError===true;
      // Do not promote a contradictory or tool-level error to verified
      // success, regardless of an adapter's structuredContent payload.
      const unverifiedCompletion=plan.commit&&!readOnly&&status==='completed'&&
        (data?.verified!==true||data?.executed!==true);
      const unverifiedReadOnly=readOnly&&['completed','inspected'].includes(status)&&
        data?.verified!==true;
      const unexpectedReadMutation=readOnly&&data?.executed===true;
      const statusFailure=NON_SUCCESS_STATUSES.has(status);
      const unexpectedFailedMutation=!readOnly&&statusFailure&&data?.executed===true;
      const unexpectedNoopMutation=!readOnly&&status==='already_applied'&&
        data?.executed===true;
      const uncertain=unverifiedCompletion||unexpectedReadMutation||
        unexpectedFailedMutation||unexpectedNoopMutation||(toolFailed&&!readOnly);
      const inspectionUnavailable=readOnly&&(toolFailed||unverifiedReadOnly);
      outcome={status:uncertain?'outcome_unknown':
        inspectionUnavailable?'inspection_unavailable':status,mode:plan.mode,
        app:plan.task.app,intent:plan.task.intent,
        executed:uncertain?null:inspectionUnavailable?false:(data?.executed??false),
        verified:!toolFailed&&!unverifiedCompletion&&!unverifiedReadOnly&&
          !unexpectedReadMutation&&!statusFailure&&!unexpectedNoopMutation&&
          data?.verified===true,
        screenshot_used:false,
        ...(unexpectedReadMutation?{reason:'read_only_adapter_reported_mutation'}:
          unexpectedFailedMutation?{reason:'app_mutation_status_contradiction'}:
          unexpectedNoopMutation?{reason:'app_noop_status_contradiction'}:
          toolFailed?{reason:readOnly?'app_read_only_tool_error':
            'app_action_tool_error_reinspect_before_retry'}:
          unverifiedCompletion?{reason:'app_mutation_readback_unverified'}:
          unverifiedReadOnly?{reason:'app_read_only_readback_unverified'}:
          data?.reason?{reason:String(data.reason).slice(0,160)}:{})};
    }
  }catch(error){
    // A timed-out mutation can still complete in the local adapter.
    // Return unknown, durably journal it and never dispatch a blind retry.
    const timedOut=error===DEADLINE_EXCEEDED;
    outcome={status:timedOut&&readOnly?'inspection_unavailable':'outcome_unknown',
      mode:plan.mode,executed:timedOut&&readOnly?false:null,
      verified:false,screenshot_used:false,
      reason:timedOut?(readOnly?'read_only_operation_timeout':
        'operation_timed_out_reinspect_before_retry'):
        'operation_failed_or_lost_verification_reinspect_before_retry'};
  }
  outcome.elapsed_ms=Math.round((performance.now()-started)*10)/10;
  if(plan.commit){
    try{operationJournal.complete(args.operation_id,fingerprint,outcome);}
    catch{
      // Action may already have succeeded; never claim durability or retry.
      return jsonResult({status:'outcome_unknown',mode:plan.mode,
        executed:null,verified:false,screenshot_used:false,
        reason:'operation_executed_but_journal_commit_not_confirmed'});
    }
  }
  return jsonResult(outcome);
}
