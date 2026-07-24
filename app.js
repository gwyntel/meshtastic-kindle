/* ES2019 strict — no ?., ??, ||=, #private, top-level await */
'use strict';

var state = {
  connected: false,
  activeTab: 'messages',
  lastMessageCount: 0,
  pollTimer: null,
  nodes: [],
  channels: [],
  messages: [],
  nodeCache: {},
  homeLat: null,
  homeLon: null,
  dmTarget: null,
  favOnly: false,
  sortBy: 'name',
  roleFilter: 'all',
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
  { value: 'all', label: 'all roles' },
  { value: 'CLIENT', label: 'client' },
  { value: 'CLIENT_MUTE', label: 'mute' },
  { value: 'ROUTER', label: 'router' },
  { value: 'ROUTER_CLIENT', label: 'rtr-cli' },
  { value: 'REPEATER', label: 'repeater' },
  { value: 'TRACKER', label: 'tracker' },
  { value: 'SENSOR', label: 'sensor' },
];

// --- DOM ---
var messageList = document.getElementById('messageList');
var nodeList = document.getElementById('nodeList');
var channelList = document.getElementById('channelList');
var inputField = document.getElementById('inputField');
var sendBtn = document.getElementById('sendBtn');
var statusBar = document.getElementById('statusBar');
var deviceUrlInput = document.getElementById('deviceUrlInput');
var channelInput = document.getElementById('channelInput');
var pollInput = document.getElementById('pollInput');
var testConnBtn = document.getElementById('testConnBtn');
var saveSettingsBtn = document.getElementById('saveSettingsBtn');
var settingsInfo = document.getElementById('settingsInfo');
var adminInfo = document.getElementById('adminInfo');
var deviceInfoGrid = document.getElementById('deviceInfoGrid');
var netStatsGrid = document.getElementById('netStatsGrid');
var channelUrlBox = document.getElementById('channelUrlBox');
var nodeSearch = document.getElementById('nodeSearch');
var sortBtn = document.getElementById('sortBtn');
var roleBtn = document.getElementById('roleBtn');
var favOnlyBtn = document.getElementById('favOnlyBtn');
var msgSearch = document.getElementById('msgSearch');
var dmTargetEl = document.getElementById('dmTarget');
var inputArea = document.getElementById('inputArea');
var ctxBanner = document.getElementById('ctxBanner');

// Select overlay
var selectOverlay = document.getElementById('selectOverlay');
var selectTitle = document.getElementById('selectTitle');
var selectOptions = document.getElementById('selectOptions');
var selectCancel = document.getElementById('selectCancel');

// Details modal
var detailsOverlay = document.getElementById('detailsOverlay');
var detailsTitle = document.getElementById('detailsTitle');
var detailsContent = document.getElementById('detailsContent');
var detailsClose = document.getElementById('detailsClose');

// --- SETTINGS ---
function loadSettings() {
  var savedChannel = localStorage.getItem('mesh_kindle_channel');
  var savedPoll = localStorage.getItem('mesh_kindle_poll');
  var savedTheme = localStorage.getItem('mesh_kindle_theme');
  if (savedChannel !== null) {
    config.channel = parseInt(savedChannel, 10) || 0;
    channelInput.value = config.channel;
  }
  if (savedPoll !== null) {
    config.pollInterval = (parseInt(savedPoll, 10) || 2) * 1000;
    pollInput.value = config.pollInterval / 1000;
  }
  if (savedTheme === 'dark') {
    document.body.setAttribute('data-theme', 'dark');
  }
}

function saveSettings() {
  var channel = parseInt(channelInput.value, 10);
  if (isNaN(channel) || channel < 0) channel = 0;
  if (channel > 7) channel = 7;
  config.channel = channel;
  localStorage.setItem('mesh_kindle_channel', channel);
  var poll = parseInt(pollInput.value, 10);
  if (isNaN(poll) || poll < 1) poll = 2;
  if (poll > 60) poll = 60;
  config.pollInterval = poll * 1000;
  localStorage.setItem('mesh_kindle_poll', poll);
  settingsInfo.textContent = 'saved';
  setTimeout(function() { settingsInfo.textContent = ''; }, 2000);
  restartPolling();
}

// --- API ---
function fetchJSON(url) {
  return fetch(url)
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .catch(function() { return null; });
}

function fetchStatus() { return fetchJSON(config.serverUrl + '/api/status'); }
function fetchMessages() {
  var url = config.serverUrl + '/api/messages?limit=200';
  return fetchJSON(url);
}
function fetchNodes() { return fetchJSON(config.serverUrl + '/api/nodes?limit=500'); }
function fetchChannels() { return fetchJSON(config.serverUrl + '/api/channels'); }

