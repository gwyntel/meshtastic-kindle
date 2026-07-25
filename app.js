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
  nodeCache: {},
  homeLat: null,
  homeLon: null,
  dmTarget: null,
  sortBy: 'name',
  roleFilter: 'all',
  favOnly: false,
};

var config = {
  serverUrl: window.location.origin,
  channel: 0,
  pollInterval: 2000,
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

// --- DOM REFS ---
var messageList = document.getElementById('messageList');
var nodeList = document.getElementById('nodeList');
var channelList = document.getElementById('channelList');
var inputField = document.getElementById('inputField');
var sendBtn = document.getElementById('sendBtn');
var statusBar = document.getElementById('statusBar');
var statusDot = document.getElementById('statusDot');
var headerTitle = document.getElementById('headerTitle');
var statNodes = document.getElementById('statNodes');
var statMsgs = document.getElementById('statMsgs');
var ctxBanner = document.getElementById('ctxBanner');
var dmTargetEl = document.getElementById('dmTarget');
var inputArea = document.getElementById('inputArea');
var msgSearch = document.getElementById('msgSearch');
var nodeSearch = document.getElementById('nodeSearch');
var sortBtn = document.getElementById('sortBtn');
var roleBtn = document.getElementById('roleBtn');
var favOnlyBtn = document.getElementById('favOnlyBtn');

// Settings
var deviceUrlInput = document.getElementById('deviceUrlInput');
var channelInput = document.getElementById('channelInput');
var pollInput = document.getElementById('pollInput');
var saveSettingsBtn = document.getElementById('saveSettingsBtn');
var settingsInfo = document.getElementById('settingsInfo');
var adminInfo = document.getElementById('adminInfo');
var deviceInfoGrid = document.getElementById('deviceInfoGrid');
var netStatsGrid = document.getElementById('netStatsGrid');
var channelUrlBox = document.getElementById('channelUrlBox');

// Overlays
var selectOverlay = document.getElementById('selectOverlay');
var selectTitle = document.getElementById('selectTitle');
var selectOptions = document.getElementById('selectOptions');
var selectCancel = document.getElementById('selectCancel');
var detailsOverlay = document.getElementById('detailsOverlay');
var detailsTitle = document.getElementById('detailsTitle');
var detailsContent = document.getElementById('detailsContent');
var detailsClose = document.getElementById('detailsClose');

// --- SETTINGS ---
function loadSettings() {
  var ch = localStorage.getItem('mesh_ch');
  if (ch !== null) { config.channel = parseInt(ch, 10) || 0; channelInput.value = config.channel; }
  var poll = localStorage.getItem('mesh_poll');
  if (poll !== null) { config.pollInterval = (parseInt(poll, 10) || 2) * 1000; pollInput.value = config.pollInterval / 1000; }
  var theme = localStorage.getItem('mesh_theme');
  if (theme === 'dark') document.body.setAttribute('data-theme', 'dark');
  var since = localStorage.getItem('mesh_since');
  if (since !== null) state.lastMessageTs = parseFloat(since) || 0;
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
  var url = config.serverUrl + '/api/messages?since=' + state.lastMessageTs;
  return fetchJSON(url);
}
function fetchNodes() { return fetchJSON(config.serverUrl + '/api/nodes'); }
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

function emojiImg(codepoint) {
  var hex = codepoint.toString(16).toUpperCase();
  while (hex.length < 5) hex = '0' + hex;
  return '<img src="/emoji/U' + hex + '.png" class="emoji-img" alt="emoji">';
}

function emojiToHtml(text) {
  if (!text) return '';
  var result = '';
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length) {
      var low = text.charCodeAt(i + 1);
      var cp = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
      result += emojiImg(cp);
      i++;
    } else if ((code >= 0x2600 && code <= 0x27BF) || (code >= 0x2B00 && code <= 0x2BFF) ||
               (code >= 0x2300 && code <= 0x23FF) || (code >= 0x12000 && code <= 0x1247F) ||
               (code >= 0x13000 && code <= 0x1342F)) {
      result += emojiImg(code);
    } else if (code === 0x20E3 || code === 0xFE0F || code === 0xFE0E || code === 0x200D) {
      continue;
    } else {
      result += escapeHtml(text[i]);
    }
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
  var html = renderMarkdown(text);
  html = html.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, function (match) {
    var cp = 0x10000 + ((match.charCodeAt(0) - 0xD800) << 10) + (match.charCodeAt(1) - 0xDC00);
    return emojiImg(cp);
  });
  html = html.replace(/[\u2300-\u23FF\u2600-\u27BF\u2B00-\u2BFF\u12000-\u1247F\u13000-\u1342F]/g, function (match) {
    var cp;
    if (match.charCodeAt(0) >= 0xD800 && match.charCodeAt(0) <= 0xDBFF) {
      cp = 0x10000 + ((match.charCodeAt(0) - 0xD800) << 10) + (match.charCodeAt(1) - 0xDC00);
    } else {
      cp = match.charCodeAt(0);
    }
    return emojiImg(cp);
  });
  html = html.replace(/[\uFE0F\uFE0E\u200D]/g, '');
  return html;
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

