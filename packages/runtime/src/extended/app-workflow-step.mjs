// One explicitly requested, non-destructive step in a known workflow.
// Every action must have a fresh verified UI inspection and exact policy match.
// Never type content, submit a form, delete, approve, publish or send.
import { inspectGuidedWorkflow } from './app-workflow-inspect.mjs';
import { guidedStepPolicy, chooseGuidedControl, validateGuidedQuery } from './app-workflow-step-policy.mjs';
import { performGuidedBrowserStep } from './app-workflow-browser-step.mjs';
import { uiAction, resultValue } from './desktop-core.mjs';

export async function runGuidedStep(plan,args={},adapters={}) {
  if(plan?.kind!=='guided')throw new Error('The requested destination is not a guided app workflow');
  const policy=guidedStepPolicy(plan.destination,args.step);
  if(!policy)throw new Error('This guided destination does not have the requested safe atomic step');
  const query=validateGuidedQuery(args,policy);
  if(args.inspect===true)throw new Error('Use inspect=true for read-only preview or step for a single allowed action, not both');
  if(args.verify===true)throw new Error('A guided step cannot be treated as verified from dispatch. Inspect the result in a separate call.');
  const inspect=adapters.inspectGuidedWorkflow || inspectGuidedWorkflow;
  const inspection=await inspect(plan,args,adapters);
  if(!inspection?.inspected)return {
    status:'blocked',app:plan.app,destination:plan.destination,step:policy.step,
    reason:inspection?.reason||'inspection_unavailable',executed:false,verified:false,
    ...(inspection?.matching_windows?{matching_windows:inspection.matching_windows}:{}),
    ...(inspection?.matching_tabs?{matching_tabs:inspection.matching_tabs}:{})
  };
  // A native bounded AX/UIA snapshot may conceal duplicate controls. Never
  // infer uniqueness from a truncated tree and never dispatch to it.
  if(!plan.web_only && inspection.window?.truncated===true)return {
    status:'blocked',app:plan.app,destination:plan.destination,step:policy.step,
    reason:'native_snapshot_truncated',executed:false,verified:false,
  };
  const available=plan.web_only?inspection.controls:inspection.window?.controls;
  const chosen=chooseGuidedControl(available,policy);
  if(!chosen.ok)return {
    status:'blocked',app:plan.app,destination:plan.destination,step:policy.step,
    reason:chosen.reason,executed:false,verified:false,
    ...(chosen.count?{matching_controls:chosen.count}:{})
  };
  if(plan.web_only){
    try {
      const execute=adapters.performGuidedBrowserStep || performGuidedBrowserStep;
      const outcome=await execute({plan,inspection,policy,query},adapters);
      if(!outcome?.dispatched)return {status:'blocked',app:plan.app,
        destination:plan.destination,step:policy.step,reason:outcome?.reason||'no_dispatch',
        executed:false,verified:false};
      return {
        status:'dispatched',app:plan.app,destination:plan.destination,step:policy.step,
        executed:true,verified:outcome.verified===true,via:'guarded_browser_dom',
        ...(outcome.target_id?{target_id:outcome.target_id}:{}),
        control:{name:chosen.control.name,role:chosen.control.role},
        ...(query!=null?{query_length:query.length}:{}),
        note:policy.action==='set_query'
          ? 'Search query was entered into the confirmed field without pressing Enter or submitting. The text is omitted from this result; verify the search state separately.'
          : policy.action==='invoke'
          ? 'Only the registered navigation button was clicked. Verify the opened draft/editor with a fresh browser snapshot; no message was sent.'
          : 'The registered text field was focused. No text was inserted. Verify field focus and intended account before typing.'
      };
    } catch {
      return {status:'outcome_unknown',app:plan.app,destination:plan.destination,
        step:policy.step,executed:null,verified:false,
        reason:'browser_action_or_verification_failed',
        note:'A browser action may have been dispatched; inspect the current page before retrying.'};
    }
  }
  // Native UI elements are app- and PID-scoped. Unlike a read-only preview,
  // direct manipulation is refused until the OS reports this window active.
  if(inspection.window?.foreground_verified!==true)return {
    status:'blocked',app:plan.app,destination:plan.destination,step:policy.step,
    reason:'foreground_not_verified',executed:false,verified:false,
    pid:inspection.window?.pid,
  };
  if(!chosen.control.id)return {
    status:'blocked',app:plan.app,destination:plan.destination,step:policy.step,
    reason:'native_element_id_unavailable',executed:false,verified:false,
  };
  if(process.platform==='win32'&&!inspection.window?.window_id)return {
    status:'blocked',app:plan.app,destination:plan.destination,step:policy.step,
    reason:'native_window_handle_unavailable',executed:false,verified:false,
  };
  const act=adapters.uiAction || uiAction;
  try {
    const nativeAction=policy.action==='set_query'?'set_value':policy.action;
    const response=resultValue(await act({
      action:nativeAction,id:chosen.control.id,
      ...(query!=null?{value:query}:{}),
      pid:inspection.window.pid,app:inspection.window.app,
      ...(inspection.window.window_id?{window_id:inspection.window.window_id,
        window_title:inspection.window.window_title}:{}),
      name:chosen.control.name,role:chosen.control.role,
      semantic_only:true,strict_target_id:true
    }));
    const identityMismatch=!response || response.action!==nativeAction ||
      (response.id!=null && response.id!==chosen.control.id) ||
      (response.pid!=null && Number(response.pid)!==Number(inspection.window.pid)) ||
      (response.name!=null && String(response.name).trim().toLowerCase()!==chosen.control.name.trim().toLowerCase()) ||
      (response.role!=null && String(response.role).trim().toLowerCase()!==chosen.control.role.trim().toLowerCase());
    if(identityMismatch || response?.error || response?.success===false ||
      /pointer|coordinate/i.test(String(response?.backend||'')))return {
      status:'outcome_unknown',app:plan.app,destination:plan.destination,
      step:policy.step,executed:null,verified:false,
      reason:'native_action_rejected_or_failed',
    };
    // macOS AX can accept a focus/value setter without changing the target.
    // An explicit negative read-back is an uncertain outcome, never a success.
    if(response.foreground_after===false ||
      (nativeAction==='focus' && response.focused_after===false) ||
      (nativeAction==='set_value' && response.value_matches_after===false))
      return {status:'outcome_unknown',app:plan.app,destination:plan.destination,
        step:policy.step,executed:null,verified:false,
        reason:response.foreground_after===false?'foreground_not_confirmed':
          nativeAction==='focus'?'focus_not_confirmed':'search_text_not_confirmed',
        note:'The OS accepted an action but its immediate read-back did not confirm the intended state. Inspect the current window before retrying.'};
    const verified=response.foreground_after===true &&
      (nativeAction==='focus'?response.focused_after===true:
        nativeAction==='set_value'?response.value_matches_after===true:false);
    return {status:'dispatched',app:plan.app,destination:plan.destination,
      step:policy.step,executed:true,verified,via:'scoped_native_accessibility',
      pid:inspection.window.pid,window_title:inspection.window.window_title,
      control:{name:chosen.control.name,role:chosen.control.role},
      ...(query!=null?{query_length:query.length}:{}),
      note:'Only the registered UI element was acted upon. Verify the resulting app state with a new ui_snapshot.'};
  }catch{
    return {status:'outcome_unknown',app:plan.app,destination:plan.destination,
      step:policy.step,executed:null,verified:false,
      reason:'native_action_or_verification_failed',
      note:'The native UI may have acted before reporting an error. Inspect the app before retrying.'};
  }
}
