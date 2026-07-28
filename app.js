/* ES2019 strict — no ?., ??, ||=, #private, top-level await */
'use strict';

// --- STATE ---
var state = {
  connected: false,
  activeTab: 'messages',
  lastMessageTs: 0,
  pollTimer: null,
  nodes: [],
  channels: [],
  messages: [],
  seenKeys: {},
  nodeCache: {},
  homeLat: null,
  homeLon: null,
  dmTarget: null,
  sortBy: 'name',
  roleFilter: 'all',
  favOnly: false,
  // Pagination
  nodePage: 0,
  nodeTotal: 0,
  msgOldestTs: null,  // oldest loaded message timestamp (for "load older")
  msgLoading: false,
};

var config = {
  serverUrl: window.location.origin,
  channel: 0,
  pollInterval: 2000,
  nodePageSize: 30,
  msgPageSize: 50,
  units: 'metric',
};

var SORT_OPTIONS = [
  { value: 'name', label: 'name' },
  { value: 'last_heard', label: 'recent' },
  { value: 'snr', label: 'snr' },
  { value: 'hops', label: 'hops' },
  { value: 'distance', label: 'distance' },
];

var ROLE_OPTIONS = [
  { value: 'all', label: 'all' },
  { value: 'CLIENT', label: 'client' },
  { value: 'CLIENT_MUTE', label: 'mute' },
  { value: 'ROUTER', label: 'router' },
  { value: 'ROUTER_CLIENT', label: 'rtr-cli' },
  { value: 'REPEATER', label: 'repeater' },
  { value: 'TRACKER', label: 'tracker' },
  { value: 'SENSOR', label: 'sensor' },
];

// --- DOM REFS (lazy init) ---
var messageList, nodeList, channelList, inputField, sendBtn, statusBar, statusDot;
var headerTitle, statNodes, statMsgs, ctxBanner, dmTargetEl, inputArea;
var msgSearch, nodeSearch, sortBtn, roleBtn, favOnlyBtn;
var deviceUrlInput, channelInput, pollInput, saveSettingsBtn, settingsInfo;
var adminInfo, deviceInfoGrid, netStatsGrid, channelUrlBox;
var selectOverlay, selectTitle, selectOptions, selectCancel;
var detailsOverlay, detailsTitle, detailsContent, detailsClose;
var emojiBtn, emojiKeyboard, unitsBtn;

function initDomRefs() {
  messageList = document.getElementById('messageList');
  nodeList = document.getElementById('nodeList');
  channelList = document.getElementById('channelList');
  inputField = document.getElementById('inputField');
  sendBtn = document.getElementById('sendBtn');
  statusBar = document.getElementById('statusBar');
  statusDot = document.getElementById('statusDot');
  headerTitle = document.getElementById('headerTitle');
  statNodes = document.getElementById('statNodes');
  statMsgs = document.getElementById('statMsgs');
  ctxBanner = document.getElementById('ctxBanner');
  dmTargetEl = document.getElementById('dmTarget');
  inputArea = document.getElementById('inputArea');
  msgSearch = document.getElementById('msgSearch');
  nodeSearch = document.getElementById('nodeSearch');
  sortBtn = document.getElementById('sortBtn');
  roleBtn = document.getElementById('roleBtn');
  favOnlyBtn = document.getElementById('favOnlyBtn');
  deviceUrlInput = document.getElementById('deviceUrlInput');
  channelInput = document.getElementById('channelInput');
  pollInput = document.getElementById('pollInput');
  saveSettingsBtn = document.getElementById('saveSettingsBtn');
  settingsInfo = document.getElementById('settingsInfo');
  adminInfo = document.getElementById('adminInfo');
  deviceInfoGrid = document.getElementById('deviceInfoGrid');
  netStatsGrid = document.getElementById('netStatsGrid');
  channelUrlBox = document.getElementById('channelUrlBox');
  selectOverlay = document.getElementById('selectOverlay');
  selectTitle = document.getElementById('selectTitle');
  selectOptions = document.getElementById('selectOptions');
  selectCancel = document.getElementById('selectCancel');
  detailsOverlay = document.getElementById('detailsOverlay');
  detailsTitle = document.getElementById('detailsTitle');
  detailsContent = document.getElementById('detailsContent');
  detailsClose = document.getElementById('detailsClose');
  emojiBtn = document.getElementById('emojiBtn');
  emojiKeyboard = document.getElementById('emojiKeyboard');
  unitsBtn = document.getElementById('unitsBtn');
}

// --- SETTINGS ---
function loadSettings() {
  // Version check — clear stale localStorage if version changed
  var VER = '11';
  var storedVer = localStorage.getItem('mesh_ver');
  if (storedVer !== VER) {
    localStorage.removeItem('mesh_since');
    localStorage.removeItem('mesh_seen');
    localStorage.removeItem('mesh_poll');
    localStorage.removeItem('mesh_ch');
    localStorage.removeItem('mesh_node_page_size');
    localStorage.removeItem('mesh_msg_page_size');
    localStorage.removeItem('mesh_units');
    localStorage.setItem('mesh_ver', VER);
  }
  var ch = localStorage.getItem('mesh_ch');
  if (ch !== null) { config.channel = parseInt(ch, 10) || 0; if (channelInput) channelInput.value = config.channel; }
  var poll = localStorage.getItem('mesh_poll');
  if (poll !== null) { config.pollInterval = (parseInt(poll, 10) || 2) * 1000; if (pollInput) pollInput.value = config.pollInterval / 1000; }
  var theme = localStorage.getItem('mesh_theme');
  if (theme === 'dark') document.body.setAttribute('data-theme', 'dark');
  var since = localStorage.getItem('mesh_since');
  if (since !== null) state.lastMessageTs = parseFloat(since) || 0;
  var nps = localStorage.getItem('mesh_node_page_size');
  if (nps !== null) config.nodePageSize = parseInt(nps, 10) || 30;
  var mps = localStorage.getItem('mesh_msg_page_size');
  if (mps !== null) config.msgPageSize = parseInt(mps, 10) || 50;
  var units = localStorage.getItem('mesh_units');
  if (units === 'imperial') { config.units = 'imperial'; if (unitsBtn) unitsBtn.textContent = 'imperial'; }
  // seenKeys built fresh each session — don't persist across page loads
  // (lastMessageTs alone handles cross-session catch-up)
}