function sendMessage(text, destNode) {
  var body = { text: text, channel: config.channel };
  if (destNode) body.dest_node = destNode;
  return fetch(config.serverUrl + '/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function(r) { return r.json(); })
    .catch(function(e) { return { ok: false, error: e.message }; });
}

function toggleFavorite(nodeId) {
  return fetch(config.serverUrl + '/api/favorite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ node_id: nodeId, favorite: 'toggle' })
  }).then(function(r) { return r.json(); })
    .catch(function() { return { ok: false }; });
}

function adminAction(action) {
  return fetch(config.serverUrl + '/api/admin/' + action, {
    method: 'POST'
  }).then(function(r) { return r.json(); })
    .catch(function() { return { ok: false, error: 'request failed' }; });
}

// --- UTILS ---
function escapeHtml(text) {
  if (!text) return '';
  var div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Emoji: render as grayscale PNG images (Kindle can't load custom fonts)
function emojiToHtml(text) {
  if (!text) return '';
  var result = '';
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i);
    // Check if this is a high surrogate (emoji > U+FFFF)
    if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length) {
      var low = text.charCodeAt(i + 1);
      var cp = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
      result += emojiImg(cp);
      i++; // skip low surrogate
    } else if (code >= 0x2600 && code <= 0x27BF) {
      result += emojiImg(code);
    } else if (code >= 0x2B00 && code <= 0x2BFF) {
      result += emojiImg(code);
    } else if (code >= 0x2300 && code <= 0x23FF) {
      result += emojiImg(code);
    } else if (code >= 0x12000 && code <= 0x1247F) {
      // Cuneiform
      result += emojiImg(code);
    } else if (code >= 0x13000 && code <= 0x1342F) {
      // Egyptian Hieroglyphs (future)
      result += emojiImg(code);
    } else if (code === 0x20E3 || code === 0xFE0F || code === 0xFE0E || code === 0x200D) {
      // Skip variation selectors and ZWJ
      continue;
    } else {
      result += escapeHtml(text[i]);
    }
  }
  return result;
}

function emojiImg(codepoint) {
  var hex = codepoint.toString(16).toUpperCase();
  while (hex.length < 5) hex = '0' + hex;
  return '<img src="/emoji/U' + hex + '.png" class="emoji-img" alt="emoji">';
}

