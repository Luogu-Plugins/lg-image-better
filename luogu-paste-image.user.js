// ==UserScript==
// @name         洛谷粘贴图片自动上传
// @namespace    luogu-paste-image.local
// @version      0.1.0
// @description  在洛谷文字编辑区粘贴图片，自动识别验证码并上传图床；失败最多重试5次，间隔1秒。
// @match        https://www.luogu.com.cn/*
// @match        https://www.luogu.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @grant        unsafeWindow
// @connect      cdn.amlg.top
// @require      https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js
// @license      MIT
// ==/UserScript==

(() => {
'use strict';
class UploadError extends Error {
  constructor(message, kind = 'other') { super(message); this.name = 'UploadError'; this.kind = kind; }
}

function abortIfNeeded(signal) {
  if (signal?.aborted) throw new UploadError('已取消', 'cancelled');
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    abortIfNeeded(signal);
    const cancel = () => { clearTimeout(timer); reject(new UploadError('已取消', 'cancelled')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

function classifyError(data, status = 0) {
  const message = data?.errorMessage || data?.message || `请求失败（HTTP ${status}）`;
  const type = String(data?.errorType || '');
  if (status === 401 || /UserUnlogin|未登录|请先登录|登录失效/.test(type + message)) return new UploadError('请先登录洛谷，再重试上传。', 'login');
  if (status === 429 || /限流|频繁|稍后再试|TooManyRequests/.test(type + message)) return new UploadError(message, 'rate');
  // A captcha field in form errors is explicit evidence; generic 403/400 is not.
  const fields = data?.errorData;
  const captchaField = fields && (fields.captcha || fields.errors?.captcha);
  if (captchaField || /Captcha|验证码.*(?:错误|不正确|无效|过期)|(?:错误|无效|过期).*验证码/i.test(type + message)) return new UploadError(message, 'captcha');
  return new UploadError(message, 'server');
}

async function retryCaptcha(attempt, { signal, retries = 5, wait = sleep, onRetry = () => {} } = {}) {
  for (let index = 0; index <= retries; index++) {
    abortIfNeeded(signal);
    try { return await attempt(index); }
    catch (error) {
      abortIfNeeded(signal);
      if (error?.kind !== 'captcha') throw error;
      if (index === retries) throw new UploadError(`验证码识别失败，已重试 ${retries} 次。`, 'captcha-exhausted');
      onRetry(index + 1, retries);
      await wait(1000, signal);
    }
  }
}

class SerialQueue {
  pending = [];
  running = false;
  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length) {
        const task = this.pending.shift();
        try { task.resolve(await task.run()); } catch (error) { task.reject(error); }
      }
    } finally { this.running = false; }
  }
  add(run) {
    const promise = new Promise((resolve, reject) => this.pending.push({ run, resolve, reject }));
    void this.drain();
    return promise;
  }
}

// Read JSON literals out of the reference resource; never execute downloaded JS.
function readLiteral(source, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*`).exec(source);
  if (!match) throw new UploadError(`模型缺少 ${name}`, 'model');
  const start = match.index + match[0].length;
  let depth = 0, quote = null, escaped = false;
  const first = source[start];
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) {
        quote = null;
        if (depth === 0) {
          const literal = source.slice(start, i + 1);
          if (first === "'") {
            const inner = literal.slice(1, -1);
            if (!/^[A-Za-z0-9+/=\r\n]*$/.test(inner)) break;
            return inner.replace(/[\r\n]/g, '');
          }
          try { return JSON.parse(literal); } catch { break; }
        }
      }
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      if (--depth === 0) {
        try { return JSON.parse(source.slice(start, i + 1)); } catch { break; }
      }
    } else if (depth === 0) break;
  }
  throw new UploadError(`模型 ${name} 不是受支持的 JSON 数据`, 'model');
}

function parseModel(source) {
  let data;
  try { data = JSON.parse(source); } catch {
    data = { MODEL_TOPOLOGY: readLiteral(source, 'MODEL_TOPOLOGY'), WEIGHT_SPECS: readLiteral(source, 'WEIGHT_SPECS'), WEIGHTS_BASE64: readLiteral(source, 'WEIGHTS_BASE64') };
  }
  if (!data?.MODEL_TOPOLOGY || !Array.isArray(data.WEIGHT_SPECS) || typeof data.WEIGHTS_BASE64 !== 'string' || !/^[A-Za-z0-9+/=\s]+$/.test(data.WEIGHTS_BASE64)) throw new UploadError('模型数据格式不正确', 'model');
  return data;
}

function normalizeTopology(original) {
  const topo = JSON.parse(JSON.stringify(original));
  const root = topo.model_config || topo;
  const config = root.config;
  if (!Array.isArray(config?.layers)) throw new UploadError('模型缺少 layers', 'model');
  if (root.class_name === 'Functional') root.class_name = 'Model';
  for (const layer of config.layers) {
    if (layer.class_name === 'InputLayer' && layer.config.batch_shape && !layer.config.batchInputShape) {
      layer.config.batchInputShape = layer.config.batch_shape;
      delete layer.config.batch_shape;
    }
    if (Array.isArray(layer.inbound_nodes)) layer.inbound_nodes = layer.inbound_nodes.map(node => {
      if (Array.isArray(node)) return node;
      return (node?.args || []).map(arg => {
        const history = arg?.config?.keras_history;
        return Array.isArray(history) ? [...history, node.kwargs || {}] : null;
      }).filter(Boolean);
    });
    if (layer.config?.dtype && typeof layer.config.dtype === 'object') {
      const name = layer.config.dtype.config?.name;
      layer.config.dtype = name === 'mixed_float16' ? 'float32' : name || 'float32';
    }
  }
  for (const key of ['input_layers', 'output_layers']) if (config[key]?.length && !Array.isArray(config[key][0])) config[key] = [config[key]];
  return topo;
}

function uploadHost(host) {
  const url = new URL(host.startsWith('//') ? `https:${host}` : host.includes('://') ? host : `https://${host}`);
  const allowed = /^(?:[a-z0-9-]+\.)*(?:luogu\.com\.cn|luogu\.com)$/.test(url.hostname) || /^luogu(?:private)?\.oss-cn-[a-z0-9-]+\.aliyuncs\.com$/.test(url.hostname);
  if (!allowed || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && url.port !== '443')) throw new UploadError('图床返回了未支持的上传域名', 'protocol');
  url.protocol = 'https:';
  return url.href;
}

function buildUploadForm(file, link, Form = FormData) {
  if (!link || typeof link.dir !== 'string' || !link.host) throw new UploadError('上传凭据格式不正确', 'protocol');
  const name = file.name.replace(/%/g, '_');
  const form = new Form();
  form.append('key', link.dir + name);
  form.append('name', name);
  const fields = link.fields || { signature: link.signature, callback: link.callback, success_action_status: '200', OSSAccessKeyID: link.accessKeyID, policy: link.policy, ...link._extra };
  if (!Object.keys(fields).length) throw new UploadError('上传凭据为空', 'protocol');
  for (const [key, value] of Object.entries(fields)) if (!['file', 'key', 'name'].includes(key) && value != null) form.append(key, String(value));
  form.append('file', file);
  return form;
}

function uploadedURL(payload) {
  if (payload && 'success' in payload) {
    let callback;
    try { callback = typeof payload.response === 'string' ? JSON.parse(payload.response) : payload.response; }
    catch { throw new UploadError('上传回调无法解析，请到图床检查结果', 'uncertain'); }
    if (!payload.success) throw classifyError(callback, callback?.errorCode);
    payload = callback;
  }
  const raw = payload?.file?.url || payload?.data?.file?.url;
  let url;
  try { url = new URL(raw); } catch { throw new UploadError('上传已返回，但缺少图片地址；请到图床检查结果', 'uncertain'); }
  if (url.protocol !== 'https:' || !/^(?:[a-z0-9-]+\.)*luogu\.com(?:\.cn)?$/.test(url.hostname)) throw new UploadError('上传返回的图片地址不符合预期', 'protocol');
  return url.href.replace(/\(/g, '%28').replace(/\)/g, '%29');
}

function replacement(value, token, text, start = 0, end = start) {
  const at = value.indexOf(token);
  if (at < 0 || value.indexOf(token, at + token.length) >= 0) return null;
  const after = at + token.length, delta = text.length - token.length;
  const shift = pos => pos <= at ? pos : pos >= after ? pos + delta : at + text.length;
  return { value: value.slice(0, at) + text + value.slice(after), start: shift(start), end: shift(end), at };
}

/* global tf, GM_xmlhttpRequest, GM_getValue, GM_setValue, GM_deleteValue,
          GM_registerMenuCommand, GM_setClipboard, GM_addStyle, unsafeWindow */
const MODEL_URL = 'https://cdn.amlg.top/amlg/OCRCaptcha.js';
const MODEL_KEY = 'lgpi:model:data:v1';
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz123456789';
const queue = new SerialQueue();
const tasks = new Map();
let enabled = GM_getValue('lgpi:enabled', true);
let modelPromise = null;
let panel, list, summary;
const page = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;

function getModelResource(signal) {
  return new Promise((resolve, reject) => {
    abortIfNeeded(signal);
    const cancel = () => request.abort();
    const done = callback => value => { signal?.removeEventListener('abort', cancel); callback(value); };
    const request = GM_xmlhttpRequest({
      method: 'GET', url: MODEL_URL, timeout: 20000, anonymous: true,
      onload: done(r => r.status >= 200 && r.status < 300 ? resolve(r.responseText) : reject(new UploadError(`模型下载失败（HTTP ${r.status}）`, 'model'))),
      onerror: done(() => reject(new UploadError('模型下载失败；可在脚本菜单中导入 OCRCaptcha.js', 'model'))),
      ontimeout: done(() => reject(new UploadError('模型下载超时；可在脚本菜单中导入 OCRCaptcha.js', 'model'))),
      onabort: done(() => reject(new UploadError('已取消', 'cancelled'))),
    });
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

async function initializeModel(signal) {
  if (typeof tf === 'undefined') throw new UploadError('TensorFlow.js 未加载，请检查 Tampermonkey 外部资源下载', 'model');
  let data = GM_getValue(MODEL_KEY, null);
  if (data) {
    try { data = parseModel(JSON.stringify(data)); }
    catch { GM_deleteValue(MODEL_KEY); data = null; }
  }
  if (!data && typeof page.GM_getValue === 'function') {
    // The supplied Amazing Luogu exposes its own storage getter on unsafeWindow.
    // Reuse only the known OCR model key; do not execute the cached script.
    try {
      const source = page.GM_getValue('OCRCaptchaCode');
      if (typeof source === 'string' && source) data = parseModel(source);
    } catch { /* Missing/incompatible companion cache: try the official resource. */ }
  }
  if (!data) {
    data = parseModel(await getModelResource(signal));
  }
  try { GM_setValue(MODEL_KEY, data); } catch { /* Storage quotas do not prevent this session's inference. */ }
  abortIfNeeded(signal);
  const binary = atob(data.WEIGHTS_BASE64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  let model;
  try {
    model = await tf.loadLayersModel(tf.io.fromMemory({ modelTopology: normalizeTopology(data.MODEL_TOPOLOGY), weightSpecs: data.WEIGHT_SPECS, weightData: bytes.buffer }));
    const shape = model.inputs[0]?.shape;
    const out = model.outputs[0]?.shape;
    if (shape?.slice(1).join(',') !== '35,90,3' || out?.slice(1).join(',') !== '4,35') throw new Error('expected [35,90,3] → [4,35]');
    return model;
  } catch (error) {
    model?.dispose();
    GM_deleteValue(MODEL_KEY);
    throw new UploadError(`验证码模型加载失败：${error.message}`, 'model');
  }
}

function ensureModel(signal) {
  if (!modelPromise) modelPromise = initializeModel(signal).catch(error => { modelPromise = null; throw error; });
  return modelPromise;
}

async function recognize(blob, model) {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new UploadError('验证码图片无法解码', 'captcha'));
      image.src = url;
    });
    return tf.tidy(() => {
      const canvas = document.createElement('canvas'); canvas.width = 90; canvas.height = 35;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, 90, 35);
      const input = tf.browser.fromPixels(canvas).toFloat().div(255).expandDims(0);
      const output = model.predict(input);
      const indices = output.argMax(-1).dataSync();
      const code = Array.from(indices, i => ALPHABET[i] || '').join('');
      if (!/^[a-z1-9]{4}$/.test(code)) throw new UploadError('验证码识别结果无效', 'captcha');
      return code;
    });
  } finally { URL.revokeObjectURL(url); }
}