function saveSettings() {
  var ch = parseInt(channelInput.value, 10);
  if (isNaN(ch) || ch < 0) ch = 0; if (ch > 7) ch = 7;
  config.channel = ch;
  localStorage.setItem('mesh_ch', ch);
  var poll = parseInt(pollInput.value, 10);
  if (isNaN(poll) || poll < 1) poll = 2; if (poll > 60) poll = 60;
  config.pollInterval = poll * 1000;
  localStorage.setItem('mesh_poll', poll);
  // Page sizes
  var nps = parseInt(document.getElementById('nodePageSizeInput').value, 10);
  if (isNaN(nps) || nps < 5) nps = 30; if (nps > 200) nps = 200;
  config.nodePageSize = nps;
  localStorage.setItem('mesh_node_page_size', nps);
  state.nodePage = 0;  // reset to first page
  var mps = parseInt(document.getElementById('msgPageSizeInput').value, 10);
  if (isNaN(mps) || mps < 10) mps = 50; if (mps > 200) mps = 200;
  config.msgPageSize = mps;
  localStorage.setItem('mesh_msg_page_size', mps);
  // Units
  localStorage.setItem('mesh_units', config.units);
  settingsInfo.textContent = 'saved';
  setTimeout(function () { settingsInfo.textContent = ''; }, 2000);
  restartPolling();
}

// --- API ---
function fetchJSON(url) {
  return fetch(url).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }).catch(function () { return null; });
}

function fetchStatus() { return fetchJSON(config.serverUrl + '/api/status'); }

function fetchMessages() {
  // Always fetch recent + catch-up messages from server
  // Use lastMessageTs for catch-up; also get a small recent window for dedup refresh
  var since = state.lastMessageTs > 0 ? state.lastMessageTs : 0;
  var url = config.serverUrl + '/api/messages?since=' + since + '&limit=' + config.msgPageSize;
  return fetchJSON(url);
}

function fetchOlderMessages(beforeTs) {
  return fetchJSON(config.serverUrl + '/api/messages?before=' + beforeTs + '&limit=' + config.msgPageSize);
}

function fetchNodes(page) {
  page = (page !== undefined ? page : state.nodePage);
  var offset = page * config.nodePageSize;
  return fetchJSON(config.serverUrl + '/api/nodes?limit=' + config.nodePageSize + '&offset=' + offset);
}
function fetchChannels() { return fetchJSON(config.serverUrl + '/api/channels'); }

function sendMessage(text, destNode) {
  var body = { text: text, channel: config.channel };
  if (destNode) body.dest_node = destNode;
  return fetch(config.serverUrl + '/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(function (r) { return r.json(); })
    .catch(function (e) { return { ok: false, error: e.message }; });
}

function toggleFavorite(nodeId) {
  return fetch(config.serverUrl + '/api/favorite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ node_id: nodeId, favorite: 'toggle' }),
  }).then(function (r) { return r.json(); })
    .catch(function () { return { ok: false }; });
}

function adminAction(action) {
  return fetch(config.serverUrl + '/api/admin/' + action, {
    method: 'POST',
  }).then(function (r) { return r.json(); })
    .catch(function () { return { ok: false, error: 'request failed' }; });
}

// --- UTILS ---
function escapeHtml(text) {
  if (!text) return '';
  var div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Strip emoji from text (for plain-text contexts like placeholders)
function stripEmoji(text) {
  if (!text) return '';
  var result = '';
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length) {
      var low = text.charCodeAt(i + 1);
      if (low >= 0xDC00 && low <= 0xDFFF) {
        var cp = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
        if (isEmojiCodepoint(cp)) { i++; continue; }
      }
    }
    if (code === 0xFE0F || code === 0xFE0E || code === 0x200D || code === 0x20E3) continue;
    if (isEmojiCodepoint(code)) continue;
    result += text[i];
  }
  return result;
}

// Emoji detection — covers all PNG ranges in /emoji/
function isEmojiCodepoint(cp) {
  return (cp >= 0x2300 && cp <= 0x23FF)     // Misc Technical
      || (cp >= 0x2600 && cp <= 0x27BF)     // Misc Symbols, Dingbats
      || (cp >= 0x2B00 && cp <= 0x2BFF)     // Misc Symbols and Arrows
      || (cp >= 0x12000 && cp <= 0x1247F)   // Cuneiform (1,152 PNGs in /emoji/)
      || (cp >= 0x1F000 && cp <= 0x1FBFF);  // Emoticons, Transport, Symbols (3,071 PNGs)
}

function emojiImg(codepoint) {
  var hex = codepoint.toString(16).toUpperCase();
  while (hex.length < 5) hex = '0' + hex;
  return '<img src="/emoji/U' + hex + '.png" class="emoji-img" alt="emoji">';
}

function emojiToHtml(text) {
  if (!text) return '';
  // Convert BEL glyph to bell emoji
  text = text.replace(/\x07/g, String.fromCodePoint(0x1F514));
  var result = '';
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length) {
      var low = text.charCodeAt(i + 1);
      if (low >= 0xDC00 && low <= 0xDFFF) {
        var cp = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
        if (isEmojiCodepoint(cp)) { result += emojiImg(cp); i++; continue; }
      }
    }
    if (code === 0xFE0F || code === 0xFE0E || code === 0x200D || code === 0x20E3) continue;
    if (isEmojiCodepoint(code)) { result += emojiImg(code); }
    else { result += escapeHtml(text[i]); }
  }
  return result;
}

function renderMarkdown(text) {
  if (!text) return '';
  var html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, '<span class="md-code">$1</span>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<span class="md-bold">$1</span>');
  html = html.replace(/\*([^*]+)\*/g, '<span class="md-italic">$1</span>');
  html = html.replace(/~~([^~]+)~~/g, '<span class="md-strike">$1</span>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="md-link">$1</a>');
  html = html.replace(/\n/g, '<br>');
  return html;
}

function renderText(text) {
  if (!text) return '';
  // Convert BEL glyph (U+0007 / \x07) to bell emoji
  var processed = text.replace(/\x07/g, String.fromCodePoint(0x1F514));
  var md = renderMarkdown(processed);
  var result = '';
  for (var i = 0; i < md.length; i++) {
    var code = md.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF && i + 1 < md.length) {
      var low = md.charCodeAt(i + 1);
      if (low >= 0xDC00 && low <= 0xDFFF) {
        var cp = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
        if (isEmojiCodepoint(cp)) { result += emojiImg(cp); i++; continue; }
      }
    }
    if (code === 0xFE0F || code === 0xFE0E || code === 0x200D || code === 0x20E3) continue;
    if (isEmojiCodepoint(code)) { result += emojiImg(code); }
    else { result += md[i]; }
  }
  return result;
}

function formatTime(timestamp) {
  if (!timestamp) return '--:--';
  var d = new Date(timestamp * 1000);
  var h = d.getHours(); var m = d.getMinutes();
  return (h < 10 ? '0' + h : '' + h) + ':' + (m < 10 ? '0' + m : '' + m);
}

function timeAgo(timestamp) {
  if (!timestamp) return '';
  var now = Math.floor(Date.now() / 1000);
  var diff = now - timestamp;
  if (diff < 0) return 'now';
  if (diff < 60) return diff + 's';
  if (diff < 3600) return Math.floor(diff / 60) + 'm';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h';
  return Math.floor(diff / 86400) + 'd';
}

