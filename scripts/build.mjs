import fs from 'node:fs/promises';
const header = `// ==UserScript==
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
`;
const core = (await fs.readFile('src/core.mjs','utf8')).replace(/^export /gm, '');
const browser = await fs.readFile('src/browser.js','utf8');
await fs.writeFile('luogu-paste-image.user.js', `${header}\n(() => {\n'use strict';\n${core}\n${browser}\n})();\n`);
console.log('Built luogu-paste-image.user.js');