selectCancel.addEventListener('click', function () { selectOverlay.classList.remove('active'); });
detailsClose.addEventListener('click', function () { detailsOverlay.classList.remove('active'); });
detailsOverlay.addEventListener('click', function (e) {
  if (e.target === detailsOverlay) detailsOverlay.classList.remove('active');
});

// --- RENDER: STATUS ---
function setStatus(text, type) {
  statusBar.textContent = text;
  statusBar.className = 'status-bar' + (type ? ' ' + type : '');
}

function setConnected(connected) {
  state.connected = connected;
  statusDot.className = 'status-dot ' + (connected ? 'online' : 'offline');
  statusDot.textContent = connected ? '\u25CF' : '\u25CB';
}

// --- RENDER: MESSAGES ---
function renderMessages(data) {
  if (!data || !data.messages) return;

  var newMessages = data.messages;
  if (newMessages.length === 0) {
    if (state.messages.length === 0) {
      messageList.innerHTML = '<div class="empty-state">no messages yet</div>';
    }
    return;
  }

  // Merge new messages, dedup by from+text+timestamp
  var existing = {};
  for (var i = 0; i < state.messages.length; i++) {
    var em = state.messages[i];
    var key = em.from + '|' + em.text + '|' + Math.floor((em.timestamp || 0) / 2);
    existing[key] = true;
  }

  var added = false;
  for (var j = 0; j < newMessages.length; j++) {
    var nm = newMessages[j];
    var nkey = nm.from + '|' + nm.text + '|' + Math.floor((nm.timestamp || 0) / 2);
    if (!existing[nkey]) {
      state.messages.push(nm);
      existing[nkey] = true;
      added = true;
      if (nm.timestamp > state.lastMessageTs) state.lastMessageTs = nm.timestamp;
    }
  }

  // Trim
  if (state.messages.length > 200) {
    state.messages = state.messages.slice(-200);
  }

  // Persist last msg ts
  if (state.lastMessageTs > 0) {
    localStorage.setItem('mesh_since', String(state.lastMessageTs));
  }

  // Filter
  var term = (msgSearch.value || '').toLowerCase();
  var filtered = state.messages;
  if (term) {
    filtered = [];
    for (var f = 0; f < state.messages.length; f++) {
      var mf = state.messages[f];
      var fromName = getNodeName(mf.from);
      if (fromName.toLowerCase().indexOf(term) >= 0 ||
          (mf.text || '').toLowerCase().indexOf(term) >= 0) {
        filtered.push(mf);
      }
    }
  }

  if (filtered.length === 0) {
    messageList.innerHTML = '<div class="empty-state">' + (term ? 'no matches' : 'no messages yet') + '</div>';
  } else {
    // Show last 60
    var show = filtered.slice(-60);
    var html = '';
    for (var s = 0; s < show.length; s++) {
      var m = show[s];
      var fromName = getNodeName(m.from);
      var time = formatTime(m.timestamp);
      var cls = m.is_own ? 'msg-item own' : 'msg-item';
      var tags = '';
      if (m.to && m.to !== '!ffffffff' && m.to !== '!ffffffff' && m.to !== '!FFFFFFFF') tags += '<span class="meta-tag">DM</span>';
      if (m.is_own) tags += '<span class="meta-tag">sent</span>';
      if (m.via_mqtt) tags += '<span class="meta-tag">mqtt</span>';
      else tags += '<span class="meta-tag">lora</span>';

      var hops = '';
      if (m.hops_taken !== undefined && m.hops_taken !== null) hops = ' ' + m.hops_taken + 'h';

      html += '<div class="' + cls + '">' +
        '<div class="msg-meta">' +
        '<span class="meta-name">' + escapeHtml(fromName) + '</span>' +
        '<span>ch' + (m.channel || 0) + '</span>' +
        '<span>' + time + hops + '</span>' +
        tags +
        '</div>' +
        '<div class="msg-text">' + renderText(m.text) + '</div>' +
        '</div>';
    }
    messageList.innerHTML = html;
  }

  // Auto-scroll
  messageList.scrollTop = messageList.scrollHeight;

  // Wire long-press on messages
  var msgItems = messageList.querySelectorAll('.msg-item');
  wireLongPress(msgItems, function (idx) {
    var real = show[parseInt(idx, 10)];
    if (real) showMsgDetails(real);
  });
}