function calcDistance(lat1, lon1, lat2, lon2) {
  if (lat1 === null || lat2 === null) return null;
  var R = 6371;
  var dLat = (lat2 - lat1) * Math.PI / 180;
  var dLon = (lon2 - lon1) * Math.PI / 180;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearing(lat1, lon1, lat2, lon2) {
  if (lat1 === null || lat2 === null) return '';
  var dLon = (lon2 - lon1) * Math.PI / 180;
  var y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
  var x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
    Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
  var brng = ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
  var dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(brng / 45) % 8];
}

// --- UNITS ---
function isImperial() { return config.units === 'imperial'; }
function formatTemp(celsius) {
  if (celsius === undefined || celsius === null) return '';
  if (isImperial()) return Math.round(celsius * 9 / 5 + 32) + '\u00B0F';
  return celsius.toFixed(1) + '\u00B0C';
}
function formatDist(km) {
  if (km === undefined || km === null) return '';
  if (isImperial()) return (km * 0.621371).toFixed(1) + ' mi';
  return km.toFixed(1) + ' km';
}
function formatAlt(meters) {
  if (meters === undefined || meters === null) return '';
  if (isImperial()) return Math.round(meters * 3.28084) + ' ft';
  return meters + ' m';
}

function getNodeName(nodeId) {
  if (!nodeId) return '?';
  var node = state.nodeCache[nodeId];
  if (node) return node.long_name || node.short_name || nodeId;
  return nodeId;
}

function getNodeDistance(node) {
  if (!node.position || !node.position.lat || state.homeLat === null) return null;
  return calcDistance(state.homeLat, state.homeLon, node.position.lat, node.position.lon);
}

// --- EMOJI KEYBOARD ---
var EMOJI_LIST = [
  0x1F600, 0x1F602, 0x1F923, 0x2764, 0x1F525, 0x1F44D,
  0x1F44E, 0x2705, 0x274C, 0x26A0, 0x2B50, 0x2728,
  0x1F4AF, 0x1F389, 0x1F64F, 0x1F44B, 0x1F91D, 0x1F4AA,
  0x1FAE0, 0x1F914, 0x1F308, 0x1F431, 0x1F436, 0x1F4E1,
];

function buildEmojiKeyboard() {
  var html = '';
  for (var e = 0; e < EMOJI_LIST.length; e++) {
    var cp = EMOJI_LIST[e];
    var hex = cp.toString(16).toUpperCase();
    while (hex.length < 5) hex = '0' + hex;
    html += '<button class="emoji-key" data-cp="' + String.fromCodePoint(cp) + '">' +
      '<img src="/emoji/U' + hex + '.png" class="emoji-img" alt="">' +
      '</button>';
  }
  emojiKeyboard.innerHTML = html;

  var keys = emojiKeyboard.querySelectorAll('.emoji-key');
  for (var k = 0; k < keys.length; k++) {
    keys[k].addEventListener('click', function () {
      var ch = this.getAttribute('data-cp');
      insertAtCursor(inputField, ch);
      emojiKeyboard.style.display = 'none';
    });
  }
}

function insertAtCursor(input, text) {
  var start = input.selectionStart || 0;
  var end = input.selectionEnd || 0;
  var before = input.value.substring(0, start);
  var after = input.value.substring(end);
  input.value = before + text + after;
  input.selectionStart = input.selectionEnd = start + text.length;
  input.focus();
}

// --- OVERLAYS ---
function showSelect(title, options, currentValue, callback) {
  selectTitle.textContent = title;
  selectOptions.innerHTML = '';
  for (var i = 0; i < options.length; i++) {
    (function (opt) {
      var btn = document.createElement('button');
      btn.className = 'select-option';
      if (opt.value === currentValue) btn.classList.add('selected');
      btn.textContent = opt.label;
      btn.addEventListener('click', function () {
        selectOverlay.classList.remove('active');
        callback(opt.value);
      });
      selectOptions.appendChild(btn);
    })(options[i]);
  }
  selectOverlay.classList.add('active');
}

function showDetails(title, html) {
  detailsTitle.innerHTML = title;
  detailsContent.innerHTML = html;
  detailsOverlay.classList.add('active');
}

// --- STATUS ---
function setStatus(text, type) {
  statusBar.textContent = text;
  statusBar.className = 'status-bar' + (type ? ' ' + type : '');
}

function setConnected(connected) {
  state.connected = connected;
  statusDot.className = 'status-dot ' + (connected ? 'online' : 'offline');
  statusDot.textContent = connected ? '\u25CF' : '\u25CB';
}

// --- MESSAGE INGESTION (data merge only, no rendering) ---
function makeMsgKey(msg) {
  // Unique key: combination of from node, packet sequence, text content
  // Timestamp floored to 2s buckets to handle small timing variations
  var bucket = Math.floor((msg.timestamp || 0) / 2);
  return (msg.from || '') + '|' + bucket + '|' + (msg.text || '').substring(0, 40);
}

function ingestMessages(data) {
  // Pure data ingestion — merge new messages into state, no rendering
  if (!data || !data.messages || !data.messages.length) return 0;

  var newMessages = data.messages;
  var added = 0;
  var maxTs = state.lastMessageTs;

  for (var i = 0; i < newMessages.length; i++) {
    var msg = newMessages[i];
    var ts = msg.timestamp || 0;
    // Don't advance lastMessageTs for our own sent messages —
    // they have timestamps after any received messages and would
    // cause ?since= to skip older messages on next page load
    if (!msg.is_own && ts > maxTs) maxTs = ts;

    var key = makeMsgKey(msg);
    if (state.seenKeys[key]) continue;

    state.seenKeys[key] = true;
    state.messages.push(msg);
    added++;
  }

  // Update lastMessageTs
  if (maxTs > state.lastMessageTs) {
    state.lastMessageTs = maxTs;
    try { localStorage.setItem('mesh_since', String(maxTs)); } catch (e) {}
  }

  // seenKeys is session-only — no persistence needed

  // Track oldest loaded message for backward pagination
  if (state.messages.length > 0 && state.messages[0].timestamp > 0) {
    state.msgOldestTs = state.messages[0].timestamp;
  }

  // Trim message buffer to 2x page size — keeps scrollback available
  // without unbounded growth. At default 50 msg page size, holds 100.
  var maxMsgs = config.msgPageSize * 2;
  if (state.messages.length > maxMsgs) {
    state.messages = state.messages.slice(-maxMsgs);
    // Recompute oldest after trim
    if (state.messages.length > 0) {
      state.msgOldestTs = state.messages[0].timestamp;
    }
  }

  // Prune seenKeys — keep only keys for messages still in the buffer
  var keepKeys = {};
  for (var ki = 0; ki < state.messages.length; ki++) {
    keepKeys[makeMsgKey(state.messages[ki])] = true;
  }
  state.seenKeys = keepKeys;

  return added;
}

