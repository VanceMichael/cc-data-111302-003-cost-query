import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

export function json(response,value,status=200){response.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});response.end(JSON.stringify(value));}
export async function createSource({port=0,host='127.0.0.1'}={}){
  const state=JSON.parse(await readFile(new URL('../fixtures/source.json',import.meta.url),'utf8'));
  
  const pages={};
  const server=http.createServer(async(request,response)=>{
    try{
      const url=new URL(request.url,'http://local.test');let text='';
      for await(const chunk of request){text+=chunk;if(text.length>8*1024*1024){json(response,{error:'控制请求过大'},413);return;}}
      let body={};if(text){try{body=JSON.parse(text);}catch{return json(response,{error:'JSON无效'},400);}}
      if(url.pathname==='/health')return json(response,{status:'ok'});
      if(url.pathname==='/state'||url.pathname==='/inventory')return json(response,state);
      if(url.pathname==='/control'&&request.method==='POST'){if(body.costChange) Object.assign(state.fields,body.costChange); if(body.bumpVersion) state.capabilityVersion++; if(body.deniedFields) state.deniedFields=body.deniedFields; return json(response,state);}
      if(Object.hasOwn(pages,url.pathname)){response.setHeader('Content-Type','text/html; charset=utf-8');return response.end(await readFile(new URL('../public/'+pages[url.pathname],import.meta.url)));}
      
    if (url.pathname === '/organizations/org1') return json(response,{id:'org1',name:'联合机构',version:state.capabilityVersion});
    if (url.pathname === '/query' && request.method==='POST') {
      if(body.capabilityVersion!==state.capabilityVersion) return json(response,{error:'能力版本不符'},409);
      if(!Array.isArray(body.ids)||!Array.isArray(body.fields)||body.fields.some(field=>!state.fields[field])) return json(response,{error:'字段无效'},400);
      if(body.fields.some(field=>(state.dependencies[field]||[]).some(required=>!body.fields.includes(required))))return json(response,{error:'缺少字段依赖'},422);
      if(state.incompatible.some(pair=>pair.every(field=>body.fields.includes(field))))return json(response,{error:'互斥展开'},422);
      const cost=body.ids.length*body.fields.reduce((sum,field)=>sum+state.fields[field],0);
      if(cost>body.maxCost) return json(response,{cost,error:'报价超限'},402);
      const errors=[];const records=state.entities.filter(entity=>body.ids.includes(entity.id)).map(entity=>{const record={id:entity.id};for(const field of body.fields){if(state.deniedFields.includes(field)||(field==='contact'&&body.role!=='admin')) errors.push({id:entity.id,field,reason:'暂不可用'});else record[field]=entity[field];}return record;});
      const receipt={id:`q-${state.receipts.length+1}`,cost,role:body.role};state.receipts.push(receipt);return json(response,{records,errors,receipt});
    }

      return json(response,{error:'资源不存在'},404);
    }catch(error){if(!response.headersSent)json(response,{error:error.message},500);else response.destroy();}
  });
  await new Promise(resolve=>server.listen(port,host,resolve));
  return {url:`http://127.0.0.1:${server.address().port}`,state,close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