// Simple markdown renderer — **bold**, *italic*, `code`, ~~strike~~, [text](url)
// Also renders emoji as PNG images
function renderMarkdown(text) {
  if (!text) return '';
  // First escape HTML
  var html = escapeHtml(text);
  // Apply markdown patterns (order matters)
  // Code blocks first (backticks)
  html = html.replace(/`([^`]+)`/g, '<span class="md-code">$1</span>');
  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, '<span class="md-bold">$1</span>');
  // Italic
  html = html.replace(/\*([^*]+)\*/g, '<span class="md-italic">$1</span>');
  // Strikethrough
  html = html.replace(/~~([^~]+)~~/g, '<span class="md-strike">$1</span>');
  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="md-link">$1</a>');
  // Line breaks
  html = html.replace(/\n/g, '<br>');
  return html;
}

// Render text with both emoji images and markdown
function renderText(text) {
  if (!text) return '';
  // Split by lines first, process markdown, then emoji
  // We need to be careful: markdown escaping already happened,
  // but emoji characters need to be converted to <img> tags
  // Process emoji first (on raw text), then markdown
  var withEmoji = emojiToHtml(text);
  // Now apply markdown on the non-img parts
  // Since emojiToHtml already escapes HTML, we need to be careful
  // Actually, let's do markdown first (which escapes), then emoji won't work
  // because text is already escaped... 
  // Better: render markdown on escaped text, then the emoji chars are still there
  // and we convert them. But markdown already escaped them...
  // Simplest approach: do emoji replacement on the final HTML, replacing
  // emoji chars (which survived escaping) with <img> tags
  var html = renderMarkdown(text);
  // Now replace emoji chars in the generated HTML
  // The escapeHtml call in renderMarkdown converts < to &lt; etc
  // but emoji chars pass through unchanged
  // We need to walk the HTML and replace emoji chars that aren't inside tags
  // Actually, since emoji chars are never inside HTML tags, we can use regex
  // Replace emoji surrogate pairs and single chars
  html = html.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, function(match) {
    var cp = 0x10000 + ((match.charCodeAt(0) - 0xD800) << 10) + (match.charCodeAt(1) - 0xDC00);
    return emojiImg(cp);
  });
  // Replace single-char emojis (misc symbols, dingbats, cuneiform, etc)
  html = html.replace(/[\u2300-\u23FF\u2600-\u27BF\u2B00-\u2BFF\u12000-\u1247F\u13000-\u1342F]/g, function(match) {
    // Handle surrogate pairs for codepoints > U+FFFF
    var cp;
    if (match.charCodeAt(0) >= 0xD800 && match.charCodeAt(0) <= 0xDBFF) {
      cp = 0x10000 + ((match.charCodeAt(0) - 0xD800) << 10) + (match.charCodeAt(1) - 0xDC00);
    } else {
      cp = match.charCodeAt(0);
    }
    return emojiImg(cp);
  });
  // Remove variation selectors
  html = html.replace(/[\uFE0F\uFE0E\u200D]/g, '');
  return html;
}

function formatTime(timestamp) {
  if (!timestamp) return '--:--';
  var d = new Date(timestamp * 1000);
  var h = d.getHours();
  var m = d.getMinutes();
  h = h < 10 ? '0' + h : '' + h;
  m = m < 10 ? '0' + m : '' + m;
  return h + ':' + m;
}

function timeAgo(timestamp) {
  if (!timestamp) return 'never';
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
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function bearing(lat1, lon1, lat2, lon2) {
  if (lat1 === null || lat2 === null) return '';
  var dLon = (lon2 - lon1) * Math.PI / 180;
  var y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
  var x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
    Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
  var brng = Math.atan2(y, x) * 180 / Math.PI;
  brng = (brng + 360) % 360;
  var dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(brng / 45) % 8];
}

function getNodeName(nodeId) {
  if (!nodeId) return 'unknown';
  var node = state.nodeCache[nodeId];
  if (node && node.long_name) return node.long_name;
  if (node && node.short_name) return node.short_name;
  return nodeId;
}

function getNodeDistance(node) {
  if (!node.position || !node.position.lat || state.homeLat === null) return null;
  return calcDistance(state.homeLat, state.homeLon, node.position.lat, node.position.lon);
}

// --- FULL-SCREEN SELECT ---
function showSelect(title, options, currentValue, callback) {
  selectTitle.textContent = title;
  selectOptions.innerHTML = '';
  for (var i = 0; i < options.length; i++) {
    (function(opt) {
      var btn = document.createElement('button');
      btn.className = 'select-option';
      if (opt.value === currentValue) btn.classList.add('selected');
      btn.textContent = opt.label;
      btn.addEventListener('click', function() {
        selectOverlay.classList.remove('active');
        callback(opt.value);
      });
      selectOptions.appendChild(btn);
    })(options[i]);
  }
  selectOverlay.classList.add('active');
}

selectCancel.addEventListener('click', function() {
  selectOverlay.classList.remove('active');
});

// --- DETAILS MODAL ---
function showDetails(title, html) {
  detailsTitle.innerHTML = title;
  detailsContent.innerHTML = html;
  detailsOverlay.classList.add('active');
}

detailsClose.addEventListener('click', function() {
  detailsOverlay.classList.remove('active');
});

detailsOverlay.addEventListener('click', function(e) {
  if (e.target === detailsOverlay) {
    detailsOverlay.classList.remove('active');
  }
});

// --- RENDER: STATUS ---
function setStatus(text, type) {
  statusBar.textContent = text;
  statusBar.className = 'status-bar ' + (type || '');
}

// --- RENDER: MESSAGES ---
function renderMessages(data) {
  if (!data || !data.messages) return;
  var messages = data.messages;
  state.messages = messages;

  var searchTerm = (msgSearch.value || '').toLowerCase();
  var filtered = messages;
  if (searchTerm) {
    filtered = [];
    for (var j = 0; j < messages.length; j++) {
      var msg = messages[j];
      var fromName = getNodeName(msg.from);
      if (fromName.toLowerCase().indexOf(searchTerm) >= 0 ||
          (msg.text || '').toLowerCase().indexOf(searchTerm) >= 0) {
        filtered.push(msg);
      }
    }
  }

  if (filtered.length === 0) {
    messageList.innerHTML = '<div class="empty-state"><div class="empty-title">no messages</div><div class="empty-sub">' + (searchTerm ? 'no matches' : 'waiting for mesh traffic...') + '</div></div>';
    return;
  }

  var html = '';
  var start = Math.max(0, filtered.length - 50);
  for (var k = start; k < filtered.length; k++) {
    var m = filtered[k];
    var fromName = getNodeName(m.from);
    var time = formatTime(m.timestamp);
    var isDM = m.to && m.to !== '!ffffffff';
    var dmTag = isDM ? ' [DM]' : '';
    var ownTag = m.is_own ? ' [sent]' : '';
    var transport = m.via_mqtt ? 'mqtt' : 'lora';

    // Hops: use packet hops_taken if available, else sender's hops_away
    var hops = '';
    if (m.hops_taken !== undefined && m.hops_taken !== null) {
      hops = ' - ' + m.hops_taken + ' hops';
    } else {
      var senderNode = state.nodeCache[m.from];
      if (senderNode && senderNode.hops_away !== undefined && senderNode.hops_away !== null) {
        hops = ' - ~' + senderNode.hops_away + ' hops';
      }
    }

    var msgClass = 'message';
    if (m.is_own) msgClass += ' message-own';

    html += '<div class="' + msgClass + '" data-msgidx="' + k + '">' +
      '<div class="message-meta">' + escapeHtml(fromName) + dmTag + ownTag + ' - ch' + (m.channel || 0) + ' - ' + time + hops + ' - ' + transport + '</div>' +
      '<div class="message-text">' + renderText(m.text) + '</div>' +
      '</div>';
  }

  messageList.innerHTML = html;
  messageList.scrollTop = messageList.scrollHeight;

  // Wire long-press on messages
  wireLongPress(messageList.querySelectorAll('.message'), function(idx) {
    var realMsg = filtered[parseInt(idx, 10)];
    if (realMsg) showMsgDetails(realMsg);
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
      html += infoRow('sender role', senderNode.role);
  }
  html += '</div>';
  html += '<div style="margin-top:12px;font-size:14px;white-space:pre-wrap;word-break:break-word;">' + renderText(msg.text) + '</div>';
  showDetails('message details', html);
}

// --- RENDER: NODES ---
function renderNodes(data) {
  if (!data || !data.nodes) return;
  var nodes = data.nodes;
  state.nodes = nodes;

  // Update node cache
  var nodeMap = {};
  for (var h = 0; h < nodes.length; h++) {
    nodeMap[nodes[h].id] = nodes[h];
  }
  state.nodeCache = nodeMap;

  // Find home node position
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i].is_favorite && nodes[i].position) {
      state.homeLat = nodes[i].position.lat;
      state.homeLon = nodes[i].position.lon;
      break;
    }
  }

  // Apply filters
  var filtered = nodes;
  var searchTerm = (nodeSearch.value || '').toLowerCase();
  if (searchTerm) {
    filtered = [];
    for (var j = 0; j < nodes.length; j++) {
      var n = nodes[j];
      var name = (n.long_name || n.short_name || n.id || '').toLowerCase();
      if (name.indexOf(searchTerm) >= 0) filtered.push(n);
    }
  }

  if (state.roleFilter !== 'all') {
    var roleFiltered = [];
    for (var r = 0; r < filtered.length; r++) {
      if (filtered[r].role === state.roleFilter) roleFiltered.push(filtered[r]);
    }
    filtered = roleFiltered;
  }

  if (state.favOnly) {
    var favFiltered = [];
    for (var f = 0; f < filtered.length; f++) {
      if (filtered[f].is_favorite) favFiltered.push(filtered[f]);
    }
    filtered = favFiltered;
  }

  // Sort
  var sortBy = state.sortBy;
  filtered.sort(function(a, b) {
    if (sortBy === 'name') return (a.long_name || a.id || '').localeCompare(b.long_name || b.id || '');
    if (sortBy === 'last_heard') return (b.last_heard || 0) - (a.last_heard || 0);
    if (sortBy === 'snr') return (b.snr !== null ? b.snr : -999) - (a.snr !== null ? a.snr : -999);
    if (sortBy === 'hops') return (a.hops_away !== null ? a.hops_away : 999) - (b.hops_away !== null ? b.hops_away : 999);
    if (sortBy === 'distance') {
      var da = getNodeDistance(a); var db = getNodeDistance(b);
      if (da === null) da = 99999; if (db === null) db = 99999;
      return da - db;
    }
    return 0;
  });

  if (filtered.length === 0) {
    nodeList.innerHTML = '<div class="empty-state"><div class="empty-title">no nodes</div><div class="empty-sub">' + (searchTerm ? 'no matches' : 'no nodes discovered yet') + '</div></div>';
    return;
  }

  var html = '';
  for (var k = 0; k < filtered.length; k++) {
    var node = filtered[k];
    var name = node.long_name || node.short_name || node.id || 'unknown';
    var shortName = node.short_name || '';
    var roleTag = '';
    if (node.role) roleTag = ' [' + node.role + ']';
    var favStar = node.is_favorite ? ' *' : '';
    var nodeId = escapeHtml(node.id || '');
    var lastTime = timeAgo(node.last_heard);

    html += '<div class="node-card' + (node.is_favorite ? ' node-fav' : '') + '" data-nodeid="' + nodeId + '">';

    // Row 1: badge + name + lock + last heard
    html += '<div class="node-row1">';
    if (shortName) {
      html += '<span class="node-badge">' + emojiToHtml(shortName) + '</span>';
    }
    html += '<span class="node-name">' + emojiToHtml(name) + favStar + roleTag + '</span>';
    if (node.is_secure) html += '<span class="node-lock">[lock]</span>';
    html += '<span class="node-last">' + lastTime + '</span>';
    html += '</div>';

    // Row 2: metrics (bat, snr, hops, via, temp)
    html += '<div class="node-row2">';
    if (node.telemetry) {
      var t = node.telemetry;
      if (t.battery !== undefined && t.battery !== null) {
        var pwrLabel = 'PWR';
        if (t.battery === 0) pwrLabel = 'PLG';
        html += '<span class="node-metric">PWR ' + t.battery + '%</span>';
      }
      if (t.voltage !== undefined && t.voltage !== null) {
        html += '<span class="node-metric">' + t.voltage.toFixed(1) + 'V</span>';
      }
      if (t.temp !== undefined && t.temp !== null) {
        html += '<span class="node-metric">' + t.temp.toFixed(1) + 'C</span>';
      }
      if (t.humidity !== undefined && t.humidity !== null) {
        html += '<span class="node-metric">' + t.humidity + '%H</span>';
      }
      if (t.channel_util !== undefined && t.channel_util !== null) {
        html += '<span class="node-metric">ChUtil ' + t.channel_util.toFixed(1) + '%</span>';
      }
    }
    if (node.snr !== undefined && node.snr !== null) {
      html += '<span class="node-metric">SNR ' + node.snr + 'dB</span>';
    }
    if (node.hops_away !== undefined && node.hops_away !== null) {
      html += '<span class="node-metric">Hops ' + node.hops_away + '</span>';
    }
    if (node.via_mqtt) html += '<span class="node-metric">MQTT</span>';
    html += '</div>';

    // Row 3: position + distance
    if (node.position) {
      var lat = node.position.lat;
      var lon = node.position.lon;
      var dist = getNodeDistance(node);
      html += '<div class="node-row3">';
      if (dist !== null) {
        html += '<span class="node-metric">' + dist.toFixed(1) + 'km';
        var brng = bearing(state.homeLat, state.homeLon, lat, lon);
        if (brng) html += ' ' + brng;
        html += '</span>';
      } else {
        html += '<span class="node-metric">' + (lat !== undefined ? lat.toFixed(4) : '--') + ',' + (lon !== undefined ? lon.toFixed(4) : '--') + '</span>';
      }
      html += '</div>';
    }

    // Row 4: hardware + actions
    html += '<div class="node-row4">';
    if (node.hw_model) html += '<span class="node-hw">' + escapeHtml(node.hw_model) + '</span>';
    html += '<span class="node-actions">';
    html += '<button class="btn btn-mini" data-action="dm" data-nodeid="' + nodeId + '">msg</button>';
    html += '<button class="btn btn-mini" data-action="fav" data-nodeid="' + nodeId + '">' + (node.is_favorite ? 'unfav' : 'fav') + '</button>';
    html += '</span>';
    html += '</div>';

    html += '</div>';
  }

  nodeList.innerHTML = html;

  // Wire action buttons
  var actionBtns = nodeList.querySelectorAll('[data-action]');
  for (var a = 0; a < actionBtns.length; a++) {
    (function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var action = btn.getAttribute('data-action');
        var nid = btn.getAttribute('data-nodeid');
        if (action === 'dm') setDMTarget(nid);
        else if (action === 'fav') toggleFavorite(nid).then(function() { pollAll(); });
      });
    })(actionBtns[a]);
  }

  // Wire long-press on node cards
  wireLongPress(nodeList.querySelectorAll('.node-card'), function(nodeId) {
    var node = state.nodeCache[nodeId];
    if (node) showNodeDetails(node);
  });
}

function formatUptime(seconds) {
  if (!seconds || seconds <= 0) return '--';
  var days = Math.floor(seconds / 86400);
  var hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return days + 'd' + hours + 'h';
  var mins = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return hours + 'h' + mins + 'm';
  return mins + 'm';
}

function showNodeDetails(node) {
  var name = node.long_name || node.short_name || node.id || 'unknown';
  var html = '<div class="info-grid">';
  html += infoRow('name', name);
  html += infoRow('short name', node.short_name || '--');
  html += infoRow('node id', node.id || '--');
  html += infoRow('role', node.role || '--');
  html += infoRow('hardware', node.hw_model || '--');
  html += infoRow('last heard', timeAgo(node.last_heard));
  if (node.snr !== undefined && node.snr !== null) html += infoRow('snr', node.snr + ' dB');
  if (node.hops_away !== undefined && node.hops_away !== null) html += infoRow('hops away', node.hops_away);
  if (node.via_mqtt) html += infoRow('via mqtt', 'yes');
  if (node.is_favorite) html += infoRow('favorite', 'yes');
  html += '</div>';

  if (node.position) {
    html += '<div style="margin-top:12px;font-weight:bold;font-size:12px;text-transform:uppercase;">position</div>';
    html += '<div class="info-grid">';
    html += infoRow('lat', node.position.lat !== undefined ? node.position.lat.toFixed(6) : '--');
    html += infoRow('lon', node.position.lon !== undefined ? node.position.lon.toFixed(6) : '--');
    if (node.position.alt !== undefined && node.position.alt !== null) html += infoRow('altitude', node.position.alt + 'm');
    var dist = getNodeDistance(node);
    if (dist !== null) {
      html += infoRow('distance', dist.toFixed(2) + ' km');
      var brng = bearing(state.homeLat, state.homeLon, node.position.lat, node.position.lon);
      if (brng) html += infoRow('bearing', brng);
    }
    html += '</div>';
  }

  if (node.telemetry) {
    var t = node.telemetry;
    html += '<div style="margin-top:12px;font-weight:bold;font-size:12px;text-transform:uppercase;">telemetry</div>';
    html += '<div class="info-grid">';
    if (t.battery !== undefined && t.battery !== null) html += infoRow('battery', t.battery + '%');
    if (t.voltage !== undefined && t.voltage !== null) html += infoRow('voltage', t.voltage.toFixed(3) + 'V');
    if (t.temp !== undefined && t.temp !== null) html += infoRow('temp', t.temp + 'C');
    if (t.humidity !== undefined && t.humidity !== null) html += infoRow('humidity', t.humidity + '%');
    if (t.pressure !== undefined && t.pressure !== null) html += infoRow('pressure', t.pressure + ' hPa');
    if (t.iaq !== undefined && t.iaq !== null) html += infoRow('iaq', t.iaq);
    if (t.channel_util !== undefined && t.channel_util !== null) html += infoRow('ch util', t.channel_util.toFixed(1) + '%');
    if (t.air_util !== undefined && t.air_util !== null) html += infoRow('air util', t.air_util.toFixed(1) + '%');
    html += '</div>';
  }

  if (node.uptime) {
    html += '<div style="margin-top:12px;font-weight:bold;font-size:12px;text-transform:uppercase;">device</div>';
    html += '<div class="info-grid">';
    html += infoRow('uptime', formatUptime(node.uptime));
    html += '</div>';
  }

  // DM button in details
  html += '<div style="margin-top:16px;"><button class="btn" id="detailsDmBtn">send DM</button></div>';

  showDetails(emojiToHtml(name), html);

  var dmBtn = document.getElementById('detailsDmBtn');
  if (dmBtn) {
    dmBtn.addEventListener('click', function() {
      detailsOverlay.classList.remove('active');
      setDMTarget(node.id);
      switchTab('messages');
    });
  }
}

function infoRow(label, value) {
  return '<div class="info-row"><span class="info-label">' + escapeHtml(label) + '</span><span class="info-val">' + escapeHtml(String(value)) + '</span></div>';
}

// --- LONG PRESS ---
function wireLongPress(elements, callback) {
  for (var i = 0; i < elements.length; i++) {
    (function(el) {
      var timer = null;
      var touched = false;

      el.addEventListener('touchstart', function(e) {
        touched = true;
        timer = setTimeout(function() {
          timer = null;
          var nodeId = el.getAttribute('data-nodeid');
          var msgIdx = el.getAttribute('data-msgidx');
          if (nodeId) callback(nodeId);
          else if (msgIdx) callback(msgIdx);
        }, 500);
      });

      el.addEventListener('touchend', function() {
        if (timer) { clearTimeout(timer); timer = null; }
        touched = false;
      });

      el.addEventListener('touchmove', function() {
        if (timer) { clearTimeout(timer); timer = null; }
        touched = false;
      });

      // Mouse fallback (for testing)
      el.addEventListener('mousedown', function(e) {
        if (touched) return;
        timer = setTimeout(function() {
          timer = null;
          var nodeId = el.getAttribute('data-nodeid');
          var msgIdx = el.getAttribute('data-msgidx');
          if (nodeId) callback(nodeId);
          else if (msgIdx) callback(msgIdx);
        }, 500);
      });

      el.addEventListener('mouseup', function() {
        if (timer) { clearTimeout(timer); timer = null; }
      });

      el.addEventListener('mouseleave', function() {
        if (timer) { clearTimeout(timer); timer = null; }
      });
    })(elements[i]);
  }
}

// --- RENDER: CHANNELS (no disabled, no filter) ---
function renderChannels(data) {
  if (!data || !data.channels) return;
  var channels = data.channels;
  state.channels = channels;
  updateCtxBanner();

  // Hide disabled channels entirely
  var active = [];
  for (var i = 0; i < channels.length; i++) {
    if (channels[i].role !== 'DISABLED') active.push(channels[i]);
  }

  if (active.length === 0) {
    channelList.innerHTML = '<div class="empty-state"><div class="empty-title">no channels</div><div class="empty-sub">no active channels</div></div>';
    return;
  }

  var html = '';
  for (var j = 0; j < active.length; j++) {
    var ch = active[j];
    var roleTag = '';
    if (ch.role === 'PRIMARY') roleTag = ' [PRIMARY]';
    else if (ch.role === 'SECONDARY') roleTag = ' [SECONDARY]';

    var isCurrent = (ch.index === config.channel);
    var cls = 'channel-card' + (isCurrent ? ' channel-active' : '');

    html += '<div class="' + cls + '" data-chidx="' + ch.index + '">';
    html += '<div class="channel-name">' + escapeHtml(ch.name || ('ch' + ch.index)) + roleTag + '</div>';
    html += '<div class="channel-meta">index ' + ch.index;
    if (ch.uplink_enabled) html += ' - up:on'; else html += ' - up:off';
    if (ch.downlink_enabled) html += ' - dn:on'; else html += ' - dn:off';
    if (isCurrent) html += ' - [selected]';
    html += '</div>';
    html += '</div>';
  }

  channelList.innerHTML = html;

  // Wire up channel tap to switch message channel
  var cards = channelList.querySelectorAll('.channel-card');
  for (var k = 0; k < cards.length; k++) {
    cards[k].addEventListener('click', function() {
      var idx = parseInt(this.getAttribute('data-chidx'), 10);
      if (isNaN(idx)) return;
      config.channel = idx;
      saveConfig();
      // Re-render channels to show selection
      renderChannels({channels: state.channels});
      // Switch to messages tab
      switchTab('messages');
      // Update banner
      updateCtxBanner();
    });
  }
}

// --- RENDER: SETTINGS ---
function renderDeviceInfo(status) {
  if (!status || !status.device_info) {
    deviceInfoGrid.innerHTML = '<div class="info-empty">no device connected</div>';
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
  deviceInfoGrid.innerHTML = html || '<div class="info-empty">no device info</div>';
}

function renderNetStats(status) {
  if (!status || !status.net_stats) {
    netStatsGrid.innerHTML = '<div class="info-empty">no stats available</div>';
    return;
  }
  var s = status.net_stats;
  var html = '';
  if (s.num_online !== undefined) html += infoRow('nodes online', s.num_online + '/' + s.num_total);
  if (s.packets_tx !== undefined) html += infoRow('packets tx', s.packets_tx);
  if (s.packets_rx !== undefined) html += infoRow('packets rx', s.packets_rx);
  if (s.packets_rx_bad !== undefined) html += infoRow('bad pkts', s.packets_rx_bad);
  if (s.noise_floor !== undefined) html += infoRow('noise floor', s.noise_floor + ' dBm');
  if (s.heap_free !== undefined) html += infoRow('heap', s.heap_free + '/' + s.heap_total + ' free');
  netStatsGrid.innerHTML = html || '<div class="info-empty">no stats</div>';
}

function renderChannelUrl(status) {
  if (!status || !status.channel_url) {
    channelUrlBox.innerHTML = '<div class="info-empty">no url available</div>';
    return;
  }
  channelUrlBox.innerHTML = '<div class="info-url">' + escapeHtml(status.channel_url) + '</div>';
}

// --- DM ---
function setDMTarget(nodeId) {
  if (state.dmTarget === nodeId) { clearDMTarget(); return; }
  state.dmTarget = nodeId;
  var name = getNodeName(nodeId);
  inputField.placeholder = 'DM to ' + name + '...';
  dmTargetEl.textContent = 'DM: ' + name + ' (tap to cancel)';
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

function updateCtxBanner() {
  var chName = 'ch' + config.channel;
  for (var i = 0; i < state.channels.length; i++) {
    if (state.channels[i].index === config.channel) {
      chName = state.channels[i].name || chName;
      break;
    }
  }
  var html = '<span class="ctx-channel">channel: ' + escapeHtml(chName) + '</span>';
  if (state.dmTarget) {
    var dmName = getNodeName(state.dmTarget);
    html += '<span class="ctx-dm"> | DM to: ' + escapeHtml(dmName) + '</span>';
  }
  ctxBanner.innerHTML = html;
  ctxBanner.style.display = '';
}

// --- POLLING ---
function pollAll() {
  fetchStatus().then(function(status) {
    if (status) {
      state.connected = status.connected;
      if (status.connected) {
        setStatus('online - ' + (status.node_count || 0) + ' nodes - ' + (status.message_count || 0) + ' msgs', 'connected');
      } else {
        setStatus('offline - ' + (status.error || 'no device'), 'error');
      }
      if (state.activeTab === 'settings') {
        renderDeviceInfo(status);
        renderNetStats(status);
        renderChannelUrl(status);
      }
    } else {
      setStatus('server unreachable', 'error');
    }
  });

  if (state.activeTab === 'messages') {
    fetchMessages().then(renderMessages);
    if (state.nodes.length === 0) fetchNodes().then(renderNodes);
  } else if (state.activeTab === 'channels') {
    fetchChannels().then(renderChannels);
  } else if (state.activeTab === 'nodes') {
    fetchNodes().then(renderNodes);
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
    if (tabs[i].getAttribute('data-tab') === tabName) tabs[i].classList.add('active');
    else tabs[i].classList.remove('active');
  }
  var panels = document.querySelectorAll('.tab-panel');
  for (var j = 0; j < panels.length; j++) panels[j].classList.remove('active');
  var panel = document.getElementById('panel-' + tabName);
  if (panel) panel.classList.add('active');

  inputArea.style.display = (tabName === 'messages') ? '' : 'none';
  if (tabName === 'messages') {
    updateCtxBanner();
    fetchMessages().then(renderMessages);
  }
  else if (tabName === 'channels') fetchChannels().then(renderChannels);
  else if (tabName === 'nodes') fetchNodes().then(renderNodes);
  else if (tabName === 'settings') pollAll();
}

// --- EVENTS ---
var tabButtons = document.querySelectorAll('.tab');
for (var i = 0; i < tabButtons.length; i++) {
  (function(btn) {
    btn.addEventListener('click', function() { switchTab(btn.getAttribute('data-tab')); });
  })(tabButtons[i]);
}

function handleSend() {
  var text = inputField.value.trim();
  if (!text) return;
  sendBtn.disabled = true;
  sendBtn.textContent = '...';
  sendMessage(text, state.dmTarget).then(function(result) {
    sendBtn.disabled = false;
    sendBtn.textContent = 'send';
   ; if (result && result.ok) { inputField.value = ''; pollAll(); }
    else { setStatus('send error: ' + ((result && result.error) ? result.error : 'failed'), 'error'); }
  });
}

sendBtn.addEventListener('click', handleSend);
inputField.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') { e.preventDefault(); handleSend(); }
});

dmTargetEl.addEventListener('click', clearDMTarget);

// Node filters
nodeSearch.addEventListener('input', function() {
  if (state.nodes.length > 0) renderNodes({ nodes: state.nodes });
});

sortBtn.addEventListener('click', function() {
  showSelect('sort by', SORT_OPTIONS, state.sortBy, function(val) {
    state.sortBy = val;
    var label = 'sort: ';
    for (var i = 0; i < SORT_OPTIONS.length; i++) {
      if (SORT_OPTIONS[i].value === val) { label += SORT_OPTIONS[i].label; break; }
    }
    sortBtn.textContent = label;
    if (state.nodes.length > 0) renderNodes({ nodes: state.nodes });
  });
});

roleBtn.addEventListener('click', function() {
  showSelect('filter by role', ROLE_OPTIONS, state.roleFilter, function(val) {
    state.roleFilter = val;
    var label = 'role: ';
    for (var i = 0; i < ROLE_OPTIONS.length; i++) {
      if (ROLE_OPTIONS[i].value === val) { label += ROLE_OPTIONS[i].label; break; }
    }
    roleBtn.textContent = label;
    if (state.nodes.length > 0) renderNodes({ nodes: state.nodes });
  });
});

favOnlyBtn.addEventListener('click', function() {
  state.favOnly = !state.favOnly;
  favOnlyBtn.classList.toggle('active');
  if (state.nodes.length > 0) renderNodes({ nodes: state.nodes });
});

msgSearch.addEventListener('input', function() {
  if (state.messages.length > 0) renderMessages({ messages: state.messages });
});

// Settings
testConnBtn.addEventListener('click', function() {
  settingsInfo.textContent = 'testing...';
  fetchStatus().then(function(status) {
    if (status) {
      if (status.connected) settingsInfo.textContent = 'connected - ' + status.node_count + ' nodes';
      else settingsInfo.textContent = 'server up - device offline';
    } else settingsInfo.textContent = 'unreachable';
  });
});

saveSettingsBtn.addEventListener('click', function() { saveSettings(); });

// Admin
document.getElementById('rebootBtn').addEventListener('click', function() {
  adminInfo.textContent = 'sending reboot...';
  adminAction('reboot').then(function(r) { adminInfo.textContent = r.ok ? 'reboot sent' : 'error: ' + (r.error || 'failed'); });
});
document.getElementById('shutdownBtn').addEventListener('click', function() {
  adminInfo.textContent = 'sending shutdown...';
  adminAction('shutdown').then(function(r) { adminInfo.textContent = r.ok ? 'shutdown sent' : 'error: ' + (r.error || 'failed'); });
});
document.getElementById('resetNodesBtn').addEventListener('click', function() {
  adminInfo.textContent = 'resetting nodedb...';
  adminAction('reset-nodedb').then(function(r) { adminInfo.textContent = r.ok ? 'nodedb reset' : 'error: ' + (r.error || 'failed'); });
});

// Theme
document.getElementById('themeBtn').addEventListener('click', function() {
  var isDark = document.body.getAttribute('data-theme') === 'dark';
  if (isDark) { document.body.removeAttribute('data-theme'); localStorage.setItem('mesh_kindle_theme', 'light'); }
  else { document.body.setAttribute('data-theme', 'dark'); localStorage.setItem('mesh_kindle_theme', 'dark'); }
});

// Serve NotoEmoji font
// The server already serves .ttf files via SimpleHTTPRequestHandler if path matches

// --- INIT ---
loadSettings();
startPolling();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(function() {});
}