// --- MESSAGE RENDERING (pure filter+render, no merge) ---
function renderMessageList() {
  // Pure render — filter state.messages by search term, render DOM
  var term = (msgSearch && msgSearch.value ? msgSearch.value : '').toLowerCase();

  // Start with all messages or apply filter
  var filtered;
  if (term) {
    filtered = [];
    for (var i = 0; i < state.messages.length; i++) {
      var m = state.messages[i];
      var fromName = stripEmoji(getNodeName(m.from)).toLowerCase();
      var text = (m.text || '').toLowerCase();
      if (fromName.indexOf(term) >= 0 || text.indexOf(term) >= 0) {
        filtered.push(m);
      }
    }
  } else {
    filtered = state.messages;
  }

  // Filter by channel (unless 'all' mode: config.channel < 0)
  if (config.channel >= 0) {
    var chFiltered = [];
    for (var c = 0; c < filtered.length; c++) {
      if (filtered[c].channel === config.channel) chFiltered.push(filtered[c]);
    }
    filtered = chFiltered;
  }

  // Filter by DM target (only show messages to/from that node)
  if (state.dmTarget) {
    var dmFiltered = [];
    for (var d = 0; d < filtered.length; d++) {
      var dm = filtered[d];
      if (dm.from === state.dmTarget || dm.to === state.dmTarget) dmFiltered.push(dm);
    }
    filtered = dmFiltered;
  }

  // Show last N messages (where N = msgPageSize, default 50)
  var show = filtered.slice(-config.msgPageSize);

  if (show.length === 0) {
    messageList.innerHTML = '<div class="empty-state">' +
      (term ? 'no matches' : 'no messages yet') + '</div>';
    return;
  }

  var html = '';

  // "Load older" button at top — only show when:
  // 1. Not searching (search filters the full set, not server-side)
  // 2. We have older messages available in state
  var hasOlder = !term && filtered.length >= config.msgPageSize &&
    state.messages.length > 0 && state.messages[0].timestamp > 0 &&
    state.msgOldestTs !== null;
  if (hasOlder && !state.msgLoading) {
    html += '<div class="page-nav"><button class="btn btn-mini" id="loadOlderBtn">&#9650; older messages</button></div>';
  } else if (hasOlder && state.msgLoading) {
    html += '<div class="page-nav"><span class="page-nav-info">loading...</span></div>';
  }

  var offset = state.messages.length - show.length;
  for (var s = 0; s < show.length; s++) {
    var m = show[s];
    var fromName = getNodeName(m.from);
    var time = formatTime(m.timestamp);
    var cls = m.is_own ? 'msg-item own' : 'msg-item';
    var tags = '';
    if (m.to && m.to !== '!ffffffff' && m.to !== '!FFFFFFFF') tags += '<span class="meta-tag">DM</span>';
    if (m.is_own) tags += '<span class="meta-tag">sent</span>';
    if (m.via_mqtt) tags += '<span class="meta-tag">mqtt</span>';
    else tags += '<span class="meta-tag">lora</span>';

    var hops = '';
    if (m.hops_taken !== undefined && m.hops_taken !== null) hops = ' ' + m.hops_taken + 'h';

    html += '<div class="' + cls + '" data-msgidx="' + (offset + s) + '">' +
      '<div class="msg-meta">' +
      '<span class="meta-name">' + renderText(fromName) + '</span>' +
      '<span>ch' + (m.channel || 0) + '</span>' +
      '<span>' + time + hops + '</span>' +
      tags +
      '</div>' +
      '<div class="msg-text">' + renderText(m.text) + '</div>' +
      '</div>';
  }
  messageList.innerHTML = html;

  // Auto-scroll to bottom (new messages arrive at the end)
  messageList.scrollTop = messageList.scrollHeight;

  // Wire load-older button
  var olderBtn = document.getElementById('loadOlderBtn');
  if (olderBtn) {
    olderBtn.addEventListener('click', function () {
      if (state.msgLoading) return;
      state.msgLoading = true;
      renderMessageList();
      fetchOlderMessages(state.msgOldestTs).then(function (data) {
        state.msgLoading = false;
        if (data && data.messages && data.messages.length > 0) {
          // Track new oldest timestamp
          if (data.messages.length > 0) {
            state.msgOldestTs = data.messages[0].timestamp;
          }
          // Prepend to message list (oldest first, so prepend in reverse)
          for (var oi = data.messages.length - 1; oi >= 0; oi--) {
            var oldMsg = data.messages[oi];
            var okey = makeMsgKey(oldMsg);
            if (!state.seenKeys[okey]) {
              state.seenKeys[okey] = true;
              state.messages.unshift(oldMsg);
            }
          }
        }
        renderMessageList();
        // Scroll to where old content starts — approximate by scroll height diff
        if (messageList.lastElementChild) {
          messageList.lastElementChild.scrollIntoView(false);
        }
      });
    });
  }

  // Wire long-press
  var msgItems = messageList.querySelectorAll('.msg-item');
  wireLongPress(msgItems, function (idx) {
    var real = state.messages[parseInt(idx, 10)];
    if (real) showMsgDetails(real);
  });
}

// Combined: ingest then render (used by poll path)
function processMessages(data) {
  var added = ingestMessages(data);
  renderMessageList();
  if (statMsgs) statMsgs.textContent = state.messages.length + ' msgs';
  flashNewMessages(added);
  return added;
}

function flashNewMessages(count) {
  if (!count || count <= 0) return;
  var allMsgs = messageList.querySelectorAll('.msg-item');
  if (allMsgs.length === 0) return;
  // Flash last N messages (capped at visible count)
  var startIdx = Math.max(0, allMsgs.length - Math.min(count, allMsgs.length));
  function flashOn() {
    for (var i = startIdx; i < allMsgs.length; i++) {
      if (allMsgs[i]) allMsgs[i].classList.add('flash-new');
    }
  }
  function flashOff() {
    for (var j = startIdx; j < allMsgs.length; j++) {
      if (allMsgs[j]) allMsgs[j].classList.remove('flash-new');
    }
  }
  flashOn();
  setTimeout(function () {
    flashOff();
    setTimeout(function () {
      flashOn();
      setTimeout(function () {
        flashOff();
      }, 500);
    }, 500);
  }, 500);
}

