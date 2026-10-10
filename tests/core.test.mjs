import test from 'node:test';
import assert from 'node:assert/strict';
import { UploadError, retryCaptcha, SerialQueue, replacement, classifyError, parseModel, normalizeTopology, uploadHost, uploadedURL, buildUploadForm } from '../src/core.mjs';

test('首次失败后最多重试5次，只有5个1000ms间隔', async () => {
  let calls = 0; const waits = [], retries = [];
  await assert.rejects(retryCaptcha(async () => { calls++; throw new UploadError('wrong', 'captcha'); }, {
    wait: async ms => waits.push(ms), onRetry: index => retries.push(index),
  }), error => error.kind === 'captcha-exhausted' && error.message.includes('5'));
  assert.equal(calls, 6); assert.deepEqual(waits, [1000, 1000, 1000, 1000, 1000]); assert.deepEqual(retries, [1, 2, 3, 4, 5]);
});
test('验证码第三次成功后立即返回，无额外尝试', async () => {
  let calls = 0;
  const result = await retryCaptcha(async () => { if (++calls < 3) throw new UploadError('wrong', 'captcha'); return 'link'; }, { wait: async () => {} });
  assert.equal(result, 'link'); assert.equal(calls, 3);
});
test('网络、权限、模型失败不消耗验证码重试', async () => {
  for (const kind of ['network', 'server', 'model', 'rate', 'login']) {
    let calls = 0;
    await assert.rejects(retryCaptcha(async () => { calls++; throw new UploadError(kind, kind); }), e => e.kind === kind);
    assert.equal(calls, 1);
  }
});
test('取消后不开始下一次验证码尝试', async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(retryCaptcha(async () => { calls++; throw new UploadError('wrong', 'captcha'); }, {
    signal: controller.signal, wait: async () => controller.abort(),
  }), e => e.kind === 'cancelled');
  assert.equal(calls, 1);
});
test('并行入队仍串行执行，单个失败后继续', async () => {
  const queue = new SerialQueue(), trace = [];
  const results = await Promise.allSettled([1, 2, 3].map(index => queue.add(async () => {
    trace.push(`start${index}`); await new Promise(resolve => setTimeout(resolve, 5)); trace.push(`end${index}`);
    if (index === 2) throw new Error('failed'); return index;
  })));
  assert.deepEqual(trace, ['start1','end1','start2','end2','start3','end3']);
  assert.deepEqual(results.map(r => r.status), ['fulfilled','rejected','fulfilled']);
});
test('只替换占位符，保留后续输入，并映射光标', () => {
  const next = replacement('开始[TOKEN]后续输入', '[TOKEN]', '![](url)', 17, 17);
  assert.equal(next.value, '开始![](url)后续输入'); assert.equal(next.start, 18);
  assert.equal(replacement('已删除', '[TOKEN]', 'url'), null);
  assert.equal(replacement('[TOKEN]复制[TOKEN]', '[TOKEN]', 'url'), null);
});
test('错误分类不把通用403当验证码错误', () => {
  assert.equal(classifyError({errorMessage:'没有权限'},403).kind, 'server');
  assert.equal(classifyError({errorMessage:'验证码错误'},403).kind, 'captcha');
  assert.equal(classifyError({errorMessage:'form invalid',errorData:{errors:{captcha:'wrong'}}},400).kind, 'captcha');
  assert.equal(classifyError({errorMessage:'验证码错误，请求过于频繁'},429).kind, 'rate');
  assert.equal(classifyError({},401).kind, 'login');
});
test('解析模型数据不执行资源中的任意JS', () => {
  const source = 'globalThis.bad = true; const MODEL_TOPOLOGY = {"config":{"layers":[]}}; const WEIGHT_SPECS = []; const WEIGHTS_BASE64 = "AAAA";';
  const model = parseModel(source);
  assert.equal(model.WEIGHTS_BASE64, 'AAAA'); assert.equal(globalThis.bad, undefined);
  assert.throws(() => parseModel('const MODEL_TOPOLOGY = (() => { globalThis.bad = true; })();'), e => e.kind === 'model');
});
test('兼容Keras模型结构时不修改原数据', () => {
  const original = {model_config:{class_name:'Functional',config:{layers:[{class_name:'InputLayer',config:{batch_shape:[null,35,90,3],dtype:{config:{name:'mixed_float16'}}},inbound_nodes:[]}],input_layers:['input',0,0],output_layers:['out',0,0]}}};
  const topo = normalizeTopology(original);
  assert.equal(topo.model_config.class_name, 'Model'); assert.equal(topo.model_config.config.layers[0].config.dtype, 'float32');
  assert.deepEqual(topo.model_config.config.input_layers,[['input',0,0]]); assert.equal(original.model_config.class_name, 'Functional');
});
test('存储域名限制及HTTPS升级', () => {
  assert.equal(uploadHost('luogu.oss-cn-hangzhou.aliyuncs.com'), 'https://luogu.oss-cn-hangzhou.aliyuncs.com/');
  assert.equal(uploadHost('http://upload.luogu.com.cn/path'), 'https://upload.luogu.com.cn/path');
  for (const host of ['evil.test','https://luogu.com.cn.evil.test','https://user:pass@luogu.com.cn','https://luogu.com.cn:8000']) assert.throws(() => uploadHost(host));
});
test('当前存储回调响应转换为Markdown可用地址', () => {
  assert.equal(uploadedURL({success:true,response:JSON.stringify({file:{url:'https://cdn.luogu.com.cn/upload/image_hosting/a(b).png'}})}), 'https://cdn.luogu.com.cn/upload/image_hosting/a%28b%29.png');
  assert.throws(() => uploadedURL({success:false,response:'{"errorMessage":"配额不足"}'}), e=>e.kind==='server');
  assert.throws(() => uploadedURL({success:true,response:'{}'}), e=>e.kind==='uncertain');
});
test('签名字段按接口返回构造，文件最后加入且不覆盖key', () => {
  const file = new File(['hello'], 'foo%bar.png', {type:'image/png'});
  const form = buildUploadForm(file,{host:'upload.luogu.com.cn',dir:'prefix/',fields:{policy:'signed',key:'bad',file:'bad'}});
  assert.equal(form.get('key'),'prefix/foo_bar.png'); assert.equal(form.get('policy'),'signed'); assert.equal(form.get('file').size,5);
  assert.equal([...form.keys()].at(-1), 'file');
});
