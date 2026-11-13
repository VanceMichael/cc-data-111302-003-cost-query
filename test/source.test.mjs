import test from 'node:test';
import assert from 'node:assert/strict';
import {createSource} from '../src/source.mjs';
import {inspect,readRaw} from '../src/client.mjs';

async function withSource(callback){const source=await createSource();try{return await callback(source);}finally{await source.close();}}
function access(source){return async(path,options={})=>{const response=await fetch(source.url+path,{method:options.method||'GET',body:options.body===undefined?undefined:JSON.stringify(options.body),signal:AbortSignal.timeout(4000)});const text=await response.text();let value=text;try{value=JSON.parse(text);}catch{}return {status:response.status,value};};}
test('来源存活与单次目录读取',()=>withSource(async source=>{const api=access(source);assert.equal((await api('/health')).value.status,'ok');assert.ok(Object.keys(await inspect(source.url)).length>0);assert.ok((await readRaw(source.url,'/inventory')).length>0);}));
test('未知路径与坏控制请求明确拒绝',()=>withSource(async source=>{const api=access(source);assert.equal((await api('/missing')).status,404);const invalid=await fetch(source.url+'/control',{method:'POST',body:'not-json'});assert.equal(invalid.status,400);}));
test('来源领域契约的状态变化',()=>withSource(async source=>{const api=access(source);const result=await api('/query',{method:'POST',body:{ids:['p1'],fields:['name','contact'],role:'reader',capabilityVersion:1,maxCost:5}}); assert.equal(result.value.receipt.cost,4);assert.equal(result.value.errors[0].field,'contact');assert.equal(result.value.records[0].contact,undefined);assert.equal((await api('/query',{method:'POST',body:{capabilityVersion:0}})).status,409);}));