async function siteFetch(path, options, signal) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  abortIfNeeded(signal);
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, 15000);
  try {
    return await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options, signal: controller.signal });
  } catch (error) {
    abortIfNeeded(signal);
    throw new UploadError(controller.signal.aborted ? '洛谷请求超时，请稍后重试' : '洛谷请求失败，请检查网络', 'network');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}

async function credentials(code, signal) {
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content;
  if (!csrf) throw new UploadError('当前页面缺少 CSRF token，请刷新洛谷页面', 'protocol');
  const response = await siteFetch('/image/upload', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-TOKEN': csrf },
    body: JSON.stringify({ captcha: code, watermarkType: Number(GM_getValue('lgpi:watermark', 1)) }),
  }, signal);
  let data;
  try { data = await response.json(); }
  catch {
    if (response.status === 401 || response.url.includes('/auth/')) throw new UploadError('请先登录洛谷', 'login');
    throw new UploadError('洛谷未返回 JSON；请检查登录状态或页面验证提示', 'protocol');
  }
  if (!response.ok || data.errorMessage) throw classifyError(data, response.status);
  if (!data.uploadLink) throw new UploadError('洛谷上传接口缺少 uploadLink，接口可能已变化', 'protocol');
  return data.uploadLink;
}

function sendFile(file, link, signal, progress) {
  const host = uploadHost(link.host);
  const form = buildUploadForm(file, link);
  return new Promise((resolve, reject) => {
    abortIfNeeded(signal);
    const xhr = new XMLHttpRequest();
    const cancel = () => xhr.abort();
    const done = callback => (...args) => { signal?.removeEventListener('abort', cancel); callback(...args); };
    xhr.open('POST', host);
    xhr.timeout = 90000;
    // Signed storage request: no account cookies or CSRF token sent to storage.
    xhr.withCredentials = false;
    xhr.upload.onprogress = event => { if (event.lengthComputable) progress(Math.floor(event.loaded / event.total * 100)); };
    xhr.onload = done(() => {
      try {
        if (xhr.status < 200 || xhr.status >= 300) {
          let message = `图片上传失败（HTTP ${xhr.status}）`;
          if (xhr.responseText.trim().startsWith('<')) {
            const xml = new DOMParser().parseFromString(xhr.responseText, 'text/xml');
            message = xml.querySelector('Message')?.textContent || message;
          }
          throw new UploadError(message, 'storage');
        }
        resolve(uploadedURL(JSON.parse(xhr.responseText)));
      } catch (error) { reject(error instanceof UploadError ? error : new UploadError('上传回调无法解析，请到图床检查结果', 'uncertain')); }
    });
    xhr.onerror = done(() => reject(new UploadError('上传连接中断，结果未确认；请先到图床检查，重新上传可能产生重复图片', 'uncertain')));
    xhr.ontimeout = done(() => reject(new UploadError('上传超时，结果未确认；请先到图床检查，重新上传可能产生重复图片', 'uncertain')));
    xhr.onabort = done(() => reject(new UploadError('已取消；如果上传已经开始，图片可能已保存到图床', 'cancelled')));
    signal.addEventListener('abort', cancel, { once: true });
    xhr.send(form);
  });
}