function showMsgDetails(msg) {
  var fromName = getNodeName(msg.from);
  var toName = msg.to ? getNodeName(msg.to) : 'broadcast';
  var senderNode = state.nodeCache[msg.from];

  var html = '<div class="info-grid">';
  html += infoRow('from', fromName);
  html += infoRow('from id', msg.from || '--');
  html += infoRow('to', toName);
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
  state.nodes = data.nodes;

  // Build node cache
  var cache = {};
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

  // Apply filters
  var filtered = state.nodes;
  var term = (nodeSearch.value || '').toLowerCase();
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

  if (filtered.length === 0) {
    nodeList.innerHTML = '<div class="empty-state">' + (term ? 'no matches' : 'no nodes discovered') + '</div>';
    return;
  }

  var html = '';
  for (var x = 0; x < filtered.length; x++) {
    var node = filtered[x];
    var name = node.long_name || node.short_name || node.id || '?';
    var short = node.short_name || '';
    var ago = timeAgo(node.last_heard);
    var favCls = node.is_favorite ? ' fav' : '';
    var roleTag = node.role ? ' [' + node.role + ']' : '';

    html += '<div class="node-row' + favCls + '" data-nodeid="' + escapeHtml(node.id) + '">';
    html += '<span class="node-name">' + emojiToHtml(name) + roleTag + '</span>';
    html += '<span class="node-id">' + escapeHtml(node.id) + '</span>';
    html += '<span class="node-meta">' + ago + '</span>';

    // Tags row
    html += '<div class="node-tags">';
    if (node.telemetry) {
      var t = node.telemetry;
      if (t.battery !== undefined && t.battery !== null)
        html += '<span class="node-tag' + (t.battery < 10 ? ' warn' : '') + '">bat ' + t.battery + '%</span>';
      if (t.temp !== undefined && t.temp !== null)
        html += '<span class="node-tag">' + t.temp.toFixed(1) + 'C</span>';
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
        html += '<span class="node-tag">' + dist.toFixed(1) + 'km ' + brng + '</span>';
      }
    }
    html += '</div>';
    html += '</div>';
  }

  nodeList.innerHTML = html;

  // Wire long-press
  var nodeRows = nodeList.querySelectorAll('.node-row');
  wireLongPress(nodeRows, function (nodeId) {
    var nd = state.nodeCache[nodeId];
    if (nd) showNodeDetails(nd);
  });
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
      html += infoRow('alt', node.position.alt + 'm');
    var dist = getNodeDistance(node);
    if (dist !== null) {
      html += infoRow('dist', dist.toFixed(2) + ' km');
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
    if (t.temp !== undefined && t.temp !== null) html += infoRow('temp', t.temp + 'C');
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

function infoRow(label, value) {
  return '<div class="info-row"><span class="info-label">' + escapeHtml(label) +
    '</span><span class="info-val">' + escapeHtml(String(value)) + '</span></div>';
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
  inputField.placeholder = 'DM ' + name + '...';
  dmTargetEl.textContent = 'to: ' + name + ' (tap to cancel)';
  dmTargetEl.className = 'dm-target active';
  updateCtxBanner();
}

function clearDMTarget() {
  state.dmTarget = null;
  inputField.placeholder = 'broadcast...';
  dmTargetEl.textContent = '';
  dmTargetEl.className = 'dm-target';
  updateCtxBanner();
}

dmTargetEl.addEventListener('click', clearDMTarget);

function updateCtxBanner() {
  var chName = 'ch' + config.channel;
  for (var i = 0; i < state.channels.length; i++) {
    if (state.channels[i].index === config.channel) {
      chName = state.channels[i].name || chName;
      break;
    }
  }
  var html = '<span>channel: ' + escapeHtml(chName) + '</span>';
  if (state.dmTarget) {
    html += '<span>DM: ' + escapeHtml(getNodeName(state.dmTarget)) + '</span>';
  }
  ctxBanner.innerHTML = html;
}

// --- POLLING ---
function pollAll() {
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

  if (state.activeTab === 'messages') {
    fetchMessages().then(function (data) {
      if (data) {
        renderMessages(data);
        statMsgs.textContent = (data.count || state.messages.length) + ' msgs';
      }
    });
    if (state.nodes.length === 0) fetchNodes().then(renderNodes);
  } else if (state.activeTab === 'nodes') {
    fetchNodes().then(renderNodes);
  } else if (state.activeTab === 'channels') {
    fetchChannels().then(renderChannels);
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

  if (tabName === 'messages') { updateCtxBanner(); fetchMessages().then(renderMessages); }
  else if (tabName === 'nodes') fetchNodes().then(renderNodes);
  else if (tabName === 'channels') fetchChannels().then(renderChannels);
  else if (tabName === 'settings') pollAll();
}

// --- TAB CLICKS ---
var tabButtons = document.querySelectorAll('.tab');
for (var tb = 0; tb < tabButtons.length; tb++) {
  (function (btn) {
    btn.addEventListener('click', function () { switchTab(btn.getAttribute('data-tab')); });
  })(tabButtons[tb]);
}

// --- SEND ---
function handleSend() {
  var text = inputField.value.trim();
  if (!text) return;
  sendBtn.disabled = true;
  sendBtn.textContent = '...';
  sendMessage(text, state.dmTarget).then(function (result) {
    sendBtn.disabled = false;
    sendBtn.textContent = 'send';
    if (result && result.ok) { inputField.value = ''; pollAll(); }
    else { setStatus('send error: ' + ((result && result.error) ? result.error : 'failed'), 'error'); }
  });
}

sendBtn.addEventListener('click', handleSend);
inputField.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') { e.preventDefault(); handleSend(); }
});