function showMsgDetails(msg) {
  var fromName = getNodeName(msg.from);
  var toName = msg.to ? getNodeName(msg.to) : 'broadcast';
  var senderNode = state.nodeCache[msg.from];

  var html = '<div class="info-grid">';
  html += infoRow('from', renderText(fromName), true);
  html += infoRow('from id', msg.from || '--');
  html += infoRow('to', toName === 'broadcast' ? toName : renderText(toName), true);
  html += infoRow('to id', msg.to || 'broadcast');
  html += infoRow('channel', 'ch' + (msg.channel || 0));
  html += infoRow('time', formatTime(msg.timestamp));
  html += infoRow('transport', msg.via_mqtt ? 'MQTT' : 'LoRa');
  if (msg.is_own) html += infoRow('direction', 'sent by you');
  if (msg.hops_taken !== undefined && msg.hops_taken !== null)
    html += infoRow('hops taken', msg.hops_taken);
  if (msg.snr !== undefined && msg.snr !== null)
    html += infoRow('snr', msg.snr + ' dB');
  if (msg.relay_node)
    html += infoRow('relay', msg.relay_node);
  if (senderNode) {
    if (senderNode.hops_away !== undefined && senderNode.hops_away !== null)
      html += infoRow('sender hops away', senderNode.hops_away);
    if (senderNode.role)
      html += infoRow('role', senderNode.role);
  }
  html += '</div>';
  html += '<div style="margin-top:12px;font-size:14px;white-space:pre-wrap;word-break:break-word;">' + renderText(msg.text) + '</div>';

  showDetails(emojiToHtml(fromName), html);
}

// --- RENDER: NODES ---
function renderNodes(data) {
  if (!data || !data.nodes) return;

  // If the API returned paginated results, use total from response.
  // Otherwise fall back to length of returned nodes (full list).
  state.nodes = data.nodes;
  state.nodeTotal = data.total || data.nodes.length;

  // Build node cache from ALL nodes the server knows — we get this
  // from the status endpoint which sends node_count, but for the cache
  // we only have the current page's nodes. For DM targeting we need the
  // full cache, so keep old entries + merge new page.
  var cache = {};
  // Preserve existing cache entries first
  if (state.nodeCache) {
    for (var ck in state.nodeCache) { cache[ck] = state.nodeCache[ck]; }
  }
  // Overlay current page data
  for (var i = 0; i < state.nodes.length; i++) {
    cache[state.nodes[i].id] = state.nodes[i];
  }
  state.nodeCache = cache;

  // Find home (first favorite with position)
  for (var j = 0; j < state.nodes.length; j++) {
    if (state.nodes[j].is_favorite && state.nodes[j].position) {
      state.homeLat = state.nodes[j].position.lat;
      state.homeLon = state.nodes[j].position.lon;
      break;
    }
  }

  // Apply filters to the CURRENT PAGE's nodes
  var term = (nodeSearch.value || '').toLowerCase();
  var filtered = state.nodes;

  if (term) {
    filtered = [];
    for (var k = 0; k < state.nodes.length; k++) {
      var nk = state.nodes[k];
      var name = (nk.long_name || nk.short_name || nk.id || '').toLowerCase();
      if (name.indexOf(term) >= 0) filtered.push(nk);
    }
  }

  if (state.roleFilter !== 'all') {
    filtered = filtered.filter(function (n) { return n.role === state.roleFilter; });
  }

  if (state.favOnly) {
    filtered = filtered.filter(function (n) { return n.is_favorite; });
  }

  // Sort
  var sb = state.sortBy;
  filtered.sort(function (a, b) {
    if (sb === 'name') return (a.long_name || a.id || '').localeCompare(b.long_name || b.id || '');
    if (sb === 'last_heard') return (b.last_heard || 0) - (a.last_heard || 0);
    if (sb === 'snr') return (b.snr !== null ? b.snr : -999) - (a.snr !== null ? a.snr : -999);
    if (sb === 'hops') return (a.hops_away !== null ? a.hops_away : 999) - (b.hops_away !== null ? b.hops_away : 999);
    if (sb === 'distance') {
      var da = getNodeDistance(a); var db = getNodeDistance(b);
      return (da !== null ? da : 99999) - (db !== null ? db : 99999);
    }
    return 0;
  });

  var totalPages = Math.max(1, Math.ceil(state.nodeTotal / config.nodePageSize));

  if (filtered.length === 0) {
    var emptyHtml = '<div class="empty-state">' + (term ? 'no matches' : 'no nodes discovered') + '</div>';
    // Still show pagination if there are pages
    if (totalPages > 1) {
      emptyHtml += buildPageNav(state.nodePage, totalPages);
    }
    nodeList.innerHTML = emptyHtml;
    wirePageNav();
    return;
  }

  var html = '';

  // Page navigation header
  if (totalPages > 1) {
    html += buildPageNav(state.nodePage, totalPages);
  }

  for (var x = 0; x < filtered.length; x++) {
    var node = filtered[x];
    var displayName = node.long_name || node.short_name || node.id || '?';
    var ago = timeAgo(node.last_heard);
    var favCls = node.is_favorite ? ' fav' : '';

    html += '<div class="node-row' + favCls + '" data-nodeid="' + escapeHtml(node.id) + '">';
    // Short name badge (only if different from display name) — emoji icon before name
    if (node.short_name && node.long_name && node.short_name !== node.long_name) {
      html += '<span class="name-badge">' + emojiToHtml(node.short_name) + '</span>';
    }
    html += '<span class="node-name">' + emojiToHtml(displayName) + '</span>';
    // Favorite star badge
    if (node.is_favorite) {
      html += '<span class="name-badge" style="background:transparent;font-size:14px;">' +
        emojiImg(0x2B50) + '</span>';
    }
    html += '<span class="node-id">' + escapeHtml(node.id) + '</span>';
    html += '<span class="node-meta">' + ago + '</span>';

    // Tags row
    html += '<div class="node-tags">';
    if (node.role) html += '<span class="node-tag">' + escapeHtml(node.role) + '</span>';
    if (node.telemetry) {
      var t = node.telemetry;
      if (t.battery !== undefined && t.battery !== null) {
        var batTag = 'bat ' + t.battery + '%';
        if (t.battery >= 100) batTag += ' ' + emojiImg(0x1F50C);
        html += '<span class="node-tag' + (t.battery < 10 ? ' warn' : '') + '">' + batTag + '</span>';
      }
      if (t.temp !== undefined && t.temp !== null)
        html += '<span class="node-tag">' + formatTemp(t.temp) + '</span>';
      if (t.voltage !== undefined && t.voltage !== null)
        html += '<span class="node-tag">' + t.voltage.toFixed(1) + 'V</span>';
    }
    if (node.snr !== undefined && node.snr !== null)
      html += '<span class="node-tag">snr ' + node.snr + '</span>';
    if (node.hops_away !== undefined && node.hops_away !== null)
      html += '<span class="node-tag">' + node.hops_away + 'h</span>';
    if (node.via_mqtt)
      html += '<span class="node-tag">mqtt</span>';
    if (node.position) {
      var dist = getNodeDistance(node);
      if (dist !== null) {
        var brng = bearing(state.homeLat, state.homeLon, node.position.lat, node.position.lon);
        html += '<span class="node-tag">' + formatDist(dist) + ' ' + brng + '</span>';
      }
    }
    html += '</div></div>';
  }

  // Page navigation footer
  if (totalPages > 1) {
    html += buildPageNav(state.nodePage, totalPages);
  }

  nodeList.innerHTML = html;

  // Wire long-press
  var nodeRows = nodeList.querySelectorAll('.node-row');
  wireLongPress(nodeRows, function (nodeId) {
    var nd = state.nodeCache[nodeId];
    if (nd) showNodeDetails(nd);
  });

  // Wire page nav buttons
  wirePageNav();
}