async function upload(task) {
  const signal = task.controller.signal;
  abortIfNeeded(signal);
  let context;
  try { context = JSON.parse(document.querySelector('#lentille-context')?.textContent || 'null'); } catch { /* old frontend has no context */ }
  if (context && Object.hasOwn(context, 'user') && !context.user) throw new UploadError('请先登录洛谷，再重试上传', 'login');
  setStatus(task, '正在加载验证码模型');
  const model = await ensureModel(signal);
  const link = await retryCaptcha(async () => {
    abortIfNeeded(signal);
    if (!task.adapter.contains(task.token)) throw new UploadError('占位符已移除，已取消上传', 'cancelled');
    setStatus(task, '正在获取验证码');
    const response = await siteFetch(`/lg4/captcha?_t=${Date.now()}&lgpi=${crypto.randomUUID()}`, {}, signal);
    if (!response.ok) throw classifyError({}, response.status);
    const blob = await response.blob();
    if (!blob.type.startsWith('image/')) throw new UploadError('验证码接口未返回图片，请检查登录状态', 'protocol');
    setStatus(task, '正在识别验证码');
    const code = await recognize(blob, model);
    abortIfNeeded(signal);
    setStatus(task, '正在验证并获取上传凭据');
    return credentials(code, signal);
  }, { signal, retries: 5, onRetry: (index, max) => setStatus(task, `验证码错误，1 秒后重试 ${index}/${max}`) });
  abortIfNeeded(signal);
  if (!task.adapter.contains(task.token)) throw new UploadError('占位符已移除，已取消上传', 'cancelled');
  task.stage = 'storage';
  setStatus(task, '正在上传图片');
  return sendFile(task.file, link, signal, percent => setStatus(task, `上传 ${percent}%`));
}

