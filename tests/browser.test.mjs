import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

// Small host fixture runs the entire generated userscript, including paste
// handling, model initialization, fetch, storage request and editor events.
// No live account, uploads, or external services are used here.
async function fixture({ storageFailure = false, delayUpload = false, companionCache = false } = {}) {
  const calls = [], listeners = {}, nodes = [];
  class Element {
    constructor(tag = 'DIV') { this.tagName=tag.toUpperCase(); this.children=[]; this.attrs={}; this.isConnected=true; this.textContent=''; }
    append(...children) { this.children.push(...children); }
    setAttribute(key,value) { this.attrs[key]=value; }
    getAttribute(key) { return this.attrs[key] || null; }
    closest() { return null; }
    replaceChildren(...children) { this.children=children; }
    remove() { this.isConnected=false; }
    isSameNode(other) { return this===other; }
  }
  class TextArea extends Element {
    constructor() { super('textarea'); this._value='初始文字'; this.selectionStart=this.selectionEnd=4; this.name='message'; this.id='message'; this.events=[]; }
    get value() { return this._value; } set value(value) { this._value=value; }
    setRangeText(text, start, end) { this.value=this.value.slice(0,start)+text+this.value.slice(end); this.selectionStart=this.selectionEnd=start+text.length; }
    setSelectionRange(start,end) { this.selectionStart=start; this.selectionEnd=end; }
    dispatchEvent(event) { this.events.push(event.type); return true; }
  }
  const textarea = new TextArea();
  const wrappers = [];
  const document = {
    body:new Element('body'),
    createElement(tag) { const node=new Element(tag); nodes.push(node); if(tag==='canvas') node.getContext=()=>({drawImage(){}}); return node; },
    querySelector(selector) { if(selector.includes('csrf-token')) return {content:'test-csrf'}; if(selector.includes('lentille-context')) return {textContent:'{"user":{"uid":1}}'}; return null; },
    querySelectorAll(selector) { return selector === '.cm-editor' ? wrappers : []; },
    execCommand() { return false; },
    addEventListener(name,handler) { listeners[name]=handler; },
  };
  const cache = new Map([['lgpi:model:data:v1', {MODEL_TOPOLOGY:{model_config:{class_name:'Model',config:{layers:[]}}},WEIGHT_SPECS:[],WEIGHTS_BASE64:'AAAA'}]]);
  const companion = `const MODEL_TOPOLOGY = {"model_config":{"class_name":"Model","config":{"layers":[]}}}; const WEIGHT_SPECS = []; const WEIGHTS_BASE64 = "AAAA";`;
  if(companionCache) cache.clear();
  let finishUpload;
  class XHR {
    constructor() { this.upload={}; }
    open(method,url) { this.url=url; this.method=method; }
    send(form) {
      calls.push({type:'storage',url:this.url,method:this.method,form,credentials:this.withCredentials});
      finishUpload=()=>{ this.status=storageFailure?503:200; this.responseText=JSON.stringify({success:true,response:JSON.stringify({file:{url:'https://cdn.luogu.com.cn/upload/image_hosting/test.png'}})}); this.onload(); };
      if(!delayUpload) setTimeout(finishUpload,0);
    }
    abort() { this.onabort(); }
  }
  class Image { set src(value) { setTimeout(()=>this.onload(),0); } }
  class InputEvent { constructor(type) { this.type=type; } }
  const tensor = {toFloat(){return this;},div(){return this;},expandDims(){return this;}};
  const model = {inputs:[{shape:[null,35,90,3]}],outputs:[{shape:[null,4,35]}],predict(){return {argMax(){return {dataSync(){return [0,1,2,3];}}}}},dispose(){}};
  const context = vm.createContext({
    document, window:{document, ...(companionCache?{GM_getValue:key=>key==='OCRCaptchaCode'?companion:undefined}:{})}, Element, HTMLTextAreaElement:TextArea, InputEvent, Event:InputEvent,
    Image, XMLHttpRequest:XHR, File, FormData, Blob, URL, AbortController, crypto:webcrypto, atob, console,
    setTimeout, clearTimeout,
    tf:{loadLayersModel:async()=>model,io:{fromMemory:data=>data},tidy:fn=>fn(),browser:{fromPixels:()=>tensor}},
    GM_getValue:(key,fallback)=>cache.has(key)?cache.get(key):fallback,
    GM_setValue:(key,value)=>cache.set(key,value), GM_deleteValue:key=>cache.delete(key),
    GM_registerMenuCommand(){}, GM_setClipboard(){}, GM_addStyle(){},
    GM_xmlhttpRequest(){throw new Error('Cached model should avoid network');},
    fetch:async(url,options)=>{
      calls.push({type:'fetch',url,options});
      if(url.startsWith('/lg4/captcha')) return new Response(new Blob(['mock-image'],{type:'image/png'}));
      assert.equal(url,'/image/upload');
      return new Response(JSON.stringify({uploadLink:{host:'upload.luogu.com.cn',dir:'img/',fields:{policy:'signed',signature:'signed'}}}),{headers:{'Content-Type':'application/json'}});
    },
  });
  vm.runInContext(await fs.readFile('luogu-paste-image.user.js','utf8'),context);
  function paste({image=true,text='',target=textarea}={}) {
    const file=new File(['image'],'image.png',{type:'image/png'});
    const event={defaultPrevented:false,target,clipboardData:{items:image?[{kind:'file',type:'image/png',getAsFile:()=>file}]:[],files:[],getData:()=>text},composedPath:()=>[target],preventDefault(){this.defaultPrevented=true;},stopImmediatePropagation(){this.stopped=true;}};
    listeners.paste(event);return event;
  }
  const until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,5));}throw new Error('fixture timeout');};
  function cm6(initial='Markdown文字') {
    const wrapper = new Element('div'), content = new Element('div');
    wrapper.closest = selector => selector.includes('.cs-editor') ? wrapper : null;
    content.closest = selector => selector === '.cm-editor' ? wrapper : null;
    content.contentEditable='true'; wrapper.querySelector = () => content;
    let text=initial;
    const view={state:{doc:{toString:()=>text},selection:{main:{from:text.length,to:text.length}}},dispatch(transaction){
      const {from,to,insert}=transaction.changes; text=text.slice(0,from)+insert+text.slice(to);
      if(transaction.selection) view.state.selection.main={from:transaction.selection.anchor,to:transaction.selection.anchor};
    }};
    content.cmView={rootView:{view}}; wrappers.push(wrapper);
    return {content,wrapper,view,value:()=>text};
  }
  return {textarea,calls,paste,until,finish:()=>finishUpload(),nodes,cm6};
}

