#!/usr/bin/env node
// Tests with a fake AudioContext and synthetic audio, never copyrighted samples.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const out = await build({entryPoints:['src/audio/rack/NpnoLayerVoice.ts'],bundle:true,platform:'node',format:'cjs',write:false});
const module={exports:{}};
new Function('module','exports','require',out.outputFiles[0].text)(module,module.exports,()=>{throw Error('unexpected require')});
const { NpnoLayerVoice } = module.exports;
class P { value=0; events=[]; setValueAtTime(v,t){this.value=v;this.events.push(['set',v,t])} linearRampToValueAtTime(v,t){this.value=v;this.events.push(['ramp',v,t])} cancelScheduledValues(){} setTargetAtTime(v){this.value=v} }
class Node { connect(){} disconnect(){this.disconnected=true} }
class Source extends Node { playbackRate=new P(); buffer=null; starts=[]; stops=[]; start(t){this.starts.push(t)} stop(t){this.stops.push(t)} }
class Gain extends Node {gain=new P()}
class Context { currentTime=1; sources=[]; gains=[]; createGain(){let g=new Gain();this.gains.push(g);return g} createBufferSource(){let s=new Source();this.sources.push(s);return s} }
const ctx=new Context();const voice=new NpnoLayerVoice(ctx);
const attack={name:'ataque'}, releaseForte={name:'release forte'}, releaseSuave={name:'release suave'};
voice.rootMap.set(60,{attack:[{layer:0,buffer:attack}],release:[{layer:0,buffer:releaseForte},{layer:20,buffer:releaseSuave}]});
voice.keyMap[62]=60;
voice.noteOn(62,127);assert.equal(ctx.sources.length,1);assert.equal(ctx.sources[0].buffer,attack);
voice.noteOff(62);assert.equal(ctx.sources.length,2);assert.equal(ctx.sources[1].buffer,releaseForte);assert.ok(Math.abs(ctx.sources[1].playbackRate.value-2**(2/12))<1e-8);assert.equal(ctx.sources[1].starts.length,1);
voice.noteOff(62);assert.equal(ctx.sources.length,2,'note-off duplicado');
voice.noteOn(62,30);voice.noteOff(62);assert.equal(ctx.sources[3].buffer,releaseSuave,'camada da soltura segue velocity de ataque');
voice.noteOn(62,100);voice.noteOn(62,90);assert.equal(ctx.sources.length,6,'retoque não dispara soltura');
voice.setPitchBend(2);assert.ok(ctx.sources[1].playbackRate.value>2**(2/12));
voice.allNotesOff();assert.equal(voice.releaseVoices.size,0);assert.ok(ctx.sources[1].stops.length);
voice.rootMap.set(61,{attack:[{layer:0,buffer:attack}],release:[]});voice.keyMap[61]=61;voice.noteOn(61,90);const n=ctx.sources.length;voice.noteOff(61);assert.equal(ctx.sources.length,n,'sem sample release, sem áudio artificial');voice.dispose();
console.log('ok - amostras de soltura, camada, transposição, duplicata, retoque, pitch bend e limpeza');

// Decode the real repository fixture using the shipped WebAssembly decoder.
// The fixture is synthetic and contains both attack and release strokes.
const fs=await import('node:fs');
const wasm=await import('../public/vendor/npno-wasm/npno_wasm.js');
await wasm.default({module_or_path:fs.readFileSync('public/vendor/npno-wasm/npno_wasm_bg.wasm')});
globalThis.__fixtureNord={npno_decode: wasm.npno_decode};
const withFixture=await build({entryPoints:['src/audio/rack/NpnoLayerVoice.ts'],bundle:true,platform:'node',format:'cjs',write:false,plugins:[{name:'fixture-nord-wasm',setup(b){b.onResolve({filter:/npnoWasmModule$/},()=>({path:'nord',namespace:'fake'}));b.onLoad({filter:/.*/,namespace:'fake'},()=>({contents:'export async function loadNordWasmModule(){return globalThis.__fixtureNord}',loader:'js'}))}}]});
const m={exports:{}};new Function('module','exports','require',withFixture.outputFiles[0].text)(m,m.exports,()=>{});
class FixtureContext extends Context {createBuffer(ch,frames,rate){const arrays=Array.from({length:ch},()=>new Float32Array(frames));return {numberOfChannels:ch,length:frames,sampleRate:rate,getChannelData:i=>arrays[i]}}}
const context=new FixtureContext(), player=new m.exports.NpnoLayerVoice(context);
const data=fs.readFileSync('test-fixtures/synthetic-test-piano.npno'); await player.load(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength));
player.noteOn(60,100);player.noteOff(60);assert.equal(context.sources.length,2);assert.ok(context.sources[1].buffer.getChannelData(0).some(v=>v!==0),'áudio real de soltura não é silêncio');player.dispose();
console.log('ok - fixture .npno sintética decodificada por WASM dispara áudio de soltura real');