function notifyInput(element) {
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

function textAreaAdapter(element) {
  const usable = () => element.isConnected && !element.disabled && !element.readOnly;
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  return {
    contains: token => usable() && element.value.includes(token),
    insert(text) {
      if (!usable()) return false;
      const before = element.value, start = element.selectionStart, end = element.selectionEnd;
      const expected = before.slice(0, start) + text + before.slice(end);
      if (element.maxLength >= 0 && expected.length > element.maxLength) return false;
      // Browser-supported native insertion preserves the textarea undo stack.
      try { document.execCommand('insertText', false, text); } catch { /* fallback below */ }
      if (element.value !== expected) {
        if (element.value !== before) return false;
        element.setRangeText(text, start, end, 'end');
        notifyInput(element);
      } else element.dispatchEvent(new Event('change', { bubbles: true }));
      return element.value === expected;
    },
    replace(token, text) {
      if (!usable()) return false;
      const next = replacement(element.value, token, text, element.selectionStart, element.selectionEnd);
      if (!next) return false;
      set.call(element, next.value);
      element.setSelectionRange(next.start, next.end);
      notifyInput(element);
      return true;
    },
  };
}

function cm5Adapter(wrapper) {
  const cm = wrapper.CodeMirror;
  if (!cm || cm.getOption('readOnly') || !/markdown|gfm/i.test(JSON.stringify(cm.getOption('mode')) || '')) return null;
  return {
    contains: token => wrapper.isConnected && cm.getValue().includes(token),
    insert: text => { if (!wrapper.isConnected) return false; cm.replaceSelection(text, 'end', '+input'); return true; },
    replace(token, text) {
      const next = replacement(cm.getValue(), token, text);
      if (!wrapper.isConnected || !next) return false;
      cm.replaceRange(text, cm.posFromIndex(next.at), cm.posFromIndex(next.at + token.length), '+lgpi');
      return true;
    },
  };
}

function cm6Adapter(wrapper) {
  // CodeMirror 6 exposes its owning view on rendered DOM nodes. Only use a
  // recognized Markdown wrapper; do not inject Markdown into source-code editors.
  if (!wrapper.closest('.cs-editor, [class*="markdown"], [class*="Markdown"], [class*="mkdn"], .md-editor')) return null;
  const content = wrapper.querySelector('.cm-content');
  const view = content?.cmView?.view || content?.cmView?.rootView?.view || wrapper.cmView?.view;
  if (!view?.state?.doc || typeof view.dispatch !== 'function' || content?.contentEditable === 'false') return null;
  return {
    contains: token => wrapper.isConnected && view.state.doc.toString().includes(token),
    insert(text) {
      if (!wrapper.isConnected) return false;
      const { from, to } = view.state.selection.main;
      view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, scrollIntoView: true });
      return true;
    },
    replace(token, text) {
      const next = replacement(view.state.doc.toString(), token, text);
      if (!wrapper.isConnected || !next) return false;
      view.dispatch({ changes: { from: next.at, to: next.at + token.length, insert: text } });
      return true;
    },
  };
}