test('完整粘贴到上传流程使用当前协议并插入Markdown', async()=>{
  const f=await fixture();const event=f.paste({text:'保留剪贴板文字'});
  assert.equal(event.defaultPrevented,true);
  await f.until(()=>f.textarea.value.includes('![]('));
  assert.match(f.textarea.value,/初始文字保留剪贴板文字\n!\[\]\(https:\/\/cdn.luogu.com.cn/);
  const credentials=f.calls.find(c=>c.url==='/image/upload');
  assert.equal(credentials.options.method,'POST');assert.equal(credentials.options.credentials,'same-origin');
  assert.deepEqual(JSON.parse(credentials.options.body),{captcha:'abcd',watermarkType:1});
  assert.equal(credentials.options.headers['X-CSRF-TOKEN'],'test-csrf');
  const storage=f.calls.find(c=>c.type==='storage');
  assert.equal(storage.credentials,false);assert.equal(storage.url,'https://upload.luogu.com.cn/');assert.equal(storage.form.get('policy'),'signed');
  assert.ok(f.textarea.events.includes('input'));assert.ok(f.textarea.events.includes('change'));
});
test('上传期间输入的文字和光标位置得到保留', async()=>{
  const f=await fixture({delayUpload:true});f.paste();await f.until(()=>f.calls.some(c=>c.type==='storage'));
  f.textarea.value+='上传期间输入';f.textarea.selectionStart=f.textarea.selectionEnd=f.textarea.value.length;
  f.finish();await f.until(()=>f.textarea.value.includes('![]('));
  assert.ok(f.textarea.value.endsWith('上传期间输入'));assert.equal(f.textarea.selectionStart,f.textarea.value.length);
});
test('上传期间删除占位符不把图片插入其他位置', async()=>{
  const f=await fixture({delayUpload:true});f.paste();await f.until(()=>f.calls.some(c=>c.type==='storage'));
  f.textarea.value='用户已经删除占位符';f.finish();await new Promise(r=>setTimeout(r,10));
  assert.equal(f.textarea.value,'用户已经删除占位符');
  assert.ok(f.nodes.some(node=>node.textContent.includes('请复制链接')));
});
test('普通文字粘贴不接管，禁用编辑器不上传', async()=>{
  const f=await fixture();assert.equal(f.paste({image:false,text:'hello'}).defaultPrevented,false);
  f.textarea.disabled=true;assert.equal(f.paste().defaultPrevented,false);assert.equal(f.calls.length,0);
});
test('存储失败不会重复发送图片，失败占位符保留', async()=>{
  const f=await fixture({storageFailure:true});f.paste();await f.until(()=>f.textarea.value.includes('图片上传失败'));
  assert.equal(f.calls.filter(c=>c.type==='storage').length,1);assert.ok(!f.textarea.value.includes('![]('));
});
test('洛谷当前Casketstar/CodeMirror6编辑器使用事务插入', async()=>{
  const f=await fixture();const editor=f.cm6();const event=f.paste({target:editor.content});
  assert.equal(event.defaultPrevented,true);await f.until(()=>editor.value().includes('![]('));
  assert.ok(editor.value().startsWith('Markdown文字![]('));
});
test('已有Amazing Luogu模型缓存可以复用而无需下载', async()=>{
  const f=await fixture({companionCache:true});f.paste();await f.until(()=>f.textarea.value.includes('![]('));
  assert.equal(f.calls.filter(c=>c.type==='storage').length,1);
});
test('排队任务取消后立即移除占位符且不发送图片', async()=>{
  const f=await fixture({delayUpload:true});f.paste();await f.until(()=>f.calls.some(c=>c.type==='storage'));
  f.paste();assert.equal((f.textarea.value.match(/图片上传中/g)||[]).length,2);
  f.nodes.filter(node=>node.textContent==='取消').at(-1).onclick();
  assert.equal((f.textarea.value.match(/图片上传中/g)||[]).length,1);
  f.finish();await f.until(()=>f.textarea.value.includes('![]('));await new Promise(r=>setTimeout(r,10));
  assert.equal(f.calls.filter(c=>c.type==='storage').length,1);
});
