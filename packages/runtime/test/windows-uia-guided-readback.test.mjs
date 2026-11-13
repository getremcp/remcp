// Windows strict native UIA attestation across the guided workflow facade.
import test from 'node:test';
import assert from 'node:assert/strict';
import {runGuidedStep} from '../src/extended/app-workflow-step.mjs';
import {planAppNavigation} from '../src/extended/app-navigation.mjs';

test('Windows strict UIA guided search accepts only verified foreground and text readback',async()=>{
  const plan=planAppNavigation({app:'thunderbird',destination:'find_email'},{platform:'win32'});
  const field={id:'win:42.12.7',role:'Edit',name:'Search'};
  const win={pid:72,app:'thunderbird',window_title:'Thunderbird',window_id:'0x420',
    foreground_verified:true,controls:[field]};
  const phrase='private search: QA only';
  const run=async(foreground_after,value_matches_after)=>{
    return runGuidedStep(plan,{step:'set_search_query',query:phrase},{
      inspectGuidedWorkflow:async()=>({inspected:true,window:win}),
      uiAction:async args=>{
        assert.equal(args.action,'set_value');
        assert.equal(args.strict_target_id,true);
        assert.equal(args.value,phrase);
        assert.equal(args.window_id,'0x420');
        return {structuredContent:{action:'set_value',id:field.id,pid:72,
          name:field.name,role:field.role,backend:'ValuePattern',
          foreground_after,value_matches_after}};
      },
    });
  };
  const ok=await run(true,true);
  assert.equal(ok.status,'dispatched');
  assert.equal(ok.verified,true);
  assert.equal(ok.executed,true);
  const lost=await run(false,true);
  assert.equal(lost.status,'outcome_unknown');
  assert.equal(lost.reason,'foreground_not_confirmed');
  const reverted=await run(true,false);
  assert.equal(reverted.status,'outcome_unknown');
  assert.equal(reverted.reason,'search_text_not_confirmed');
  for(const result of [ok,lost,reverted])
    assert.ok(!JSON.stringify(result).includes(phrase));
});