function adapterFor(event) {
  for (const node of event.composedPath()) {
    if (!(node instanceof Element)) continue;
    const cm5 = node.closest('.CodeMirror');
    if (cm5) return cm5Adapter([...page.document.querySelectorAll('.CodeMirror')].find(element => element.isSameNode(cm5)) || cm5);
    const cm6 = node.closest('.cm-editor');
    if (cm6) return cm6Adapter([...page.document.querySelectorAll('.cm-editor')].find(element => element.isSameNode(cm6)) || cm6);
    if (node.tagName === 'TEXTAREA') {
      if (node.closest('.monaco-editor, .ace_editor') || /(?:source|code|代码)/i.test(`${node.name} ${node.id} ${node.getAttribute('placeholder') || ''}`)) return null;
      return textAreaAdapter(node);
    }
  }
  return null;
}

function ensurePanel() {
  if (panel?.isConnected) return;
  panel = document.createElement('aside'); panel.id = 'lgpi-panel';
  panel.setAttribute('aria-label', '洛谷图片上传任务');
  const head = document.createElement('div'); head.className = 'lgpi-head';
  summary = document.createElement('span'); summary.textContent = '图片上传';
  const toggle = document.createElement('button'); toggle.textContent = '收起';
  toggle.onclick = () => { list.hidden = !list.hidden; toggle.textContent = list.hidden ? '展开' : '收起'; };
  const clear = document.createElement('button'); clear.textContent = '清理已结束';
  clear.onclick = () => { for (const task of tasks.values()) if (task.state !== 'queued' && task.state !== 'running') { task.file = null; task.row.remove(); tasks.delete(task.id); } updateSummary(); };
  head.append(summary, toggle, clear);
  list = document.createElement('div'); list.className = 'lgpi-list'; list.setAttribute('aria-live', 'polite');
  panel.append(head, list); document.body.append(panel);
}

