export class UploadError extends Error {
  constructor(message, kind = 'other') { super(message); this.name = 'UploadError'; this.kind = kind; }
}

export function abortIfNeeded(signal) {
  if (signal?.aborted) throw new UploadError('已取消', 'cancelled');
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    abortIfNeeded(signal);
    const cancel = () => { clearTimeout(timer); reject(new UploadError('已取消', 'cancelled')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

export function classifyError(data, status = 0) {
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

export async function retryCaptcha(attempt, { signal, retries = 5, wait = sleep, onRetry = () => {} } = {}) {
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

export class SerialQueue {
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
export function readLiteral(source, name) {
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

export function parseModel(source) {
  let data;
  try { data = JSON.parse(source); } catch {
    data = { MODEL_TOPOLOGY: readLiteral(source, 'MODEL_TOPOLOGY'), WEIGHT_SPECS: readLiteral(source, 'WEIGHT_SPECS'), WEIGHTS_BASE64: readLiteral(source, 'WEIGHTS_BASE64') };
  }
  if (!data?.MODEL_TOPOLOGY || !Array.isArray(data.WEIGHT_SPECS) || typeof data.WEIGHTS_BASE64 !== 'string' || !/^[A-Za-z0-9+/=\s]+$/.test(data.WEIGHTS_BASE64)) throw new UploadError('模型数据格式不正确', 'model');
  return data;
}

export function normalizeTopology(original) {
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

export function uploadHost(host) {
  const url = new URL(host.startsWith('//') ? `https:${host}` : host.includes('://') ? host : `https://${host}`);
  const allowed = /^(?:[a-z0-9-]+\.)*(?:luogu\.com\.cn|luogu\.com)$/.test(url.hostname) || /^luogu(?:private)?\.oss-cn-[a-z0-9-]+\.aliyuncs\.com$/.test(url.hostname);
  if (!allowed || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && url.port !== '443')) throw new UploadError('图床返回了未支持的上传域名', 'protocol');
  url.protocol = 'https:';
  return url.href;
}

export function buildUploadForm(file, link, Form = FormData) {
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

export function uploadedURL(payload) {
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

export function replacement(value, token, text, start = 0, end = start) {
  const at = value.indexOf(token);
  if (at < 0 || value.indexOf(token, at + token.length) >= 0) return null;
  const after = at + token.length, delta = text.length - token.length;
  const shift = pos => pos <= at ? pos : pos >= after ? pos + delta : at + text.length;
  return { value: value.slice(0, at) + text + value.slice(after), start: shift(start), end: shift(end), at };
}