function buildPageNav(currentPage, totalPages) {
  var html = '<div class="page-nav">';
  if (currentPage > 0) {
    html += '<button class="btn btn-mini page-prev" data-page="' + (currentPage - 1) + '">&#9664; prev</button>';
  } else {
    html += '<span class="page-nav-spacer"></span>';
  }
  html += '<span class="page-nav-info">page ' + (currentPage + 1) + ' / ' + totalPages + '</span>';
  if (currentPage + 1 < totalPages) {
    html += '<button class="btn btn-mini page-next" data-page="' + (currentPage + 1) + '">next &#9654;</button>';
  } else {
    html += '<span class="page-nav-spacer"></span>';
  }
  html += '</div>';
  return html;
}

function wirePageNav() {
  var prevBtns = nodeList.querySelectorAll('.page-prev');
  for (var p = 0; p < prevBtns.length; p++) {
    (function(btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        state.nodePage = parseInt(btn.getAttribute('data-page'), 10);
        fetchNodes().then(renderNodes);
      });
    })(prevBtns[p]);
  }
  var nextBtns = nodeList.querySelectorAll('.page-next');
  for (var n = 0; n < nextBtns.length; n++) {
    (function(btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        state.nodePage = parseInt(btn.getAttribute('data-page'), 10);
        fetchNodes().then(renderNodes);
      });
    })(nextBtns[n]);
  }
}

function formatUptime(seconds) {
  if (!seconds || seconds <= 0) return '--';
  var d = Math.floor(seconds / 86400);
  var h = Math.floor((seconds % 86400) / 3600);
  if (d > 0) return d + 'd' + h + 'h';
  var m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return h + 'h' + m + 'm';
  return m + 'm';
}

function showNodeDetails(node) {
  var name = node.long_name || node.short_name || node.id || '?';
  var html = '<div class="info-grid">';
  html += infoRow('name', name);
  html += infoRow('short', node.short_name || '--');
  html += infoRow('id', node.id || '--');
  html += infoRow('role', node.role || '--');
  html += infoRow('hw', node.hw_model || '--');
  html += infoRow('heard', timeAgo(node.last_heard));
  if (node.snr !== undefined && node.snr !== null) html += infoRow('snr', node.snr + ' dB');
  if (node.hops_away !== undefined && node.hops_away !== null) html += infoRow('hops', node.hops_away);
  if (node.via_mqtt) html += infoRow('mqtt', 'yes');
  html += '</div>';

  if (node.position) {
    html += '<div class="section-head" style="margin-top:12px;">position</div>';
    html += '<div class="info-grid">';
    html += infoRow('lat', node.position.lat !== undefined ? node.position.lat.toFixed(6) : '--');
    html += infoRow('lon', node.position.lon !== undefined ? node.position.lon.toFixed(6) : '--');
    if (node.position.alt !== undefined && node.position.alt !== null)
      html += infoRow('alt', formatAlt(node.position.alt));
    var dist = getNodeDistance(node);
    if (dist !== null) {
      html += infoRow('dist', formatDist(dist));
      var brngVal = bearing(state.homeLat, state.homeLon, node.position.lat, node.position.lon);
      if (brngVal) html += infoRow('brng', brngVal);
    }
    html += '</div>';
  }

  if (node.telemetry) {
    var t = node.telemetry;
    html += '<div class="section-head" style="margin-top:12px;">telemetry</div>';
    html += '<div class="info-grid">';
    if (t.battery !== undefined && t.battery !== null) html += infoRow('bat', t.battery + '%');
    if (t.voltage !== undefined && t.voltage !== null) html += infoRow('volt', t.voltage.toFixed(3) + 'V');
    if (t.temp !== undefined && t.temp !== null) html += infoRow('temp', formatTemp(t.temp));
    if (t.humidity !== undefined && t.humidity !== null) html += infoRow('hum', t.humidity + '%');
    if (t.pressure !== undefined && t.pressure !== null) html += infoRow('pres', t.pressure + ' hPa');
    if (t.channel_util !== undefined && t.channel_util !== null)
      html += infoRow('ch util', t.channel_util.toFixed(1) + '%');
    html += '</div>';
  }

  if (node.uptime) {
    html += '<div class="section-head" style="margin-top:12px;">device</div>';
    html += '<div class="info-grid">';
    html += infoRow('uptime', formatUptime(node.uptime));
    html += '</div>';
  }

  html += '<div class="node-actions" style="margin-top:12px;">' +
    '<button class="btn btn-mini" id="detDmBtn">DM</button>' +
    '<button class="btn btn-mini" id="detFavBtn">' + (node.is_favorite ? 'unfav' : 'fav') + '</button>' +
    '</div>';

  showDetails(emojiToHtml(name), html);

  var dmBtn = document.getElementById('detDmBtn');
  if (dmBtn) dmBtn.addEventListener('click', function () {
    detailsOverlay.classList.remove('active');
    setDMTarget(node.id);
    switchTab('messages');
  });
  var favBtn = document.getElementById('detFavBtn');
  if (favBtn) favBtn.addEventListener('click', function () {
    toggleFavorite(node.id).then(function () { pollAll(); });
  });
}

function infoRow(label, value, raw) {
  return '<div class="info-row"><span class="info-label">' + escapeHtml(label) +
    '</span><span class="info-val">' + (raw ? value : escapeHtml(String(value))) + '</span></div>';
}

// --- LONG PRESS ---
function wireLongPress(elements, callback) {
  for (var i = 0; i < elements.length; i++) {
    (function (el) {
      var timer = null;
      el.addEventListener('touchstart', function () {
        timer = setTimeout(function () {
          timer = null;
          var nid = el.getAttribute('data-nodeid');
          var mid = el.getAttribute('data-msgidx');
          if (nid) callback(nid);
          else if (mid) callback(mid);
          else callback(i);
        }, 500);
      });
      el.addEventListener('touchend', function () { if (timer) { clearTimeout(timer); timer = null; } });
      el.addEventListener('touchmove', function () { if (timer) { clearTimeout(timer); timer = null; } });
      el.addEventListener('mousedown', function () {
        timer = setTimeout(function () {
          timer = null;
          var nid = el.getAttribute('data-nodeid');
          var mid = el.getAttribute('data-msgidx');
          if (nid) callback(nid);
          else if (mid) callback(mid);
          else callback(i);
        }, 500);
      });
      el.addEventListener('mouseup', function () { if (timer) { clearTimeout(timer); timer = null; } });
      el.addEventListener('mouseleave', function () { if (timer) { clearTimeout(timer); timer = null; } });
    })(elements[i]);
  }
}