function updateSummary() {
  if (!summary) return;
  const active = [...tasks.values()].filter(task => ['queued', 'running'].includes(task.state)).length;
  summary.textContent = active ? `图片上传 · ${active} 个任务` : '图片上传';
}

function setStatus(task, message) { task.status.textContent = message; updateSummary(); }

function addTaskUI(task) {
  ensurePanel();
  const row = document.createElement('div'); row.className = 'lgpi-task';
  const title = document.createElement('strong'); title.textContent = task.file.name;
  const status = document.createElement('div'); status.className = 'lgpi-status';
  const actions = document.createElement('div'); actions.className = 'lgpi-actions';
  task.row = row; task.status = status; task.actions = actions;
  row.append(title, status, actions); list.append(row);
  action(task, '取消', () => task.controller.abort());
  setStatus(task, '排队中');
}

function action(task, title, handler) {
  const button = document.createElement('button'); button.textContent = title; button.onclick = handler; task.actions.append(button);
}

function schedule(task) {
  task.state = 'queued'; task.stage = 'credentials';
  task.controller = new AbortController();
  task.controller.signal.addEventListener('abort', () => {
    if (task.state === 'queued') {
      task.state = 'cancelled'; task.file = null;
      task.adapter.replace(task.token, ''); task.actions.replaceChildren(); setStatus(task, '已取消');
    } else if (task.state === 'running') setStatus(task, '正在取消');
  }, { once: true });
  task.actions.replaceChildren(); action(task, '取消', () => task.controller.abort());
  setStatus(task, '排队中');
  void queue.add(async () => {
    abortIfNeeded(task.controller.signal);
    task.state = 'running'; updateSummary();
    return upload(task);
  }).then(url => {
    task.url = url; task.state = 'success'; task.file = null;
    const inserted = task.adapter.replace(task.token, `![](${url})`);
    setStatus(task, inserted ? '已上传并插入图片' : '已上传；原占位符已移除或编辑器已关闭，请复制链接');
    task.actions.replaceChildren();
    action(task, '复制 Markdown', () => GM_setClipboard(`![](${url})`, 'text'));
    action(task, '复制链接', () => GM_setClipboard(url, 'text'));
    const link = document.createElement('a'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '查看图片'; task.actions.append(link);
  }).catch(error => {
    task.state = error.kind === 'cancelled' ? 'cancelled' : 'failed';
    setStatus(task, error.message || '图片上传失败');
    task.actions.replaceChildren();
    if (task.state === 'cancelled') { task.adapter.replace(task.token, ''); task.file = null; }
    else {
      const token = `[图片上传失败：${task.id}]`;
      if (task.adapter.replace(task.token, token)) task.token = token;
      action(task, error.kind === 'uncertain' ? '重新上传（可能重复）' : '重试', () => {
        if (!task.adapter.contains(task.token)) { setStatus(task, '原占位符已移除，无法在原位置重试；请重新粘贴图片'); return; }
        schedule(task);
      });
      action(task, '移除', () => { task.adapter.replace(task.token, ''); task.file = null; task.row.remove(); tasks.delete(task.id); updateSummary(); });
    }
  });
}

function onPaste(event) {
  if (!enabled || event.defaultPrevented || !event.clipboardData) return;
  const items = [...event.clipboardData.items];
  const images = items.filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
  if (!images.length) images.push(...[...event.clipboardData.files].filter(file => file.type.startsWith('image/')));
  if (!images.length) return;
  const adapter = adapterFor(event);
  if (!adapter) {
    const target = event.target;
    if (target instanceof Element && target.closest('[contenteditable="true"], .cm-editor, .CodeMirror')) {
      ensurePanel(); summary.textContent = '当前编辑器暂不支持自动上传';
    }
    return;
  }
  const newTasks = images.map((image, index) => {
    const id = crypto.randomUUID();
    const ext = image.type.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png';
    const file = new File([image], `paste-${Date.now()}-${index + 1}-${id.slice(0, 8)}.${ext}`, { type: image.type });
    return { id, file, adapter, token: `[图片上传中：${id}]` };
  });
  const text = event.clipboardData.getData('text/plain');
  const insertion = (text ? `${text}\n` : '') + newTasks.map(task => task.token).join('\n') + '\n';
  if (!adapter.insert(insertion)) return;
  event.preventDefault(); event.stopImmediatePropagation();
  for (const task of newTasks) { tasks.set(task.id, task); addTaskUI(task); schedule(task); }
}

GM_addStyle(`
#lgpi-panel { position:fixed; right:16px; bottom:16px; width:350px; max-width:calc(100vw - 32px); z-index:2147483600; background:#fff; color:#202633; border:1px solid #d5dce8; border-radius:10px; box-shadow:0 6px 24px #0002; font:13px/1.5 system-ui,sans-serif; }
#lgpi-panel .lgpi-head { display:flex; gap:6px; align-items:center; padding:10px; border-bottom:1px solid #e5e7eb; }
#lgpi-panel .lgpi-head span { flex:1; font-weight:600; }
#lgpi-panel .lgpi-list { max-height:320px; overflow:auto; }
#lgpi-panel .lgpi-task { padding:10px; border-bottom:1px solid #eee; overflow-wrap:anywhere; }
#lgpi-panel .lgpi-task strong { display:block; font-size:12px; }
#lgpi-panel .lgpi-status { margin:5px 0; }
#lgpi-panel button,#lgpi-panel a { font:inherit; color:#1760a5; border:1px solid #d5dce8; border-radius:5px; background:#f7f9fd; padding:3px 7px; cursor:pointer; text-decoration:none; }
#lgpi-panel .lgpi-actions { display:flex; gap:6px; flex-wrap:wrap; }
#lgpi-panel button:focus-visible,#lgpi-panel a:focus-visible { outline:2px solid #1760a5; outline-offset:2px; }
`);

GM_registerMenuCommand('开启/关闭粘贴图片自动上传', () => {
  enabled = !enabled; GM_setValue('lgpi:enabled', enabled); ensurePanel(); summary.textContent = enabled ? '图片自动上传已开启' : '图片自动上传已关闭';
});
GM_registerMenuCommand('设置水印类型（默认 1）', () => {
  const value = prompt('水印类型：填入洛谷图床支持的类型编号。默认 1；0 为无水印，会占用高级空间。', String(GM_getValue('lgpi:watermark', 1)));
  if (value !== null && /^\d+$/.test(value)) GM_setValue('lgpi:watermark', Number(value));
});
GM_registerMenuCommand('清除验证码模型缓存', async () => {
  if ([...tasks.values()].some(task => ['running', 'queued'].includes(task.state))) { ensurePanel(); summary.textContent = '请等待任务结束后再清除模型'; return; }
  if (modelPromise) { try { (await modelPromise).dispose(); } catch { /* failed model */ } }
  modelPromise = null; GM_deleteValue(MODEL_KEY); ensurePanel(); summary.textContent = '模型缓存已清除';
});
GM_registerMenuCommand('导入验证码模型 OCRCaptcha.js / JSON', () => {
  const input = document.createElement('input'); input.type = 'file'; input.accept = '.js,.json';
  input.onchange = async () => {
    try {
      if ([...tasks.values()].some(task => ['running', 'queued'].includes(task.state))) throw new Error('请等待上传任务结束后再导入');
      const file = input.files[0]; if (!file) return;
      if (file.size > 30 * 1024 * 1024) throw new Error('模型文件超过 30 MB');
      const data = parseModel(await file.text());
      if (modelPromise) { try { (await modelPromise).dispose(); } catch { /* old model */ } }
      modelPromise = null; GM_setValue(MODEL_KEY, data);
      ensurePanel(); summary.textContent = '模型已导入，下次粘贴时加载';
    } catch (error) { ensurePanel(); summary.textContent = `导入失败：${error.message}`; }
  };
  input.click();
});
document.addEventListener('paste', onPaste, true);

})();
