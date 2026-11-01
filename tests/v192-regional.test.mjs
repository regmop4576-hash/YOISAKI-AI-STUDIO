import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeRegional,regionalMode,hasActiveRegions,exportRegions,makeRegions} from '../src/lib/regional.ts';
import {controlError} from '../src/lib/controlnet.ts';
test('persisted translated modes are repaired without losing IDs, masks, LoRA or prompts',()=>{
 const regions=makeRegions(2);Object.assign(regions[0],{prompt:'  keep\n',lora_id:'b'.repeat(32),trigger:'amber_character',weight:1.15,strokes:[{size:.08,points:[[.1,.2]]}]});
 for(const mode of ['OFF','ВЫКЛ','Выкл']){const s=normalizeRegional({mode,regions});assert.equal(s.mode,'OFF');assert.deepEqual(s.regions,regions);assert.deepEqual(exportRegions(s,512,512),[]);assert.equal(hasActiveRegions(s),false);
  const enabled=regionalMode(s,'2 CHARACTERS');assert.deepEqual(enabled.regions,regions);assert.equal(hasActiveRegions(enabled),true);assert.deepEqual(regionalMode(enabled,'OFF').regions,regions);
 }
 assert.equal(normalizeRegional({mode:'2 ПЕРСОНАЖА',regions}).mode,'2 CHARACTERS');assert.equal(normalizeRegional({mode:'3 ПЕРСОНАЖА',regions}).mode,'3 CHARACTERS');assert.equal(normalizeRegional({mode:'СВОИ ОБЛАСТИ',regions}).mode,'CUSTOM');
 assert.equal(normalizeRegional({mode:'broken',regions}).mode,'OFF');
});
test('all ControlNet types coexist with Regional OFF, and real simultaneous enablement is rejected',()=>{
 for(const type of ['Depth','Canny','OpenPose'])for(const mode of ['OFF','ВЫКЛ','2 CHARACTERS'])for(const controlEnabled of [false,true]){
  const regions=makeRegions(2),s={controlEnabled,controlType:type,controlStrength:.8,controlStart:0,controlEnd:1};
  const error=controlError(s,{type,key:'same'},'same',hasActiveRegions({mode,regions}));
  if(controlEnabled&&mode==='2 CHARACTERS')assert.match(error,/Одновременная/);else assert.equal(error,'');
 }
});