// --- RENDER: CHANNELS ---
function renderChannels(data) {
  if (!data || !data.channels) return;
  var channels = data.channels;
  state.channels = channels;
  updateCtxBanner();

  var active = [];
  for (var i = 0; i < channels.length; i++) {
    if (channels[i].role !== 'DISABLED') active.push(channels[i]);
  }

  if (active.length === 0) {
    channelList.innerHTML = '<div class="empty-state">no active channels</div>';
    return;
  }

  var html = '';
  for (var j = 0; j < active.length; j++) {
    var ch = active[j];
    var cls = (ch.index === config.channel) ? 'ch-row active' : 'ch-row';
    var role = '';
    if (ch.role === 'PRIMARY') role = 'PRIMARY';
    else if (ch.role === 'SECONDARY') role = 'SECONDARY';

    html += '<div class="' + cls + '" data-chidx="' + ch.index + '">';
    html += '<span class="ch-name">' + escapeHtml(ch.name || ('ch' + ch.index)) + '</span>';
    if (role) html += '<span class="node-tag">' + role + '</span>';
    html += '<span class="ch-meta">idx ' + ch.index +
      ' up:' + (ch.uplink_enabled ? 'y' : 'n') +
      ' dn:' + (ch.downlink_enabled ? 'y' : 'n') +
      '</span>';
    html += '</div>';
  }

  channelList.innerHTML = html;

  var cards = channelList.querySelectorAll('.ch-row');
  for (var k = 0; k < cards.length; k++) {
    cards[k].addEventListener('click', function () {
      var idx = parseInt(this.getAttribute('data-chidx'), 10);
      if (isNaN(idx)) return;
      config.channel = idx;
      localStorage.setItem('mesh_ch', idx);
      renderChannels({ channels: state.channels });
      switchTab('messages');
      updateCtxBanner();
    });
  }
}

// --- RENDER: SETTINGS ---
function renderDeviceInfo(status) {
  if (!status || !status.device_info || !status.device_info.node_id) {
    deviceInfoGrid.innerHTML = '<div class="info-row"><span class="info-val">no device connected</span></div>';
    return;
  }
  var d = status.device_info;
  var html = '';
  if (d.long_name) html += infoRow('name', d.long_name);
  if (d.short_name) html += infoRow('short', d.short_name);
  if (d.node_id) html += infoRow('node', d.node_id);
  if (d.role) html += infoRow('role', d.role);
  if (d.hw_model) html += infoRow('hw', d.hw_model);
  if (d.firmware) html += infoRow('fw', d.firmware);
  deviceInfoGrid.innerHTML = html;
}

function renderNetStats(status) {
  if (!status || !status.net_stats) {
    netStatsGrid.innerHTML = '<div class="info-row"><span class="info-val">no stats</span></div>';
    return;
  }
  var s = status.net_stats;
  var html = '';
  if (s.num_online !== undefined) html += infoRow('online', s.num_online + '/' + s.num_total);
  if (s.packets_tx !== undefined) html += infoRow('tx', s.packets_tx);
  if (s.packets_rx !== undefined) html += infoRow('rx', s.packets_rx);
  if (s.packets_rx_bad !== undefined) html += infoRow('bad pkts', s.packets_rx_bad);
  if (s.noise_floor !== undefined) html += infoRow('noise', s.noise_floor + ' dBm');
  if (s.heap_free !== undefined) html += infoRow('heap', s.heap_free + '/' + s.heap_total + ' free');
  netStatsGrid.innerHTML = html;
}

function renderChannelUrl(status) {
  if (!status || !status.channel_url) {
    channelUrlBox.innerHTML = 'no url';
    return;
  }
  channelUrlBox.innerHTML = escapeHtml(status.channel_url);
}

// --- DM ---
function setDMTarget(nodeId) {
  if (state.dmTarget === nodeId) { clearDMTarget(); return; }
  state.dmTarget = nodeId;
  var name = getNodeName(nodeId);
  inputField.placeholder = 'DM ' + stripEmoji(name) + '...';
  dmTargetEl.innerHTML = 'to: ' + renderText(name) + ' (tap to cancel)';
  dmTargetEl.className = 'dm-target active';
  updateCtxBanner();
}

function clearDMTarget() {
  state.dmTarget = null;
  inputField.placeholder = 'broadcast...';
  dmTargetEl.textContent = '';
  dmTargetEl.className = 'dm-target';
  updateCtxBanner();
  renderMessageList();
}

function updateCtxBanner() {
  var chName = 'ch' + config.channel;
  for (var i = 0; i < state.channels.length; i++) {
    if (state.channels[i].index === config.channel) {
      chName = state.channels[i].name || chName;
      break;
    }
  }
  ctxBanner.innerHTML = '<span>channel: ' + escapeHtml(chName) + '</span>';
}

// --- POLLING ---
function pollAll() {
  // Blink status dot on each poll cycle
  if (statusDot && state.connected) {
    statusDot.textContent = '\u25CB';
    setTimeout(function () { if (state.connected) statusDot.textContent = '\u25CF'; }, 400);
  }
  fetchStatus().then(function (status) {
    if (status) {
      setConnected(status.connected);
      var nodeCount = status.node_count || 0;
      if (status.connected) {
        setStatus('online \u2022 ' + nodeCount + ' nodes');
        statNodes.textContent = nodeCount + ' nodes';
      } else {
        setStatus(status.error || 'offline', 'error');
        statNodes.textContent = 'offline';
      }
      if (state.activeTab === 'settings') {
        renderDeviceInfo(status);
        renderNetStats(status);
        renderChannelUrl(status);
      }
    } else {
      setConnected(false);
      setStatus('server unreachable', 'error');
      statNodes.textContent = '--';
    }
  });

  // Always fetch messages (for new ones arriving on background)
  fetchMessages().then(processMessages);

  // Fetch other data based on active tab
  if (state.activeTab === 'nodes') {
    fetchNodes(state.nodePage).then(renderNodes);
  } else if (state.activeTab === 'channels') {
    fetchChannels().then(renderChannels);
  } else if (state.activeTab === 'settings') {
    // Settings handled by status callback
  } else {
    // Messages tab — also fetch nodes/channels periodically for sidebar metadata
    if (state.nodes.length === 0) fetchNodes().then(renderNodes);
    if (state.channels.length === 0) fetchChannels().then(renderChannels);
  }
}

