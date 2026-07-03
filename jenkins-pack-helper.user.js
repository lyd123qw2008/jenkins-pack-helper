// ==UserScript==
// @name         Jenkins Pack Helper
// @namespace    jenkins-pack-helper
// @version      0.1.2
// @description  Build Jenkins jobs and extract success messages.
// @match        http://192.169.2.50:9081/*
// @updateURL    https://raw.githubusercontent.com/lyd123qw2008/jenkins-pack-helper/main/jenkins-pack-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/lyd123qw2008/jenkins-pack-helper/main/jenkins-pack-helper.user.js
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
  'use strict';

  // Jenkins timestamper script calls querySelector on addedNodes, which can include text nodes.
  // Provide a safe fallback to avoid console errors.
  if (!Node.prototype.querySelector) {
    Node.prototype.querySelector = function () { return null; };
  }

  const SCRIPT_VERSION = '2026-07-03-3';
  const STORAGE_KEY = 'jph_config_v1';
  const HISTORY_KEY = 'jph_history_v1';
  const UI_KEY = 'jph_ui_v1';
  const HISTORY_LIMIT = 500;
  const HISTORY_PAGE_SIZE = 30;
  const HISTORY_RESULT_TEXT_LIMIT = 2000;
  const RECENT_JOB_LIMIT = 10;
  const TIMELINE_DAY_MS = 24 * 60 * 60 * 1000;
  const TIMELINE_DAYS_PER_LOAD = 3;
  let crumbCache = null;
  const DEFAULT_RULES = [
      {
        name: 'docker',
        job_pattern: '^FXYF2_docker.*',
        success_patterns: [
          '.*?(镜像仓库：[^，,]+[，,]镜像版本：V[0-9.]+\\.[0-9]+[，,]已成功推送至：\\S+\\s*仓库项目中，自动化镜像构建脚本运行完成！)'
        ],
        result_template: '{match}'
      },
      {
        name: 'doc',
        job_pattern: '^FXYF2_doc.*',
        success_patterns: [
          '.*?([^\\r\\n]+?\\.zip已打包好[，,]?请到以下路径提取包进行测试。[^\\r\\n]*)'
        ],
        result_template: '{match}'
      },
      {
        name: 'send_doc',
        job_pattern: '^5gsend-Platform-.*_doc$',
        success_patterns: [
          '.*?([^\\r\\n]+?\\.zip\\s*已发送到珠海平台[^\\r\\n]*目录中，请知悉！)'
        ],
        result_template: '{match}'
      },
      {
        name: 'send_docker',
        job_pattern: '^5gsend-Platform-send-docker$',
        success_patterns: [
          '.*?([\\w./-]+:V[0-9.]+(?:\\.[0-9]+)?已发送到珠海平台:[^\\s]+目录中，请知悉！)'
        ],
        result_template: '{match}'
      },
      {
        name: 'fallback',
        job_pattern: '.*',
        success_patterns: [
          '.*?([^\\r\\n]+?\\.zip已打包好[，,]?请到以下路径提取包进行测试。[^\\r\\n]*)'
        ],
        result_template: '{match}'
      }
    ];
  const DEFAULT_CONFIG = {
    rules: JSON.parse(JSON.stringify(DEFAULT_RULES)),
    debug: false
  };

  function loadConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      return JSON.parse(raw);
    } catch (e) {
      console.warn('Failed to load config, using default.', e);
      return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }
  }

  function saveConfig(cfg) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  }

  function loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      console.warn('Failed to load history.', e);
      return [];
    }
  }

  function saveHistory(list) {
    const compact = (list || []).map(item => {
      if (!item || typeof item !== 'object') return item;
      const copy = { ...item };
      if (typeof copy.resultText === 'string' && copy.resultText.length > HISTORY_RESULT_TEXT_LIMIT) {
        copy.resultText = `${copy.resultText.slice(0, HISTORY_RESULT_TEXT_LIMIT)}...`;
      }
      return copy;
    });
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(compact));
    } catch (e) {
      try {
        const minimal = compact.slice(0, 100).map(item => {
          if (!item || typeof item !== 'object') return item;
          const { resultText, ...rest } = item;
          return rest;
        });
        localStorage.setItem(HISTORY_KEY, JSON.stringify(minimal));
      } catch (inner) {
        console.warn('Failed to save history.', inner);
      }
    }
  }

  function loadUI() {
    try {
      const raw = localStorage.getItem(UI_KEY);
      if (!raw) return { visible: false };
      const cfg = JSON.parse(raw);
      return { visible: !!cfg.visible };
    } catch (e) {
      return { visible: false };
    }
  }

  function saveUI(state) {
    localStorage.setItem(UI_KEY, JSON.stringify(state));
  }

  function mergeHistory(current, incoming) {
    const map = new Map();
    (current || []).forEach(item => {
      if (item && item.id) map.set(item.id, item);
    });
    (incoming || []).forEach(item => {
      if (!item || !item.id) return;
      const prev = map.get(item.id) || {};
      map.set(item.id, { ...prev, ...item });
    });
    return Array.from(map.values());
  }

  function sortTrimHistory(list) {
    const map = new Map();
    (list || []).forEach(item => {
      if (!item || !item.id) return;
      const prev = map.get(item.id) || {};
      map.set(item.id, { ...prev, ...item });
    });
    return Array.from(map.values())
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, HISTORY_LIMIT);
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(k => {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else node.setAttribute(k, attrs[k]);
      });
    }
    if (children) children.forEach(c => node.appendChild(c));
    return node;
  }

  function injectStyles() {
    const style = el('style', { html: `
      #jph-panel {
        position: fixed; right: 16px; top: 90px; width: 360px;
        background: #0f172a; color: #e2e8f0; z-index: 99999;
        border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.35);
        font-family: Segoe UI, Arial, sans-serif; overflow: hidden;
        max-height: calc(100vh - 110px); display: flex; flex-direction: column;
      }
      #jph-panel.jph-config-open,
      #jph-panel:has(#jph-config-wrap[open]) { width: min(520px, calc(100vw - 32px)); height: calc(100vh - 110px); }
      #jph-panel h3 { margin: 0; padding: 10px 12px; font-size: 14px; background: #111827; }
      #jph-panel .body { padding: 10px 12px; overflow: auto; flex: 1; min-height: 0; }
      #jph-panel .job { border: 1px solid #1f2937; border-radius: 8px; padding: 8px; margin-bottom: 8px; background:#0b1224; }
      #jph-panel label { font-size: 12px; color: #cbd5e1; display:block; margin-top: 6px; }
      #jph-panel input, #jph-panel textarea {
        width: 100%; box-sizing: border-box; background: #0b1224;
        color: #e2e8f0; border: 1px solid #1f2937; border-radius: 6px;
        padding: 6px; font-size: 12px;
      }
      #jph-panel button {
        background: #3b82f6; border: 0; color: #fff; padding: 6px 10px;
        border-radius: 6px; cursor: pointer; margin-right: 6px; font-size: 12px;
      }
      #jph-panel button.secondary { background: #475569; }
      #jph-panel .result { white-space: pre-wrap; background: #0b1224; border-radius: 6px; padding: 8px; min-height: 40px; font-size: 12px; }
      #jph-panel .result-meta { margin: 4px 0 6px; color: #94a3b8; font-size: 11px; }
      #jph-panel .logs { white-space: pre-wrap; color: #94a3b8; font-size: 11px; margin-top: 6px; }
      #jph-panel details.logs-wrap > summary { cursor: pointer; }
      #jph-toggle {
        position: fixed; right: 16px; top: 50px; z-index: 99999;
        background: #0f172a; color: #e2e8f0; border-radius: 6px;
        padding: 6px 10px; cursor: pointer; font-size: 12px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.35);
      }
      #jph-panel .muted { color:#94a3b8; font-size: 11px; }
      #jph-panel details > summary { cursor: pointer; }
      #jph-panel .tabs { display:flex; gap:6px; margin:8px 0; }
      #jph-panel .tab { padding:4px 8px; font-size:11px; border-radius:6px; background:#0b1224; cursor:pointer; border:1px solid #1f2937; }
      #jph-panel .tab.active { background:#1d4ed8; border-color:#1d4ed8; color:#fff; }
      #jph-panel .tab-help { margin-left: auto; font-size: 12px; color: #94a3b8; cursor: help; }
      #jph-panel .tabs { align-items: center; }
      .jph-menu-item-link { cursor:pointer; }
      #jph-panel .history { max-height: min(52vh, 520px); overflow:auto; border:1px solid #1f2937; border-radius:8px; background:#0b1224; }
      #jph-panel.jph-config-open .history,
      #jph-panel:has(#jph-config-wrap[open]) .history { max-height: min(24vh, 220px); }
      #jph-panel .history-item { padding:6px 8px; border-bottom:1px solid #111827; cursor:pointer; }
      #jph-panel .history-item:last-child { border-bottom:0; }
      #jph-panel .history-item:hover { background:#0f172a; }
      #jph-panel .history-actions { margin-top:4px; display:flex; gap:6px; }
      #jph-panel .history-actions button { background:#1f2937; color:#e2e8f0; border:1px solid #334155; padding:2px 6px; border-radius:6px; font-size:10px; }
      #jph-panel .history-more { padding:8px; text-align:center; color:#94a3b8; font-size:11px; cursor:pointer; }
      #jph-panel .history-more:hover { background:#0f172a; color:#cbd5e1; }
      #jph-panel .byjob-head { padding:8px; border-bottom:1px solid #111827; background:#0b1224; }
      #jph-panel .byjob-name { font-size:12px; margin-bottom:3px; word-break:break-all; }
      #jph-panel .job-picker { max-height:150px; overflow:auto; border-bottom:1px solid #111827; background:#0b1224; }
      #jph-panel .job-option { padding:6px 8px; border-bottom:1px solid #111827; cursor:pointer; font-size:11px; word-break:break-all; }
      #jph-panel .job-option:last-child { border-bottom:0; }
      #jph-panel .job-option:hover { background:#0f172a; }
      #jph-panel .job-option.active { background:#1d4ed8; color:#fff; }
      #jph-panel .badge { display:inline-block; padding:2px 6px; border-radius:10px; font-size:10px; margin-left:6px; }
      #jph-panel .badge.success { background:#16a34a; color:#fff; }
      #jph-panel .badge.failure { background:#dc2626; color:#fff; }
      #jph-panel .badge.aborted { background:#f59e0b; color:#111827; }
      #jph-panel .badge.building { background:#0ea5e9; color:#fff; }
      #jph-panel .badge.unknown { background:#475569; color:#fff; }
      #jph-panel .history-meta { display:flex; gap:6px; flex-wrap:wrap; font-size:10px; color:#94a3b8; }
      #jph-panel .history-title { font-size:12px; margin-bottom:2px; }
      #jph-panel .row { display:flex; gap:6px; margin:6px 0; flex-wrap:wrap; }
      #jph-panel .row button { flex:0 0 auto; }
      #jph-filter-row { margin-top: 4px; }
      #jph-filter { width: 100%; }
      #jph-config-wrap { margin-top:8px; }
      #jph-config-view { background:#0b1224; border:1px solid #1f2937; border-radius:6px; padding:8px; font-size:12px; overflow:auto; max-height:min(56vh, 620px); }
      #jph-config-view code { white-space: pre-wrap; display:block; }
      #jph-config-tree { background:#0b1224; border:1px solid #1f2937; border-radius:6px; padding:8px; font-size:12px; max-height:min(56vh, 620px); overflow:auto; }
      #jph-panel.jph-config-open #jph-config-tree,
      #jph-panel.jph-config-open #jph-config-view,
      #jph-panel.jph-config-open #jph-config,
      #jph-panel:has(#jph-config-wrap[open]) #jph-config-tree,
      #jph-panel:has(#jph-config-wrap[open]) #jph-config-view,
      #jph-panel:has(#jph-config-wrap[open]) #jph-config { max-height:min(48vh, 520px); }
      #jph-config { height:min(48vh, 520px); min-height:220px; font-family: Consolas, monospace; resize: vertical; }
      #jph-config-tree details { margin: 4px 0; }
      #jph-config-tree summary { cursor: pointer; }
      #jph-config-tree .json-children { margin-left: 10px; padding-left: 8px; border-left: 1px dashed #1f2937; }
      #jph-config-tree .json-key { color:#93c5fd; }
      #jph-config-tree .json-string { color:#f9a8d4; }
      #jph-config-tree .json-number { color:#fbbf24; }
      #jph-config-tree .json-boolean { color:#86efac; }
      #jph-config-tree .json-null { color:#94a3b8; }
      #jph-config-tree .json-type { color:#94a3b8; margin-left:6px; }
      #jph-panel .json-key { color:#93c5fd; }
      #jph-panel .json-string { color:#f9a8d4; }
      #jph-panel .json-number { color:#fbbf24; }
      #jph-panel .json-boolean { color:#86efac; }
      #jph-panel .json-null { color:#94a3b8; }
    `});
    document.head.appendChild(style);
  }

  function normalizeUrl(base, path) {
    try {
      return new URL(path, base).toString();
    } catch (_) {
      return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
    }
  }

  async function fetchConsoleText(baseUrl, jobFullName, buildNumber) {
    const path = buildJobPath(jobFullName);
    const url = normalizeUrl(baseUrl, `${path}/${buildNumber}/console`);
    const resp = await fetch(url, { credentials: 'same-origin' });
    if (!resp.ok) throw new Error('Failed to fetch console HTML');
    const html = await resp.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const pre = doc.querySelector('pre') || doc.querySelector('#out') || doc.querySelector('.console-output');
    if (pre) return pre.innerText;
    return doc.body ? doc.body.innerText : '';
  }

  function copyToClipboard(text) {
    if (typeof GM_setClipboard === 'function') {
      GM_setClipboard(text);
      return Promise.resolve();
    }
    if (navigator.clipboard) {
      return navigator.clipboard.writeText(text);
    }
    return Promise.reject(new Error('Clipboard unavailable'));
  }

  function extractResult(text, patterns) {
    const cleaned = text ? text.replace(/\x1B\[[0-9;]*m/g, '') : '';
    let lines = null;
    const getLines = () => {
      if (!lines) lines = cleaned.replace(/\r/g, '\n').split(/\n/);
      return lines;
    };
    const matches = [];
    (patterns || []).forEach(p => {
      const re = new RegExp(p, 'gm');
      let m;
      while ((m = re.exec(cleaned)) !== null) {
        if (m.length > 1) {
          matches.push(m[1] || m[0]);
        } else {
          matches.push(m[0]);
        }
      }
    });
    if (matches.length) {
      const picked = matches[matches.length - 1].split(/\r?\n/)[0].trim();
      if (picked.includes('镜像仓库：')) return picked;
      if (picked.includes('ftp://')) return picked;
      const linesLocal = getLines();
      for (let i = linesLocal.length - 1; i >= 0; i--) {
        const line = linesLocal[i].trim();
        if (!line) continue;
        if (line.includes(picked)) {
          let out = line;
          const next = (linesLocal[i + 1] || '').trim();
          if (next.startsWith('ftp://')) out = out + '\n' + next;
          return out;
        }
      }
      return picked;
    }

    // Prefer exact line match for the pack message; take the last one.
    const linesLocal = getLines();
    let lastPackLine = '';
    let lastPackIndex = -1;
    for (let i = 0; i < linesLocal.length; i++) {
      const line = linesLocal[i].trim();
      if (!line) continue;
      if (line.includes('已打包好') && line.includes('请到以下路径提取包进行测试')) {
        lastPackLine = line;
        lastPackIndex = i;
      }
    }
    if (lastPackLine) {
      if (lastPackLine.includes('ftp://')) return lastPackLine;
      for (let j = lastPackIndex + 1; j < Math.min(linesLocal.length, lastPackIndex + 6); j++) {
        const next = linesLocal[j].trim();
        if (!next) continue;
        if (next.includes('ftp://')) return lastPackLine + '\n' + next;
        break;
      }
      return lastPackLine;
    }

    // Fallback for garbled encoding: match line containing .zip and ftp://
    let lastZipFtp = '';
    for (let i = 0; i < linesLocal.length; i++) {
      const line = linesLocal[i].trim();
      if (!line) continue;
      if (line.includes('.zip') && line.includes('ftp://')) {
        lastZipFtp = line;
      }
    }
    if (lastZipFtp) return lastZipFtp;
    let lastIndex = -1;
    for (let i = 0; i < linesLocal.length; i++) {
      const line = linesLocal[i].trim();
      if (!line) continue;
      if (line.includes('已打包好') && line.includes('请到以下路径提取包进行测试')) {
        lastIndex = i;
      }
    }
    if (lastIndex >= 0) {
      const line = linesLocal[lastIndex].trim();
      let out = line;
      for (let j = lastIndex + 1; j < Math.min(linesLocal.length, lastIndex + 4); j++) {
        const next = linesLocal[j].trim();
        if (!next) continue;
        if (next.includes('ftp://')) {
          out = out + '\n' + next;
        }
        break;
      }
      return out;
    }
    return null;
  }



  function collectPackLines(text) {
    const cleaned = text ? text.replace(/\x1B\[[0-9;]*m/g, '') : '';
    const lines = cleaned.replace(/\r/g, '\n').split(/\n/);
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (line.includes('已打包好') || line.includes('请到以下路径提取包进行测试') || line.includes('ftp://') || (line.includes('.zip') && line.includes('ftp://'))) {
        hits.push({ index: i + 1, line });
      }
    }
    return hits;
  }

  function debugFirstMatch(text, pattern) {
    const cleaned = text ? text.replace(/\x1B\[[0-9;]*m/g, '') : '';
    try {
      const re = new RegExp(pattern, 'gm');
      const m = re.exec(cleaned);
      if (!m) return { found: false };
      return { found: true, length: m.length, m0: m[0], m1: m[1] };
    } catch (e) {
      return { found: false, error: e.message || String(e) };
    }
  }

  function formatDuration(ms) {
    if (!ms && ms !== 0) return '-';
    const sec = Math.floor(ms / 1000);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m <= 0) return `${s}s`;
    return `${m}m ${s}s`;
  }

  function formatTime(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    return d.toLocaleString();
  }

  function statusClass(result, building) {
    if (building) return 'building';
    if (!result) return 'unknown';
    const r = result.toLowerCase();
    if (r === 'success') return 'success';
    if (r === 'failure') return 'failure';
    if (r === 'aborted') return 'aborted';
    return 'unknown';
  }

  function buildHistoryId(jobName, buildNumber) {
    return `${jobName}#${buildNumber}`;
  }

  function pickUserName(actions) {
    if (!Array.isArray(actions)) return '';
    for (const act of actions) {
      if (!act || !Array.isArray(act.causes)) continue;
      for (const c of act.causes) {
        if (c.userName) return c.userName;
        if (c.userId) return c.userId;
      }
    }
    return '';
  }

  function resolveRule(jobName, cfg) {
    const rules = cfg.rules || [];
    let fallback = null;
    for (const rule of rules) {
      if (!rule) continue;
      if (rule.job_pattern === '.*') {
        fallback = rule;
        continue;
      }
      if (jobName && rule.job_pattern) {
        try {
          const re = new RegExp(rule.job_pattern);
          if (re.test(jobName)) return rule;
        } catch (e) {
          // ignore invalid regex
        }
      }
    }
    return fallback;
  }

  function isFolderJob(job) {
    return String(job._class || '').includes('Folder');
  }

  function parseJobFullNameFromLink(link) {
    try {
      const url = new URL(link, location.origin);
      const parts = url.pathname.split('/').filter(Boolean);
      const names = [];
      for (let i = 0; i < parts.length - 1; i++) {
        if (parts[i] === 'job') {
          names.push(decodeURIComponent(parts[i + 1]));
          i += 1;
        }
      }
      return names.length ? names.join('/') : null;
    } catch (e) {
      return null;
    }
  }

  function parseBuildNumberFromLink(link) {
    try {
      const url = new URL(link, location.origin);
      const parts = url.pathname.split('/').filter(Boolean);
      for (let i = parts.length - 1; i >= 0; i--) {
        if (/^\d+$/.test(parts[i])) return Number(parts[i]);
      }
    } catch (e) {
      // ignore malformed link
    }
    return null;
  }

  function parseBuildNumberFromTitle(title) {
    const match = String(title || '').match(/#(\d+)/);
    return match ? Number(match[1]) : null;
  }

  function parseResultFromFeedTitle(title) {
    const lower = String(title || '').toLowerCase();
    if (lower.includes('building') || lower.includes('in progress')) {
      return { result: null, building: true };
    }
    if (lower.includes('stable') || lower.includes('success')) {
      return { result: 'SUCCESS', building: false };
    }
    if (lower.includes('unstable')) {
      return { result: 'UNSTABLE', building: false };
    }
    if (lower.includes('aborted')) {
      return { result: 'ABORTED', building: false };
    }
    if (lower.includes('broken') || lower.includes('fail')) {
      return { result: 'FAILURE', building: false };
    }
    return { result: null, building: false };
  }

  function feedText(node, selector) {
    const el = node.querySelector(selector);
    return el && el.textContent ? String(el.textContent).trim() : '';
  }

  function feedLink(node) {
    const link = node.querySelector('link');
    if (!link) return '';
    return link.getAttribute('href') || String(link.textContent || '').trim();
  }

  function feedTimestamp(node) {
    const raw = feedText(node, 'published') || feedText(node, 'updated') || feedText(node, 'pubDate');
    if (!raw) return 0;
    const ts = Date.parse(raw);
    return Number.isFinite(ts) ? ts : 0;
  }

  async function fetchJenkinsCrumb(baseUrl) {
    if (crumbCache) return crumbCache;
    const resp = await fetch(normalizeUrl(baseUrl, '/crumbIssuer/api/json'), { credentials: 'same-origin' });
    if (!resp.ok) throw new Error('Failed to fetch Jenkins crumb');
    const data = await resp.json();
    crumbCache = {
      field: data.crumbRequestField || 'Jenkins-Crumb',
      value: data.crumb
    };
    return crumbCache;
  }

  function parseTimelineResult(event) {
    const text = `${event.classname || ''} ${event.color || ''} ${event.title || ''}`.toLowerCase();
    if (text.includes('anime') || text.includes('building')) {
      return { result: null, building: true };
    }
    if (text.includes('event-blue') || text.includes('#4f6f90') || text.includes('success')) {
      return { result: 'SUCCESS', building: false };
    }
    if (text.includes('event-yellow') || text.includes('unstable')) {
      return { result: 'UNSTABLE', building: false };
    }
    if (text.includes('event-red') || text.includes('failure') || text.includes('failed')) {
      return { result: 'FAILURE', building: false };
    }
    if (text.includes('event-grey') || text.includes('aborted')) {
      return { result: 'ABORTED', building: false };
    }
    return { result: null, building: false };
  }

  function timelineEventToHistoryItem(event, baseUrl) {
    const link = event.link ? normalizeUrl(baseUrl, event.link) : '';
    let jobName = link ? parseJobFullNameFromLink(link) : null;
    if (!jobName) {
      const cleaned = String(event.title || '').replace(/\s*#\d+.*$/, '').replace(/\s*»\s*/g, '/').trim();
      if (cleaned) jobName = cleaned;
    }
    const buildNumber = parseBuildNumberFromLink(link) || parseBuildNumberFromTitle(event.title);
    if (!jobName || !buildNumber) return null;
    const start = Date.parse(event.start || '');
    const end = Date.parse(event.end || '');
    const status = parseTimelineResult(event);
    return {
      id: buildHistoryId(jobName, buildNumber),
      jobName,
      jobShortName: jobName.split('/').pop(),
      buildNumber,
      url: link || normalizeUrl(baseUrl, `${buildJobPath(jobName)}/${buildNumber}/`),
      building: status.building,
      result: status.result,
      timestamp: Number.isFinite(start) ? start : 0,
      duration: Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : 0
    };
  }

  async function fetchTimelineBuilds(baseUrl, dayIndex, retried) {
    const crumb = await fetchJenkinsCrumb(baseUrl);
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
    };
    headers[crumb.field] = crumb.value;
    const params = new URLSearchParams({
      min: String(dayIndex * TIMELINE_DAY_MS),
      max: String((dayIndex + 1) * TIMELINE_DAY_MS)
    });
    const resp = await fetch(normalizeUrl(baseUrl, '/view/all/timeline/data/'), {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: params.toString()
    });
    if (!resp.ok) {
      if (resp.status === 403 && !retried) {
        crumbCache = null;
        return fetchTimelineBuilds(baseUrl, dayIndex, true);
      }
      throw new Error(`Failed to fetch timeline data: HTTP ${resp.status}`);
    }
    const data = await resp.json();
    return (data.events || [])
      .map(event => timelineEventToHistoryItem(event, baseUrl))
      .filter(Boolean)
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  }

  function setMenuLabel(link, label) {
    const labelEl = link.querySelector('.jenkins-menu__label, .menu-title, .title, span');
    if (labelEl) {
      labelEl.textContent = label;
      return;
    }
    for (const node of Array.from(link.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        node.nodeValue = ' ' + label;
        return;
      }
    }
    link.appendChild(document.createTextNode(label));
  }

  async function copyBuildResult(jobFullName, buildNumber, cfg) {
    const consoleText = await fetchConsoleText(location.origin, jobFullName, buildNumber);
    const jobShortName = jobFullName.split('/').pop();
    const rule = resolveRule(jobShortName, cfg);
    const match = extractResult(consoleText, rule ? rule.success_patterns || [] : []);
    if (!match) return null;
    const output = rule ? (rule.result_template || '{match}').replace('{match}', match) : match;
    await copyToClipboard(output);
    return output;
  }

  async function fetchRecentJobsFromRss(baseUrl, limit) {
    const url = normalizeUrl(baseUrl, '/rssAll');
    const resp = await fetch(url, { credentials: 'same-origin' });
    if (!resp.ok) throw new Error('Failed to fetch RSS');
    const xml = await resp.text();
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const items = Array.from(doc.querySelectorAll('entry, item'));
    const results = [];
    const seen = new Set();
    for (const item of items) {
      const link = feedLink(item);
      let fullName = link ? parseJobFullNameFromLink(link) : null;
      if (!fullName) {
        const title = feedText(item, 'title');
        const cleaned = title.replace(/\s*#\d+.*$/, '').replace(/\s*»\s*/g, '/').trim();
        if (cleaned) fullName = cleaned;
      }
      if (!fullName || seen.has(fullName)) continue;
      seen.add(fullName);
      results.push(fullName);
      if (results.length >= limit) break;
    }
    return results;
  }

  async function fetchRecentBuildsFromRss(baseUrl, limit) {
    const url = normalizeUrl(baseUrl, '/rssAll');
    const resp = await fetch(url, { credentials: 'same-origin' });
    if (!resp.ok) throw new Error('Failed to fetch RSS');
    const xml = await resp.text();
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const items = Array.from(doc.querySelectorAll('entry, item'));
    const results = [];
    const seen = new Set();
    for (const item of items) {
      const link = feedLink(item);
      const title = feedText(item, 'title');
      let jobName = link ? parseJobFullNameFromLink(link) : null;
      if (!jobName) {
        const cleaned = title.replace(/\s*#\d+.*$/, '').replace(/\s*»\s*/g, '/').trim();
        if (cleaned) jobName = cleaned;
      }
      const buildNumber = parseBuildNumberFromLink(link) || parseBuildNumberFromTitle(title);
      if (!jobName || !buildNumber) continue;
      const id = buildHistoryId(jobName, buildNumber);
      if (seen.has(id)) continue;
      seen.add(id);

      const status = parseResultFromFeedTitle(title);
      results.push({
        id,
        jobName,
        jobShortName: jobName.split('/').pop(),
        buildNumber,
        url: link || normalizeUrl(baseUrl, `${buildJobPath(jobName)}/${buildNumber}/`),
        building: status.building,
        result: status.result,
        timestamp: feedTimestamp(item)
      });
      if (results.length >= limit) break;
    }
    return enrichBuildDetails(baseUrl, results);
  }

  function isLoggedIn() {
    const logoutLink = document.querySelector('a[href*="logout"], a[href*="/logout"]');
    if (logoutLink) return true;
    return false;
  }

  function getCurrentUserName() {
    if (!isLoggedIn()) return '';
    const userLink = document.querySelector('a[href*="/user/"], a[href*="user/"]');
    if (userLink && userLink.textContent) return userLink.textContent.trim();
    return '';
  }

  function buildJobPath(fullName) {
    const parts = fullName.split('/').filter(Boolean).map(encodeURIComponent);
    return `/job/${parts.join('/job/')}`;
  }

  async function fetchFolderJobs(baseUrl, folderFullName) {
    const path = buildJobPath(folderFullName);
    const api = normalizeUrl(baseUrl, `${path}/api/json?tree=jobs[name,_class,lastBuild[timestamp]]`);
    const resp = await fetch(api, { credentials: 'same-origin' });
    if (!resp.ok) throw new Error('Failed to fetch folder jobs');
    const data = await resp.json();
    return data.jobs || [];
  }

  async function fetchAllJobs(baseUrl) {
    const api = normalizeUrl(baseUrl, `/api/json?tree=jobs[name,_class,lastBuild[timestamp]]`);
    const resp = await fetch(api, { credentials: 'same-origin' });
    if (!resp.ok) throw new Error('Failed to fetch jobs');
    const data = await resp.json();
    const roots = data.jobs || [];
    const results = [];
    const queue = roots.map(j => ({ job: j, parent: '' }));
    while (queue.length) {
      const { job, parent } = queue.shift();
      if (!job || !job.name) continue;
      const fullName = parent ? `${parent}/${job.name}` : job.name;
      if (isFolderJob(job)) {
        try {
          const children = await fetchFolderJobs(baseUrl, fullName);
          children.forEach(child => queue.push({ job: child, parent: fullName }));
        } catch (e) {
          // ignore folder fetch errors
        }
        continue;
      }
      results.push({
        name: job.name,
        fullName,
        lastBuild: job.lastBuild || null
      });
    }
    return results;
  }

  function executableToHistoryItem(baseUrl, executable) {
    if (!executable || !executable.number || !executable.url) return null;
    const url = normalizeUrl(baseUrl, executable.url);
    const jobFullName = parseJobFullNameFromLink(url);
    if (!jobFullName) return null;
    const timestamp = executable.timestamp || 0;
    const duration = executable.duration || (timestamp ? Math.max(0, Date.now() - timestamp) : 0);
    return {
      id: buildHistoryId(jobFullName, executable.number),
      jobName: jobFullName,
      jobShortName: jobFullName.split('/').pop(),
      buildNumber: executable.number,
      url,
      building: executable.building !== false,
      result: executable.result || null,
      timestamp,
      duration,
      userName: pickUserName(executable.actions || [])
    };
  }

  async function fetchCurrentBuildingBuilds(baseUrl) {
    const api = normalizeUrl(baseUrl, '/computer/api/json?tree=computer[executors[currentExecutable[number,url,building,result,timestamp,duration,actions[causes[userId,userName]]]],oneOffExecutors[currentExecutable[number,url,building,result,timestamp,duration,actions[causes[userId,userName]]]]]');
    const resp = await fetch(api, { credentials: 'same-origin' });
    if (!resp.ok) throw new Error('Failed to fetch current executors');
    const data = await resp.json();
    const executables = [];
    (data.computer || []).forEach(node => {
      (node.executors || []).forEach(executor => {
        if (executor && executor.currentExecutable) executables.push(executor.currentExecutable);
      });
      (node.oneOffExecutors || []).forEach(executor => {
        if (executor && executor.currentExecutable) executables.push(executor.currentExecutable);
      });
    });
    return executables
      .map(executable => executableToHistoryItem(baseUrl, executable))
      .filter(Boolean);
  }

  async function fetchJobBuildsRange(baseUrl, jobFullName, offset, limit) {
    const cap = Number.isFinite(limit) ? limit : 30;
    const start = Number.isFinite(offset) ? Math.max(0, offset) : 0;
    const end = start + cap;
    const path = buildJobPath(jobFullName);
    const api = normalizeUrl(baseUrl, `${path}/api/json?tree=builds[number,url,building,result,timestamp,duration,actions[causes[userId,userName]]]{${start},${end}}`);
    const resp = await fetch(api, { credentials: 'same-origin' });
    if (!resp.ok) throw new Error(`Failed to fetch builds for ${jobFullName}`);
    const data = await resp.json();
    const builds = data.builds || [];
    return builds.map(b => ({
      id: buildHistoryId(jobFullName, b.number),
      jobName: jobFullName,
      jobShortName: jobFullName.split('/').pop(),
      buildNumber: b.number,
      url: b.url,
      building: !!b.building,
      result: b.result || null,
      timestamp: b.timestamp || 0,
      duration: b.duration || 0,
      userName: pickUserName(b.actions || [])
    }));
  }

  async function fetchJobBuilds(baseUrl, jobFullName, limit) {
    return fetchJobBuildsRange(baseUrl, jobFullName, 0, limit);
  }

  async function fetchBuildStatus(baseUrl, jobFullName, buildNumber) {
    const path = buildJobPath(jobFullName);
    const api = normalizeUrl(baseUrl, `${path}/${buildNumber}/api/json?tree=building,result,timestamp,duration,actions[causes[userId,userName]]`);
    const resp = await fetch(api, { credentials: 'same-origin' });
    if (!resp.ok) throw new Error('Failed to fetch build status');
    const data = await resp.json();
    return {
      id: buildHistoryId(jobFullName, buildNumber),
      jobName: jobFullName,
      jobShortName: jobFullName.split('/').pop(),
      buildNumber,
      building: !!data.building,
      result: data.result || null,
      timestamp: data.timestamp || 0,
      duration: data.duration || 0,
      userName: pickUserName(data.actions || [])
    };
  }

  async function enrichBuildDetails(baseUrl, items) {
    const source = items || [];
    const enriched = new Array(source.length);
    const concurrency = 6;
    let nextIndex = 0;

    async function worker() {
      while (nextIndex < source.length) {
        const index = nextIndex++;
        const item = source[index];
        if (!item || !item.jobName || !item.buildNumber) {
          enriched[index] = item;
          continue;
        }
        try {
          const detail = await fetchBuildStatus(baseUrl, item.jobName, item.buildNumber);
          enriched[index] = { ...item, ...detail, url: item.url || detail.url };
        } catch (e) {
          enriched[index] = item;
        }
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(concurrency, source.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
    return enriched.filter(Boolean);
  }

  function renderUI(cfg) {
    if (document.getElementById('jph-panel')) return;
    const toggle = el('div', { id: 'jph-toggle' });
    toggle.textContent = 'Jenkins Pack Helper';
    document.body.appendChild(toggle);

    const panel = el('div', { id: 'jph-panel' });
    panel.innerHTML = `
      <h3>Jenkins Pack Helper <span class="muted" style="float:right;">${SCRIPT_VERSION}</span></h3>
      <div class="body">
        <div class="row">
          <button class="secondary" id="jph-copy">Copy</button>
          <button class="secondary" id="jph-refresh">Refresh</button>
          <button class="secondary" id="jph-clear">Clear History</button>
        </div>
        <div class="result-meta" id="jph-result-meta"></div>
        <div class="result" id="jph-result"></div>
        <details class="logs-wrap" id="jph-logs-wrap">
          <summary class="muted">Logs</summary>
          <div class="logs" id="jph-logs"></div>
        </details>
        <div class="tabs">
          <div class="tab active" data-tab="all">All</div>
          <div class="tab" data-tab="byjob">By Job</div>
          <div class="tab-help" title="All 显示全局最新构建；By Job 查询选中 job 自己的构建历史">?</div>
        </div>
        <div class="row" id="jph-filter-row" style="display:none;">
          <input id="jph-filter" placeholder="Filter jobs..." />
        </div>
        <div id="jph-history-all" class="history"></div>
        <div id="jph-history-byjob" class="history" style="display:none;"></div>
        <details id="jph-config-wrap">
          <summary class="muted">Config (JSON)</summary>
          <div class="row" style="margin-bottom:6px;">
            <button class="secondary" id="jph-view-tree">Tree</button>
            <button class="secondary" id="jph-view-code">Code</button>
          </div>
          <div id="jph-config-tree"></div>
          <pre id="jph-config-view"><code id="jph-config-code"></code></pre>
          <textarea id="jph-config" rows="10" style="display:none;"></textarea>
          <div style="margin-top:6px;">
            <button class="secondary" id="jph-edit">Edit</button>
            <button class="secondary" id="jph-reset">Reset</button>
            <button class="secondary" id="jph-save" style="display:none;">Save Config</button>
            <button class="secondary" id="jph-cancel" style="display:none;">Cancel</button>
          </div>
          <div class="muted" id="jph-msg"></div>
        </details>
      </div>
    `;
    document.body.appendChild(panel);

    let visible = loadUI().visible;
    panel.style.display = visible ? 'flex' : 'none';
    toggle.addEventListener('click', () => {
      visible = !visible;
      panel.style.display = visible ? 'flex' : 'none';
      saveUI({ visible });
    });

    function escapeHtml(str) {
      return str.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }

    function renderJsonTree(value, key, depth) {
      const isObject = value && typeof value === 'object';
      if (isObject) {
        const isArray = Array.isArray(value);
        const entries = isArray ? value.map((v, i) => [i, v]) : Object.entries(value);
        const details = el('details', {});
        if (depth === 0) details.open = true;
        const label = key !== undefined ? `<span class="json-key">${escapeHtml(String(key))}</span>: ` : '';
        const typeLabel = isArray ? 'array' : 'object';
        const summary = el('summary', { html: `${label}<span class="json-type">${typeLabel}(${entries.length})</span>` });
        const children = el('div', { class: 'json-children' });
        entries.forEach(([k, v]) => {
          children.appendChild(renderJsonTree(v, k, depth + 1));
        });
        details.appendChild(summary);
        details.appendChild(children);
        return details;
      }

      let cls = 'json-null';
      let display = 'null';
      if (typeof value === 'string') {
        cls = 'json-string';
        display = `"${value}"`;
      } else if (typeof value === 'number') {
        cls = 'json-number';
        display = String(value);
      } else if (typeof value === 'boolean') {
        cls = 'json-boolean';
        display = String(value);
      }
      const line = el('div', { html: `<span class="json-key">${escapeHtml(String(key))}</span>: <span class="${cls}">${escapeHtml(display)}</span>` });
      return line;
    }

    function highlightJson(json) {
      const escaped = escapeHtml(json);
      return escaped.replace(/("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)/g, match => {
        let cls = 'json-number';
        if (/^"/.test(match)) {
          cls = /:$/.test(match) ? 'json-key' : 'json-string';
        } else if (/true|false/.test(match)) {
          cls = 'json-boolean';
        } else if (/null/.test(match)) {
          cls = 'json-null';
        }
        return `<span class="${cls}">${match}</span>`;
      });
    }

    function updateConfigView(nextCfg) {
      const json = JSON.stringify(nextCfg, null, 2);
      panel.querySelector('#jph-config').value = json;
      panel.querySelector('#jph-config-code').innerHTML = highlightJson(json);
      const treeRoot = panel.querySelector('#jph-config-tree');
      treeRoot.innerHTML = '';
      treeRoot.appendChild(renderJsonTree(nextCfg, 'root', 0));
    }

    function setLogsVisible(isDebug) {
      const logsWrap = panel.querySelector('#jph-logs-wrap');
      if (!logsWrap) return;
      logsWrap.style.display = isDebug ? 'block' : 'none';
      if (!isDebug) {
        logsWrap.open = false;
        panel.querySelector('#jph-logs').textContent = '';
      }
    }

    updateConfigView(cfg);
    let configViewMode = 'tree';
    const treeBtn = panel.querySelector('#jph-view-tree');
    const codeBtn = panel.querySelector('#jph-view-code');
    function setConfigViewMode(mode) {
      configViewMode = mode;
      panel.querySelector('#jph-config-tree').style.display = mode === 'tree' ? 'block' : 'none';
      panel.querySelector('#jph-config-view').style.display = mode === 'code' ? 'block' : 'none';
      treeBtn.style.opacity = mode === 'tree' ? '1' : '0.6';
      codeBtn.style.opacity = mode === 'code' ? '1' : '0.6';
    }
    setConfigViewMode('tree');
    setLogsVisible(!!cfg.debug);
    let lastResult = '';
    let history = loadHistory();
    let refreshSeq = 0;
    let allLoadSeq = 0;
    let byJobSeq = 0;
    let currentTab = 'all';
    let byJobFilterTimer = null;
    let allTimelineState = {
      loading: false,
      nextDay: null,
      exhausted: false,
      message: ''
    };
    let allJobPagerState = {
      initialized: false,
      jobs: [],
      offsets: {},
      exhausted: {},
      nextIndex: 0
    };
    let byJobState = {
      jobListLoaded: false,
      jobListLoading: false,
      jobList: [],
      selectedJob: parseJobFullNameFromLink(location.href) || '',
      buildsByJob: {},
      message: ''
    };

    function resetAllTimelineState() {
      allLoadSeq += 1;
      allTimelineState = {
        loading: false,
        nextDay: null,
        exhausted: false,
        message: ''
      };
      allJobPagerState = {
        initialized: false,
        jobs: [],
        offsets: {},
        exhausted: {},
        nextIndex: 0
      };
    }

    function getOldestHistoryTimestamp() {
      let oldest = Infinity;
      (history || []).forEach(item => {
        if (item && item.timestamp) oldest = Math.min(oldest, item.timestamp);
      });
      return Number.isFinite(oldest) ? oldest : Date.now();
    }

    function initAllTimelineState() {
      if (allTimelineState.nextDay !== null) return;
      allTimelineState.nextDay = Math.floor(getOldestHistoryTimestamp() / TIMELINE_DAY_MS);
    }

    async function fetchMoreTimelineHistory(baseUrl) {
      if (allTimelineState.exhausted) return [];
      initAllTimelineState();
      const incoming = [];
      const seen = new Set((history || []).map(item => item && item.id).filter(Boolean));
      let scannedDays = 0;
      while (incoming.length < HISTORY_PAGE_SIZE && scannedDays < TIMELINE_DAYS_PER_LOAD) {
        const day = allTimelineState.nextDay;
        allTimelineState.nextDay -= 1;
        scannedDays += 1;
        const builds = await fetchTimelineBuilds(baseUrl, day);
        builds.forEach(item => {
          if (!item || !item.id || seen.has(item.id)) return;
          seen.add(item.id);
          incoming.push(item);
        });
      }
      allTimelineState.message = incoming.length
        ? ''
        : `No builds found in previous ${scannedDays} day(s). Scroll again to search earlier.`;
      if (!incoming.length) allTimelineState.exhausted = true;
      return incoming;
    }

    function getHistoryJobCounts() {
      const counts = {};
      (history || []).forEach(item => {
        if (!item || !item.jobName) return;
        counts[item.jobName] = (counts[item.jobName] || 0) + 1;
      });
      return counts;
    }

    async function initAllJobPager(baseUrl) {
      if (allJobPagerState.initialized) return;
      const counts = getHistoryJobCounts();
      const latestByJob = new Map();
      (history || []).forEach(item => {
        if (!item || !item.jobName) return;
        const prev = latestByJob.get(item.jobName) || 0;
        latestByJob.set(item.jobName, Math.max(prev, item.timestamp || 0));
      });
      const jobs = Array.from(latestByJob.keys())
        .map(name => ({ name, ts: latestByJob.get(name) || 0 }))
        .sort((a, b) => b.ts - a.ts);
      try {
        const allJobs = await fetchAllJobs(baseUrl);
        allJobs
          .map(j => ({ name: j.fullName || j.name, ts: (j.lastBuild && j.lastBuild.timestamp) || 0 }))
          .sort((a, b) => b.ts - a.ts)
          .forEach(job => {
            if (job.name && !latestByJob.has(job.name)) jobs.push(job);
          });
      } catch (e) {
        if (cfg.debug) {
          panel.querySelector('#jph-logs').textContent += `Debug: job pager list error=${e.message || e}\n`;
        }
      }
      allJobPagerState.jobs = jobs.map(j => j.name).filter(Boolean);
      allJobPagerState.offsets = {};
      Object.keys(counts).forEach(jobName => {
        allJobPagerState.offsets[jobName] = counts[jobName];
      });
      allJobPagerState.exhausted = {};
      allJobPagerState.nextIndex = 0;
      allJobPagerState.initialized = true;
    }

    async function fetchMoreJobHistory(baseUrl) {
      await initAllJobPager(baseUrl);
      const jobs = allJobPagerState.jobs;
      const incoming = [];
      const seen = new Set((history || []).map(item => item && item.id).filter(Boolean));
      if (!jobs.length) return incoming;
      const jobsPerLoad = Math.min(jobs.length, Math.max(RECENT_JOB_LIMIT, 1));
      let scannedJobs = 0;
      let attempts = 0;
      while (incoming.length < HISTORY_PAGE_SIZE && scannedJobs < jobsPerLoad && attempts < jobs.length) {
        const index = allJobPagerState.nextIndex % jobs.length;
        allJobPagerState.nextIndex = (allJobPagerState.nextIndex + 1) % jobs.length;
        attempts += 1;
        const jobName = jobs[index];
        if (!jobName || allJobPagerState.exhausted[jobName]) continue;
        scannedJobs += 1;
        const offset = allJobPagerState.offsets[jobName] || 0;
        const builds = await fetchJobBuildsRange(baseUrl, jobName, offset, HISTORY_PAGE_SIZE);
        allJobPagerState.offsets[jobName] = offset + builds.length;
        if (builds.length < HISTORY_PAGE_SIZE) {
          allJobPagerState.exhausted[jobName] = true;
        }
        builds.forEach(item => {
          if (!item || !item.id || seen.has(item.id)) return;
          seen.add(item.id);
          incoming.push(item);
        });
      }
      allTimelineState.message = incoming.length
        ? ''
        : 'No more loaded jobs returned older builds.';
      return incoming.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    }

    async function loadMoreAllHistory() {
      if (allTimelineState.loading || !isLoggedIn()) return;
      const loadSeq = ++allLoadSeq;
      allTimelineState.loading = true;
      allTimelineState.message = '';
      const loadingFooter = panel.querySelector('#jph-history-all .history-more');
      if (loadingFooter) loadingFooter.textContent = 'Loading more...';
      const baseUrl = location.origin;
      try {
        let incoming = [];
        let timelineError = null;
        try {
          incoming = await fetchMoreTimelineHistory(baseUrl);
        } catch (e) {
          timelineError = e;
          crumbCache = null;
          if (cfg.debug) {
            panel.querySelector('#jph-logs').textContent += `Debug: timeline error=${e.message || e}\n`;
            panel.querySelector('#jph-logs-wrap').open = true;
          }
        }
        if (loadSeq !== allLoadSeq) return;
        if (!incoming.length) {
          incoming = await fetchMoreJobHistory(baseUrl);
        }
        if (loadSeq !== allLoadSeq) return;
        if (incoming.length) {
          history = mergeHistory(history, incoming);
        } else if (timelineError && !allTimelineState.message) {
          allTimelineState.message = `Timeline unavailable: ${timelineError.message || timelineError}`;
        }
      } catch (e) {
        allTimelineState.message = `Load more failed: ${e.message || e}`;
        if (cfg.debug) {
          panel.querySelector('#jph-logs').textContent += `Debug: load more error=${e.message || e}\n`;
          panel.querySelector('#jph-logs-wrap').open = true;
        }
      } finally {
        if (loadSeq !== allLoadSeq) return;
        const root = panel.querySelector('#jph-history-all');
        const scrollTop = root ? root.scrollTop : 0;
        allTimelineState.loading = false;
        renderHistoryLists();
        const nextRoot = panel.querySelector('#jph-history-all');
        if (nextRoot) nextRoot.scrollTop = scrollTop;
      }
    }

    function maybeLoadMoreAllHistory() {
      const root = panel.querySelector('#jph-history-all');
      if (!root || root.style.display === 'none') return;
      if (allTimelineState.loading) return;
      if (root.scrollHeight - root.scrollTop - root.clientHeight <= 48) {
        loadMoreAllHistory();
      }
    }

    function getByJobEntry(jobName) {
      const key = jobName || '';
      if (!byJobState.buildsByJob[key]) {
        byJobState.buildsByJob[key] = {
          items: [],
          offset: 0,
          loading: false,
          exhausted: false,
          message: ''
        };
      }
      return byJobState.buildsByJob[key];
    }

    function mergeBuildItems(current, incoming) {
      const map = new Map();
      (current || []).forEach(item => {
        if (item && item.id) map.set(item.id, item);
      });
      (incoming || []).forEach(item => {
        if (!item || !item.id) return;
        const prev = map.get(item.id) || {};
        map.set(item.id, { ...prev, ...item });
      });
      return Array.from(map.values()).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    }

    function findBuildItemById(itemId) {
      const existing = (history || []).find(i => i.id === itemId);
      if (existing) return existing;
      for (const entry of Object.values(byJobState.buildsByJob || {})) {
        const found = (entry.items || []).find(i => i.id === itemId);
        if (found) return found;
      }
      return null;
    }

    function updateByJobItem(item) {
      if (!item || !item.jobName) return;
      const entry = byJobState.buildsByJob[item.jobName];
      if (!entry) return;
      entry.items = mergeBuildItems(entry.items, [item]);
    }

    function getDefaultByJobName() {
      return byJobState.selectedJob
        || parseJobFullNameFromLink(location.href)
        || ((history || [])[0] && history[0].jobName)
        || ((byJobState.jobList || [])[0] && byJobState.jobList[0].name)
        || '';
    }

    async function ensureByJobList() {
      if (byJobState.jobListLoaded || byJobState.jobListLoading || !isLoggedIn()) return;
      byJobState.jobListLoading = true;
      byJobState.message = '';
      renderHistoryLists();
      try {
        const jobs = await fetchAllJobs(location.origin);
        byJobState.jobList = jobs
          .map(j => ({ name: j.fullName || j.name, ts: (j.lastBuild && j.lastBuild.timestamp) || 0 }))
          .filter(j => j.name)
          .sort((a, b) => b.ts - a.ts);
        byJobState.jobListLoaded = true;
        if (!byJobState.selectedJob) {
          byJobState.selectedJob = getDefaultByJobName();
        }
      } catch (e) {
        byJobState.message = `Job list failed: ${e.message || e}`;
        if (cfg.debug) {
          panel.querySelector('#jph-logs').textContent += `Debug: by-job list error=${e.message || e}\n`;
          panel.querySelector('#jph-logs-wrap').open = true;
        }
      } finally {
        byJobState.jobListLoading = false;
        renderHistoryLists();
      }

      const selected = byJobState.selectedJob;
      if (selected) {
        const entry = getByJobEntry(selected);
        if (!entry.items.length && !entry.loading) loadMoreByJobHistory(true);
      }
    }

    async function loadMoreByJobHistory(reset) {
      const selected = byJobState.selectedJob || getDefaultByJobName();
      if (!selected || !isLoggedIn()) return;
      byJobState.selectedJob = selected;
      const entry = getByJobEntry(selected);
      if (entry.loading || (entry.exhausted && !reset)) return;

      const seq = ++byJobSeq;
      if (reset) {
        entry.items = [];
        entry.offset = 0;
        entry.exhausted = false;
      }
      entry.loading = true;
      entry.message = '';
      renderHistoryLists();
      try {
        const builds = await fetchJobBuildsRange(location.origin, selected, entry.offset, HISTORY_PAGE_SIZE);
        if (seq !== byJobSeq || byJobState.selectedJob !== selected) return;
        entry.items = mergeBuildItems(entry.items, builds);
        entry.offset += builds.length;
        if (builds.length < HISTORY_PAGE_SIZE) entry.exhausted = true;
        if (!builds.length) entry.message = 'No builds found.';
      } catch (e) {
        if (seq === byJobSeq && byJobState.selectedJob === selected) {
          entry.message = `Load failed: ${e.message || e}`;
        }
        if (cfg.debug) {
          panel.querySelector('#jph-logs').textContent += `Debug: by-job builds error ${selected}=${e.message || e}\n`;
          panel.querySelector('#jph-logs-wrap').open = true;
        }
      } finally {
        entry.loading = false;
        if (seq !== byJobSeq || byJobState.selectedJob !== selected) return;
        renderHistoryLists();
      }
    }

    function selectByJob(jobName) {
      if (!jobName) return;
      if (byJobState.selectedJob !== jobName) {
        byJobSeq += 1;
        byJobState.selectedJob = jobName;
      }
      const entry = getByJobEntry(jobName);
      renderHistoryLists();
      if (!entry.items.length && !entry.loading) loadMoreByJobHistory(true);
    }

    function activateByJob() {
      const selected = getDefaultByJobName();
      if (selected && !byJobState.selectedJob) {
        byJobState.selectedJob = selected;
      }
      renderHistoryLists();
      ensureByJobList();
      if (byJobState.selectedJob) {
        const entry = getByJobEntry(byJobState.selectedJob);
        if (!entry.items.length && !entry.loading) loadMoreByJobHistory(true);
      }
    }

    function createHistoryActionButton(action, label, item) {
      const button = el('button', { text: label });
      button.dataset.action = action;
      button.dataset.job = item.jobName || '';
      if (action === 'open-console') {
        button.dataset.build = String(item.buildNumber || '');
      }
      return button;
    }

    function createHistoryLine(item, titleText) {
      const badgeCls = statusClass(item.result, item.building);
      const line = el('div', { class: 'history-item' });
      line.dataset.id = item.id || '';

      const title = el('div', { class: 'history-title' });
      title.appendChild(document.createTextNode(titleText));
      title.appendChild(el('span', {
        class: `badge ${badgeCls}`,
        text: item.building ? 'BUILDING' : (item.result || 'UNKNOWN')
      }));

      const meta = el('div', { class: 'history-meta' });
      [
        formatTime(item.timestamp),
        `duration: ${formatDuration(item.duration)}`,
        item.userName || '-'
      ].forEach(text => meta.appendChild(el('span', { text })));

      const actions = el('div', { class: 'history-actions' });
      actions.appendChild(createHistoryActionButton('copy-job', 'Copy Job', item));
      actions.appendChild(createHistoryActionButton('open-job', 'Open Job', item));
      actions.appendChild(createHistoryActionButton('open-console', 'Console', item));

      line.appendChild(title);
      line.appendChild(meta);
      line.appendChild(actions);
      return line;
    }

    function renderByJobHistory(byJobRoot, filterValue) {
      byJobRoot.innerHTML = '';
      if (!byJobState.selectedJob) {
        byJobState.selectedJob = getDefaultByJobName();
      }
      const selected = byJobState.selectedJob;
      const entry = selected ? getByJobEntry(selected) : null;

      const head = el('div', { class: 'byjob-head' });
      head.appendChild(el('div', { class: 'byjob-name', text: selected || 'No job selected' }));
      const statusText = byJobState.jobListLoading
        ? 'Loading jobs...'
        : (byJobState.message || `${byJobState.jobList.length} jobs loaded`);
      head.appendChild(el('div', { class: 'muted', text: statusText }));
      byJobRoot.appendChild(head);

      const normalizedFilter = filterValue.toLowerCase();
      const matchedJobs = (byJobState.jobList || [])
        .filter(job => !normalizedFilter || job.name.toLowerCase().includes(normalizedFilter));
      const pickerLimit = normalizedFilter ? 50 : 8;
      const shouldShowPicker = byJobState.jobListLoading || byJobState.jobList.length || normalizedFilter;
      if (shouldShowPicker) {
        const picker = el('div', { class: 'job-picker' });
        if (byJobState.jobListLoading) {
          picker.appendChild(el('div', { class: 'muted', style: 'padding:8px;', text: 'Loading jobs...' }));
        } else if (!matchedJobs.length) {
          picker.appendChild(el('div', { class: 'muted', style: 'padding:8px;', text: 'No matching jobs.' }));
        } else {
          matchedJobs.slice(0, pickerLimit).forEach(job => {
            const option = el('div', {
              class: `job-option${job.name === selected ? ' active' : ''}`,
              text: job.name
            });
            option.dataset.job = job.name;
            if (job.ts) option.title = `Last build: ${formatTime(job.ts)}`;
            picker.appendChild(option);
          });
        }
        byJobRoot.appendChild(picker);
      }

      if (!selected) {
        byJobRoot.appendChild(el('div', { class: 'muted', style: 'padding:8px;', text: 'No job selected.' }));
        return;
      }

      if (entry.message) {
        byJobRoot.appendChild(el('div', { class: 'muted', style: 'padding:8px;', text: entry.message }));
      }
      if (entry.items.length) {
        entry.items.forEach(item => {
          byJobRoot.appendChild(createHistoryLine(item, `#${item.buildNumber}`));
        });
      } else if (entry.loading) {
        byJobRoot.appendChild(el('div', { class: 'muted', style: 'padding:8px;', text: 'Loading builds...' }));
      } else {
        byJobRoot.appendChild(el('div', { class: 'muted', style: 'padding:8px;', text: 'No builds loaded.' }));
      }

      const moreText = entry.loading
        ? 'Loading builds...'
        : (entry.exhausted ? 'No more builds' : 'Load more builds');
      const more = el('div', { class: 'history-more', text: moreText });
      more.dataset.role = 'byjob-more';
      byJobRoot.appendChild(more);
    }

    function renderHistoryLists() {
      const allRoot = panel.querySelector('#jph-history-all');
      const byJobRoot = panel.querySelector('#jph-history-byjob');
      const filterValue = (panel.querySelector('#jph-filter')?.value || '').trim().toLowerCase();
      const sorted = sortTrimHistory(history);
      history = sorted;
      saveHistory(history);

      if (!sorted.length) {
        allRoot.replaceChildren(el('div', { class: 'muted', style: 'padding:8px;', text: 'No history.' }));
      } else {
        allRoot.innerHTML = '';
        sorted.forEach(item => {
          allRoot.appendChild(createHistoryLine(item, `${item.jobName} #${item.buildNumber}`));
        });
      }
      const moreText = allTimelineState.loading
        ? 'Loading more...'
        : (allTimelineState.message || 'Scroll or click for more');
      allRoot.appendChild(el('div', { class: 'history-more', text: moreText }));

      renderByJobHistory(byJobRoot, filterValue);
    }

    function setupBuildHistoryMenu() {
      const root = document.getElementById('buildHistory') || document.querySelector('.build-history');
      if (!root) return;

      const isMenuRoot = el => {
        if (!el || !(el instanceof Element)) return false;
        const cls = (el.className || '').toString();
        if (el.getAttribute && el.getAttribute('role') === 'menu') return true;
        return /menu|yuimenu|jenkins-menu/i.test(cls);
      };

      const injectMenuItem = menuRoot => {
        if (!menuRoot) return;
        if (menuRoot.closest('#buildHistory') && !isMenuRoot(menuRoot)) return;
        const existing = menuRoot.querySelectorAll('.jph-menu-item');
        existing.forEach(n => n.remove());
        const consoleLink = menuRoot.querySelector('a[href*="/console"]') || menuRoot.querySelector('a[href*="console"]');
        if (!consoleLink) return;
        const href = consoleLink.getAttribute('href') || '';
        const match = href.match(/\/(\d+)(?:\/|$)/);
        if (!match) return;
        const jobFullName = parseJobFullNameFromLink(href);
        if (!jobFullName) return;
        const buildNumber = match[1];

        const templateItem = consoleLink.closest('li') || consoleLink.closest('div') || consoleLink.parentElement;
        const newItem = templateItem ? templateItem.cloneNode(true) : document.createElement('li');
        let newLink = newItem.querySelector('a');
        if (!newLink) {
          newLink = document.createElement('a');
          newItem.appendChild(newLink);
        }
        newItem.classList.add('jph-menu-item');
        newLink.classList.add('jph-menu-item-link');
        newLink.setAttribute('href', '#');
        newLink.dataset.jphLabel = '复制结果';
        setMenuLabel(newLink, '复制结果');
        newLink.addEventListener('click', async e => {
          e.preventDefault();
          e.stopPropagation();
          const old = newLink.dataset.jphLabel || '复制结果';
          setMenuLabel(newLink, '处理中...');
          try {
            const output = await copyBuildResult(jobFullName, buildNumber, cfg);
            setMenuLabel(newLink, output ? '已复制' : '未匹配');
          } catch (err) {
            setMenuLabel(newLink, '失败');
          } finally {
            setTimeout(() => {
              setMenuLabel(newLink, old);
            }, 1200);
          }
        });
        const listRoot = (menuRoot.tagName === 'UL' || menuRoot.tagName === 'OL') ? menuRoot : (menuRoot.querySelector('ul,ol') || menuRoot);
        if (listRoot && listRoot.appendChild) {
          const first = listRoot.firstElementChild;
          if (first) {
            listRoot.insertBefore(newItem, first);
          } else {
            listRoot.appendChild(newItem);
          }
        }
      };

      const scanNode = node => {
        if (!(node instanceof Element)) return;
        const candidates = [];
        if (isMenuRoot(node)) candidates.push(node);
        if (node.querySelectorAll) {
          node.querySelectorAll('[role="menu"], .yuimenu, .jenkins-menu, .menu').forEach(el => candidates.push(el));
        }
        candidates.forEach(el => {
          if (el.querySelector && el.querySelector('a[href*="/console"]')) {
            injectMenuItem(el);
          }
        });
      };

      scanNode(document.body);
      if (window.__jph_history_observer) {
        window.__jph_history_observer.disconnect();
      }
      window.__jph_history_observer = new MutationObserver(muts => {
        muts.forEach(m => {
          m.addedNodes && m.addedNodes.forEach(n => scanNode(n));
        });
      });
      window.__jph_history_observer.observe(document.body, { childList: true, subtree: true });
    }

    async function refreshHistory(force) {
      if (!isLoggedIn()) {
        if (cfg.debug) {
          panel.querySelector('#jph-logs').textContent += 'Debug: skip refresh (not logged in)\n';
          panel.querySelector('#jph-logs-wrap').open = true;
        }
        return;
      }
      const seq = ++refreshSeq;
      const baseUrl = location.origin;
      const results = [];
      let recentJobs = [];
      if (force) resetAllTimelineState();
      try {
        results.push(...await fetchRecentBuildsFromRss(baseUrl, HISTORY_PAGE_SIZE));
      } catch (e) {
        if (cfg.debug) {
          panel.querySelector('#jph-logs').textContent += `Debug: rss builds error=${e.message || e}\n`;
        }
        // ignore
      }
      try {
        results.push(...await fetchCurrentBuildingBuilds(baseUrl));
      } catch (e) {
        if (cfg.debug) {
          panel.querySelector('#jph-logs').textContent += `Debug: building builds error=${e.message || e}\n`;
        }
        // ignore
      }
      if (!results.length) {
        try {
          recentJobs = await fetchRecentJobsFromRss(baseUrl, RECENT_JOB_LIMIT);
        } catch (e) {
          if (cfg.debug) {
            panel.querySelector('#jph-logs').textContent += `Debug: rss jobs error=${e.message || e}\n`;
          }
          // ignore
        }
      }
      if (!results.length && !recentJobs.length) {
        try {
          const jobs = await fetchAllJobs(baseUrl);
          recentJobs = jobs
            .map(j => ({ name: j.fullName || j.name, ts: (j.lastBuild && j.lastBuild.timestamp) || 0 }))
            .sort((a, b) => b.ts - a.ts)
            .slice(0, RECENT_JOB_LIMIT)
            .map(j => j.name);
        } catch (e) {
          if (cfg.debug) {
            panel.querySelector('#jph-logs').textContent += `Debug: api error=${e.message || e}\n`;
          }
          // ignore
        }
      }
      if (!results.length) {
        for (const jobName of recentJobs) {
          try {
            const builds = await fetchJobBuilds(baseUrl, jobName, HISTORY_PAGE_SIZE);
            results.push(...builds);
          } catch (e) {
            if (cfg.debug) {
              panel.querySelector('#jph-logs').textContent += `Debug: builds error ${jobName}=${e.message || e}\n`;
            }
            // ignore per-job errors
          }
        }
      }
      if (seq !== refreshSeq) return;
      if (force && results.length) {
        history = sortTrimHistory(results);
      } else {
        history = mergeHistory(history, results);
      }
      renderHistoryLists();
      setTimeout(maybeLoadMoreAllHistory, 0);
      if (cfg.debug) {
        panel.querySelector('#jph-logs').textContent += `Debug: refresh jobs=${recentJobs.length} builds=${results.length} force=${!!force}\n`;
        panel.querySelector('#jph-logs-wrap').open = true;
      }
    }

    async function refreshBuildingOnly() {
      const baseUrl = location.origin;
      const buildingMap = new Map();
      (history || []).forEach(item => {
        if (item && item.building && item.id) buildingMap.set(item.id, item);
      });
      Object.values(byJobState.buildsByJob || {}).forEach(entry => {
        (entry.items || []).forEach(item => {
          if (item && item.building && item.id) buildingMap.set(item.id, item);
        });
      });
      const building = Array.from(buildingMap.values());
      if (!building.length) return;
      for (const item of building) {
        try {
          const updated = await fetchBuildStatus(baseUrl, item.jobName, item.buildNumber);
          history = mergeHistory(history, [updated]);
          updateByJobItem(updated);
        } catch (e) {
          // ignore
        }
      }
      renderHistoryLists();
    }

    async function handleHistoryClick(target) {
      const itemId = target.getAttribute('data-id');
      if (!itemId) return;
      const item = findBuildItemById(itemId);
      if (!item) return;
      const rule = resolveRule(item.jobShortName || item.jobName, cfg);
      try {
        const consoleText = await fetchConsoleText(location.origin, item.jobName, item.buildNumber);
        let output = '';
        const match = extractResult(consoleText, rule ? rule.success_patterns || [] : []);
        if (match) {
          output = rule ? (rule.result_template || '{match}').replace('{match}', match) : match;
        }
        if (cfg.debug) {
          const hits = collectPackLines(consoleText);
          const logs = panel.querySelector('#jph-logs');
          logs.textContent += `Debug: console length=${consoleText.length}\n`;
          logs.textContent += `Debug: rule=${rule ? JSON.stringify(rule) : 'null'}\n`;
          logs.textContent += `Debug: raw match=${match || 'null'}\n`;
          if (rule && rule.success_patterns && rule.success_patterns[0]) {
            const dm = debugFirstMatch(consoleText, rule.success_patterns[0]);
            if (dm.error) {
              logs.textContent += `Debug: regex error=${dm.error}\n`;
            } else if (!dm.found) {
              logs.textContent += 'Debug: regex found=false\n';
            } else {
              logs.textContent += `Debug: regex m.length=${dm.length}\n`;
              logs.textContent += `Debug: regex m0=${dm.m0}\n`;
              logs.textContent += `Debug: regex m1=${dm.m1 || ''}\n`;
            }
          }
          if (!hits.length) {
            logs.textContent += 'Debug: no lines with pack keywords.\n';
          } else {
            logs.textContent += 'Debug: pack-related lines:\n';
            hits.slice(0, 15).forEach(h => {
              logs.textContent += `#${h.index} ${h.line}\n`;
            });
          }
          panel.querySelector('#jph-logs-wrap').open = true;
        }
        if (!output) {
          output = '提取失败，请查看consoleText。';
          if (cfg.debug) {
            panel.querySelector('#jph-logs-wrap').open = true;
          }
        }
        item.resultText = output;
        history = mergeHistory(history, [item]);
        updateByJobItem(item);
        renderHistoryLists();
        lastResult = output;
        panel.querySelector('#jph-result-meta').textContent = `${item.jobName} #${item.buildNumber} ${item.result || (item.building ? 'BUILDING' : '')}`.trim();
        panel.querySelector('#jph-result').textContent = output;
        if (typeof GM_setClipboard === 'function') {
          GM_setClipboard(output);
        } else if (navigator.clipboard) {
          navigator.clipboard.writeText(output).catch(() => {});
        }
      } catch (e) {
        panel.querySelector('#jph-logs').textContent += 'Error: ' + e.message + '\n';
      }
    }

    panel.querySelector('#jph-edit').addEventListener('click', () => {
      panel.querySelector('#jph-config-view').style.display = 'none';
      panel.querySelector('#jph-config-tree').style.display = 'none';
      panel.querySelector('#jph-config').style.display = 'block';
      panel.querySelector('#jph-edit').style.display = 'none';
      panel.querySelector('#jph-reset').style.display = 'none';
      panel.querySelector('#jph-save').style.display = 'inline-block';
      panel.querySelector('#jph-cancel').style.display = 'inline-block';
      panel.querySelector('#jph-msg').textContent = '';
    });

    panel.querySelector('#jph-cancel').addEventListener('click', () => {
      setConfigViewMode(configViewMode);
      panel.querySelector('#jph-config').style.display = 'none';
      panel.querySelector('#jph-edit').style.display = 'inline-block';
      panel.querySelector('#jph-reset').style.display = 'inline-block';
      panel.querySelector('#jph-save').style.display = 'none';
      panel.querySelector('#jph-cancel').style.display = 'none';
      panel.querySelector('#jph-msg').textContent = '';
    });

    panel.querySelector('#jph-reset').addEventListener('click', () => {
      const next = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      saveConfig(next);
      updateConfigView(next);
      panel.querySelector('#jph-msg').textContent = 'Reset to default';
      setConfigViewMode(configViewMode);
      setLogsVisible(!!next.debug);
      panel.querySelector('#jph-config').style.display = 'none';
      panel.querySelector('#jph-edit').style.display = 'inline-block';
      panel.querySelector('#jph-reset').style.display = 'inline-block';
      panel.querySelector('#jph-save').style.display = 'none';
      panel.querySelector('#jph-cancel').style.display = 'none';
    });

    panel.querySelector('#jph-save').addEventListener('click', () => {
      try {
        const next = JSON.parse(panel.querySelector('#jph-config').value);
        saveConfig(next);
        updateConfigView(next);
        panel.querySelector('#jph-msg').textContent = 'Saved';
        setConfigViewMode(configViewMode);
        setLogsVisible(!!next.debug);
        panel.querySelector('#jph-config').style.display = 'none';
        panel.querySelector('#jph-edit').style.display = 'inline-block';
        panel.querySelector('#jph-reset').style.display = 'inline-block';
        panel.querySelector('#jph-save').style.display = 'none';
        panel.querySelector('#jph-cancel').style.display = 'none';
      } catch (e) {
        panel.querySelector('#jph-msg').textContent = 'Invalid JSON';
      }
    });

    panel.querySelector('#jph-copy').addEventListener('click', () => {
      if (!lastResult) return;
      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(lastResult);
      } else if (navigator.clipboard) {
        navigator.clipboard.writeText(lastResult).catch(() => {});
      }
    });

    panel.querySelector('#jph-refresh').addEventListener('click', () => {
      if (currentTab === 'byjob') {
        ensureByJobList();
        if (byJobState.selectedJob) loadMoreByJobHistory(true);
      } else {
        refreshHistory(true);
      }
    });

    panel.querySelector('#jph-clear').addEventListener('click', () => {
      history = [];
      saveHistory(history);
      resetAllTimelineState();
      byJobSeq += 1;
      byJobState.buildsByJob = {};
      renderHistoryLists();
    });

    treeBtn.addEventListener('click', () => setConfigViewMode('tree'));
    codeBtn.addEventListener('click', () => setConfigViewMode('code'));
    const configWrap = panel.querySelector('#jph-config-wrap');
    if (configWrap) {
      panel.classList.toggle('jph-config-open', configWrap.open);
      configWrap.addEventListener('toggle', () => {
        panel.classList.toggle('jph-config-open', configWrap.open);
        if (configWrap.open) configWrap.scrollIntoView({ block: 'nearest' });
      });
    }

    function handleActionClick(e) {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return false;
      const action = btn.getAttribute('data-action');
      const jobName = btn.getAttribute('data-job');
      const buildNumber = btn.getAttribute('data-build');
      if (!jobName) return true;
      if (action === 'copy-job') {
        if (typeof GM_setClipboard === 'function') {
          GM_setClipboard(jobName);
        } else if (navigator.clipboard) {
          navigator.clipboard.writeText(jobName).catch(() => {});
        }
      } else if (action === 'open-job') {
        const url = normalizeUrl(location.origin, buildJobPath(jobName) + '/');
        window.open(url, '_blank');
      } else if (action === 'open-console' && buildNumber) {
        const url = normalizeUrl(location.origin, buildJobPath(jobName) + `/${buildNumber}/console`);
        window.open(url, '_blank');
      }
      return true;
    }

    panel.querySelector('#jph-history-all').addEventListener('click', e => {
      if (handleActionClick(e)) return;
      if (e.target.closest('.history-more')) {
        loadMoreAllHistory();
        return;
      }
      const el = e.target.closest('.history-item');
      if (el) handleHistoryClick(el);
    });
    panel.querySelector('#jph-history-all').addEventListener('scroll', maybeLoadMoreAllHistory);
    panel.querySelector('#jph-history-byjob').addEventListener('click', e => {
      if (handleActionClick(e)) return;
      const jobOption = e.target.closest('.job-option');
      if (jobOption && jobOption.dataset.job) {
        selectByJob(jobOption.dataset.job);
        return;
      }
      if (e.target.closest('.history-more')) {
        loadMoreByJobHistory(false);
        return;
      }
      const el = e.target.closest('.history-item');
      if (el) handleHistoryClick(el);
    });

    panel.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        panel.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const target = tab.getAttribute('data-tab');
        currentTab = target;
        panel.querySelector('#jph-history-all').style.display = target === 'all' ? 'block' : 'none';
        panel.querySelector('#jph-history-byjob').style.display = target === 'byjob' ? 'block' : 'none';
        panel.querySelector('#jph-filter-row').style.display = target === 'byjob' ? 'flex' : 'none';
        if (target === 'all') setTimeout(maybeLoadMoreAllHistory, 0);
        if (target === 'byjob') activateByJob();
      });
    });

    panel.querySelector('#jph-filter').addEventListener('input', () => {
      renderHistoryLists();
      if (currentTab === 'byjob' && !byJobState.jobListLoaded) {
        if (byJobFilterTimer) clearTimeout(byJobFilterTimer);
        byJobFilterTimer = setTimeout(() => ensureByJobList(), 300);
      }
    });

    renderHistoryLists();
    const sessionKey = 'jph_auto_refreshed_v1';
    const userKey = 'jph_user_sig_v1';
    const loginKey = 'jph_logged_in_v1';
    const currentUser = getCurrentUserName();
    const lastUser = sessionStorage.getItem(userKey) || '';
    const userChanged = currentUser && currentUser !== lastUser;
    const loggedIn = isLoggedIn();
    const lastLoggedIn = sessionStorage.getItem(loginKey) === '1';
    if (userChanged || !sessionStorage.getItem(sessionKey)) {
      refreshHistory(true);
      sessionStorage.setItem(sessionKey, '1');
    }
    sessionStorage.setItem(userKey, currentUser);
    sessionStorage.setItem(loginKey, loggedIn ? '1' : '0');
    if (window.__jph_refresh_timer) {
      clearInterval(window.__jph_refresh_timer);
    }
    if (cfg.auto_poll_building) {
      window.__jph_refresh_timer = setInterval(refreshBuildingOnly, 15000);
    }
    if (window.__jph_user_observer) {
      window.__jph_user_observer.disconnect();
    }
    const checkLoginOnce = () => {
      const nowLoggedIn = isLoggedIn();
      const prevLoggedIn = sessionStorage.getItem(loginKey) === '1';
      const nowUser = getCurrentUserName();
      const prevUser = sessionStorage.getItem(userKey) || '';
      if (nowLoggedIn && (!prevLoggedIn || (nowUser && nowUser !== prevUser))) {
        refreshHistory(true);
      }
      sessionStorage.setItem(loginKey, nowLoggedIn ? '1' : '0');
      sessionStorage.setItem(userKey, nowUser);
    };
    const header = document.querySelector('#header') || document.body;
    window.__jph_user_observer = new MutationObserver(() => checkLoginOnce());
    window.__jph_user_observer.observe(header, { childList: true, subtree: true, characterData: true });
    if (window.__jph_visibility_handler) {
      document.removeEventListener('visibilitychange', window.__jph_visibility_handler);
    }
    window.__jph_visibility_handler = () => {
      if (!document.hidden) checkLoginOnce();
    };
    document.addEventListener('visibilitychange', window.__jph_visibility_handler);
    setupBuildHistoryMenu();
  }

  function init() {
    injectStyles();
    const cfg = loadConfig();
    renderUI(cfg);
  }

  init();
})();