// --- SORT / FILTER BUTTONS ---
sortBtn.addEventListener('click', function () {
  var idx = SORT_OPTIONS.findIndex(function (o) { return o.value === state.sortBy; });
  idx = (idx + 1) % SORT_OPTIONS.length;
  state.sortBy = SORT_OPTIONS[idx].value;
  sortBtn.textContent = 'sort: ' + SORT_OPTIONS[idx].label;
  fetchNodes().then(renderNodes);
});

roleBtn.addEventListener('click', function () {
  var idx = ROLE_OPTIONS.findIndex(function (o) { return o.value === state.roleFilter; });
  idx = (idx + 1) % ROLE_OPTIONS.length;
  state.roleFilter = ROLE_OPTIONS[idx].value;
  roleBtn.textContent = 'role: ' + ROLE_OPTIONS[idx].label;
  if (state.roleFilter !== 'all') roleBtn.classList.add('on');
  else roleBtn.classList.remove('on');
  fetchNodes().then(renderNodes);
});

favOnlyBtn.addEventListener('click', function () {
  state.favOnly = !state.favOnly;
  if (state.favOnly) favOnlyBtn.classList.add('on');
  else favOnlyBtn.classList.remove('on');
  fetchNodes().then(renderNodes);
});

// --- SEARCH FILTERS ---
msgSearch.addEventListener('input', function () {
  renderMessages({ messages: state.messages });
});

nodeSearch.addEventListener('input', function () {
  if (state.nodes.length) renderNodes({ nodes: state.nodes });
});

// --- SETTINGS EVENTS ---
saveSettingsBtn.addEventListener('click', saveSettings);

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

// --- INIT ---
loadSettings();
startPolling();
switchTab('messages');