function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  pollAll();
  state.pollTimer = setInterval(pollAll, config.pollInterval);
}

function restartPolling() { startPolling(); }

// --- TABS ---
function switchTab(tabName) {
  state.activeTab = tabName;

  var tabs = document.querySelectorAll('.tab');
  for (var i = 0; i < tabs.length; i++) {
    var t = tabs[i];
    if (t.getAttribute('data-tab') === tabName) t.classList.add('active');
    else t.classList.remove('active');
  }

  var panels = document.querySelectorAll('.tab-panel');
  for (var j = 0; j < panels.length; j++) panels[j].classList.remove('active');
  var panel = document.getElementById('panel-' + tabName);
  if (panel) panel.classList.add('active');

  inputArea.style.display = (tabName === 'messages') ? '' : 'none';

  if (tabName === 'messages') {
    updateCtxBanner();
    // Fetch fresh messages from server, ingest, then render
    fetchMessages().then(processMessages);
  } else if (tabName === 'nodes') {
    fetchNodes(state.nodePage).then(renderNodes);
  } else if (tabName === 'channels') {
    fetchChannels().then(renderChannels);
  } else if (tabName === 'settings') {
    pollAll();
  }
}

// --- SEND ---
function handleSend() {
  var text = inputField.value.trim();
  if (!text) return;
  sendBtn.disabled = true;
  sendBtn.textContent = '...';
  sendMessage(text, state.dmTarget).then(function (result) {
    if (result && result.ok) {
      inputField.value = '';
      sendBtn.textContent = '\u2713';  // check mark
      setTimeout(function () { sendBtn.disabled = false; sendBtn.textContent = 'send'; }, 800);
      pollAll();
    } else {
      sendBtn.disabled = false;
      sendBtn.textContent = 'send';
      setStatus('send error: ' + ((result && result.error) ? result.error : 'failed'), 'error');
    }
  });
}

// --- INIT ---
function init() {
  initDomRefs();
  loadSettings();

  // Tab clicks
  var tabButtons = document.querySelectorAll('.tab');
  for (var tb = 0; tb < tabButtons.length; tb++) {
    (function (btn) {
      btn.addEventListener('click', function () { switchTab(btn.getAttribute('data-tab')); });
    })(tabButtons[tb]);
  }

  // Send
  sendBtn.addEventListener('click', handleSend);
  inputField.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); handleSend(); }
  });

  // DM target click to clear
  dmTargetEl.addEventListener('click', clearDMTarget);

  // Sort/filter buttons
  sortBtn.addEventListener('click', function () {
    var idx = SORT_OPTIONS.findIndex(function (o) { return o.value === state.sortBy; });
    idx = (idx + 1) % SORT_OPTIONS.length;
    state.sortBy = SORT_OPTIONS[idx].value;
    sortBtn.textContent = 'sort: ' + SORT_OPTIONS[idx].label;
    renderNodes({ nodes: state.nodes });
  });

  roleBtn.addEventListener('click', function () {
    var idx = ROLE_OPTIONS.findIndex(function (o) { return o.value === state.roleFilter; });
    idx = (idx + 1) % ROLE_OPTIONS.length;
    state.roleFilter = ROLE_OPTIONS[idx].value;
    roleBtn.textContent = 'role: ' + ROLE_OPTIONS[idx].label;
    if (state.roleFilter !== 'all') roleBtn.classList.add('on');
    else roleBtn.classList.remove('on');
    renderNodes({ nodes: state.nodes });
  });

  favOnlyBtn.addEventListener('click', function () {
    state.favOnly = !state.favOnly;
    if (state.favOnly) favOnlyBtn.classList.add('on');
    else favOnlyBtn.classList.remove('on');
    renderNodes({ nodes: state.nodes });
  });

  // Search filters (pure render, no fetch)
  msgSearch.addEventListener('input', function () {
    renderMessageList();
  });

  nodeSearch.addEventListener('input', function () {
    if (state.nodes.length) renderNodes({ nodes: state.nodes });
  });

  // Settings
  saveSettingsBtn.addEventListener('click', saveSettings);

  // Emoji keyboard toggle
  buildEmojiKeyboard();
  emojiBtn.addEventListener('click', function () {
    if (emojiKeyboard.style.display === 'none') {
      emojiKeyboard.style.display = '';
    } else {
      emojiKeyboard.style.display = 'none';
    }
  });

  // Units toggle
  unitsBtn.textContent = config.units;
  unitsBtn.addEventListener('click', function () {
    config.units = config.units === 'metric' ? 'imperial' : 'metric';
    unitsBtn.textContent = config.units;
    // Re-render everything that shows units
    renderMessageList();
    if (state.nodes.length > 0) renderNodes({ nodes: state.nodes, total: state.nodeTotal });
  });

  document.getElementById('rebootBtn').addEventListener('click', function () {
    adminAction('reboot').then(function (r) {
      adminInfo.textContent = r && r.ok ? 'rebooting...' : (r ? r.error : 'failed');
    });
  });
  document.getElementById('shutdownBtn').addEventListener('click', function () {
    adminAction('shutdown').then(function (r) {
      adminInfo.textContent = r && r.ok ? 'shutting down...' : (r ? r.error : 'failed');
    });
  });
  document.getElementById('resetNodesBtn').addEventListener('click', function () {
    adminAction('reset-nodedb').then(function (r) {
      adminInfo.textContent = r && r.ok ? 'nodedb reset' : (r ? r.error : 'failed');
    });
  });
  document.getElementById('themeBtn').addEventListener('click', function () {
    var current = document.body.getAttribute('data-theme');
    if (current === 'dark') {
      document.body.removeAttribute('data-theme');
      localStorage.setItem('mesh_theme', 'light');
    } else {
      document.body.setAttribute('data-theme', 'dark');
      localStorage.setItem('mesh_theme', 'dark');
    }
  });

  // Overlay closes
  selectCancel.addEventListener('click', function () { selectOverlay.classList.remove('active'); });
  detailsClose.addEventListener('click', function () { detailsOverlay.classList.remove('active'); });
  detailsOverlay.addEventListener('click', function (e) {
    if (e.target === detailsOverlay) detailsOverlay.classList.remove('active');
  });

  // Populate settings from state
  if (channelInput) channelInput.value = config.channel;
  if (pollInput) pollInput.value = config.pollInterval / 1000;
  if (document.getElementById('nodePageSizeInput')) document.getElementById('nodePageSizeInput').value = config.nodePageSize;
  if (document.getElementById('msgPageSizeInput')) document.getElementById('msgPageSizeInput').value = config.msgPageSize;

  // Start polling
  startPolling();
}

// Run on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
