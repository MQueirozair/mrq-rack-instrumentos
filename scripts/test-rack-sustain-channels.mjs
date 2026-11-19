#!/usr/bin/env node
import assert from 'node:assert/strict';import {build} from 'esbuild';
const calls=[];globalThis.window={};globalThis.__fakeRack={noteOn:(...x)=>calls.push(['on',...x]),noteOff:(...x)=>calls.push(['off',...x]),setPitchBend:(...x)=>calls.push(['bend',...x])};
const result=await build({entryPoints:['src/midi/rackMidiRouter.ts'],bundle:true,platform:'node',format:'cjs',write:false,plugins:[{name:'mock-rack',setup(b){b.onResolve({filter:/RackEngine$/},()=>({path:'rack',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const rackEngine = globalThis.__fakeRack',loader:'js'}))}}]});
const mod={exports:{}};new Function('module','exports','require',result.outputFiles[0].text)(mod,mod.exports,require=>require);const send=window.__rackMidiTestDispatch;
send([0xb0,64,127]);send([0x90,60,100]);send([0x80,60,0]);assert.equal(calls.filter(x=>x[0]==='off').length,0);
send([0x91,62,100]);send([0x81,62,0]);assert.deepEqual(calls.at(-1),['off',62,2],'canal 2 não fica preso pelo pedal do canal 1');
send([0xb0,64,0]);assert.deepEqual(calls.at(-1),['off',60,1],'solta somente canal original');
send([0xb1,64,127]);send([0x91,65,90]);send([0x81,65,0]);send([0x91,65,100]);send([0xb1,64,0]);assert.notDeepEqual(calls.at(-1),['off',65,2],'retoque mantém nota nova');
send([0xb1,64,127]);send([0x81,65,0]);mod.exports.setRackSustainEnabled(false);assert.deepEqual(calls.at(-1),['off',65,2],'desativar pedal libera notas');
console.log('ok - sustain por canal, pedal, retoque e desativação');
