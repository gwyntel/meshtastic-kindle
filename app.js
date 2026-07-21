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
  nodeCache: {},  // id -> node, for name resolution in messages
  homeLat: null,
  homeLon: null,
  dmTarget: null,  // null = broadcast, '!hexid' = DM target
  favOnly: false,
};

var config = {
  serverUrl: window.location.origin,
  channel: 0,
  pollInterval: 2000,
};

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
var nodeRoleFilter = document.getElementById('nodeRoleFilter');
var nodeSort = document.getElementById('nodeSort');
var favOnlyBtn = document.getElementById('favOnlyBtn');
var msgSearch = document.getElementById('msgSearch');
var dmTargetEl = document.getElementById('dmTarget');
var inputArea = document.getElementById('inputArea');

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
    .catch(function(e) {
      return null;
    });
}

function fetchStatus() { return fetchJSON(config.serverUrl + '/api/status'); }
function fetchMessages() { return fetchJSON(config.serverUrl + '/api/messages'); }
function fetchNodes() { return fetchJSON(config.serverUrl + '/api/nodes'); }
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

function formatTime(timestamp) {
  if (!timestamp) return '--:--';
  var d = new Date(timestamp * 1000);
  var h = d.getHours();
  var m = d.getMinutes();
  h = h < 10 ? '0' + h : '' + h;
  m = m < 10 ? '0' + m : '' + m;
  return h + ':' + m;
}

function formatUptime(seconds) {
  if (!seconds || seconds <= 0) return '--';
  var days = Math.floor(seconds / 86400);
  var hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return days + 'd ' + hours + 'h';
  var mins = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return hours + 'h ' + mins + 'm';
  return mins + 'm';
}

function timeAgo(timestamp) {
  if (!timestamp) return 'never';
  var now = Math.floor(Date.now() / 1000);
  var diff = now - timestamp;
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

  // Build node cache for name resolution
  var nodeMap = {};
  for (var i = 0; i < state.nodes.length; i++) {
    nodeMap[state.nodes[i].id] = state.nodes[i];
  }
  state.nodeCache = nodeMap;

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

    html += '<div class="message">' +
      '<div class="message-meta">' + escapeHtml(fromName) + dmTag + ' - ch' + (m.channel || 0) + ' - ' + time + '</div>' +
      '<div class="message-text">' + escapeHtml(m.text) + '</div>' +
      '</div>';
  }

  messageList.innerHTML = html;
  messageList.scrollTop = messageList.scrollHeight;
}

function getNodeName(nodeId) {
  if (!nodeId) return 'unknown';
  var node = state.nodeCache[nodeId];
  if (node && node.long_name) return node.long_name;
  if (node && node.short_name) return node.short_name;
  return nodeId;
}

// --- RENDER: NODES ---
function renderNodes(data) {
  if (!data || !data.nodes) return;
  var nodes = data.nodes;
  state.nodes = nodes;

  // Find home node position for distance calc
  for (var h = 0; h < nodes.length; h++) {
    if (nodes[h].is_favorite && nodes[h].position) {
      state.homeLat = nodes[h].position.lat;
      state.homeLon = nodes[h].position.lon;
      break;
    }
  }

  // Apply filters
  var filtered = nodes;
  var searchTerm = (nodeSearch.value || '').toLowerCase();
  if (searchTerm) {
    filtered = [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var name = (n.long_name || n.short_name || n.id || '').toLowerCase();
      if (name.indexOf(searchTerm) >= 0) filtered.push(n);
    }
  }

  var roleFilter = nodeRoleFilter.value;
  if (roleFilter !== 'all') {
    filtered = filtered.filter(function(n) {
      return n.role === roleFilter;
    });
  }

  if (state.favOnly) {
    filtered = filtered.filter(function(n) {
      return n.is_favorite;
    });
  }

  // Sort
  var sortBy = nodeSort.value;
  filtered.sort(function(a, b) {
    if (sortBy === 'name') return (a.long_name || a.id || '').localeCompare(b.long_name || b.id || '');
    if (sortBy === 'last_heard') return (b.last_heard || 0) - (a.last_heard || 0);
    if (sortBy === 'snr') return (b.snr !== null ? b.snr : -999) - (a.snr !== null ? a.snr : -999);
    if (sortBy === 'hops') return (a.hops_away !== null ? a.hops_away : 999) - (b.hops_away !== null ? b.hops_away : 999);
    if (sortBy === 'distance') {
      var da = getNodeDistance(a);
      var db = getNodeDistance(b);
      if (da === null) da = 99999;
      if (db === null) db = 99999;
      return da - db;
    }
    return 0;
  });

  if (filtered.length === 0) {
    nodeList.innerHTML = '<div class="empty-state"><div class="empty-title">no nodes</div><div class="empty-sub">' + (searchTerm ? 'no matches' : 'no nodes discovered yet') + '</div></div>';
    return;
  }

  var html = '';
  for (var j = 0; j < filtered.length; j++) {
    var node = filtered[j];
    var name = node.long_name || node.short_name || node.id || 'unknown';
    var roleTag = '';
    if (node.role) roleTag = ' [' + node.role + ']';
    var favStar = node.is_favorite ? ' *' : '';

    html += '<div class="node-card' + (node.is_favorite ? ' node-fav' : '') + '" data-nodeid="' + escapeHtml(node.id || '') + '">';
    html += '<div class="node-name">' + escapeHtml(name) + favStar + roleTag + '</div>';
    html += '<div class="node-id">' + escapeHtml(node.id || '') + '</div>';

    // Position + distance
    if (node.position) {
      var lat = node.position.lat;
      var lon = node.position.lon;
      var alt = node.position.alt;
      html += '<div class="node-pos">' +
        (lat !== undefined ? lat.toFixed(5) : '--') + ', ' +
        (lon !== undefined ? lon.toFixed(5) : '--');
      if (alt !== undefined && alt !== null) html += ' alt:' + alt + 'm';
      var dist = getNodeDistance(node);
      if (dist !== null) {
        html += ' (' + dist.toFixed(1) + 'km';
        var brng = bearing(state.homeLat, state.homeLon, lat, lon);
        if (brng) html += ' ' + brng;
        html += ')';
      }
      html += '</div>';
    }

    // Telemetry
    if (node.telemetry) {
      var t = node.telemetry;
      html += '<div class="node-telemetry">';
      if (t.battery !== undefined && t.battery !== null) html += '<div class="tele-meter"><span class="tele-label">bat</span> ' + t.battery + '%</div>';
      if (t.voltage !== undefined && t.voltage !== null) html += '<div class="tele-meter"><span class="tele-label">v</span> ' + t.voltage.toFixed(2) + '</div>';
      if (t.temp !== undefined && t.temp !== null) html += '<div class="tele-meter"><span class="tele-label">temp</span> ' + t.temp + 'C</div>';
      if (t.humidity !== undefined && t.humidity !== null) html += '<div class="tele-meter"><span class="tele-label">hum</span> ' + t.humidity + '%</div>';
      if (t.channel_util !== undefined && t.channel_util !== null) html += '<div class="tele-meter"><span class="tele-label">ch</span> ' + t.channel_util.toFixed(1) + '%</div>';
      if (t.air_util !== undefined && t.air_util !== null) html += '<div class="tele-meter"><span class="tele-label">air</span> ' + t.air_util.toFixed(1) + '%</div>';
      html += '</div>';
    }

    // Mesh info
    html += '<div class="node-mesh">';
    if (node.snr !== undefined && node.snr !== null) html += '<span class="tele-meter">snr:' + node.snr + 'dB</span>';
    if (node.hops_away !== undefined && node.hops_away !== null) html += '<span class="tele-meter">hops:' + node.hops_away + '</span>';
    if (node.via_mqtt) html += '<span class="tele-meter">mqtt</span>';
    html += '<span class="tele-meter">last:' + timeAgo(node.last_heard) + '</span>';
    html += '</div>';

    // Actions
    html += '<div class="node-actions">';
    html += '<button class="btn btn-mini" data-action="dm" data-nodeid="' + escapeHtml(node.id || '') + '">msg</button>';
    html += '<button class="btn btn-mini" data-action="fav" data-nodeid="' + escapeHtml(node.id || '') + '">' + (node.is_favorite ? 'unfav' : 'fav') + '</button>';
    html += '</div>';

    html += '</div>';
  }

  nodeList.innerHTML = html;

  // Wire action buttons
  var actionBtns = nodeList.querySelectorAll('[data-action]');
  for (var k = 0; k < actionBtns.length; k++) {
    (function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var action = btn.getAttribute('data-action');
        var nodeId = btn.getAttribute('data-nodeid');
        if (action === 'dm') {
          setDMTarget(nodeId);
        } else if (action === 'fav') {
          toggleFavorite(nodeId).then(function() {
            pollAll();
          });
        }
      });
    })(actionBtns[k]);
  }
}

function getNodeDistance(node) {
  if (!node.position || !node.position.lat || state.homeLat === null) return null;
  return calcDistance(state.homeLat, state.homeLon, node.position.lat, node.position.lon);
}

// --- RENDER: CHANNELS ---
var channelFilter = 'all';
function renderChannels(data) {
  if (!data || !data.channels) return;
  var channels = data.channels;
  state.channels = channels;

  var filtered = channels;
  if (channelFilter === 'active') {
    filtered = channels.filter(function(c) { return c.role !== 'DISABLED'; });
  } else if (channelFilter === 'disabled') {
    filtered = channels.filter(function(c) { return c.role === 'DISABLED'; });
  }

  if (filtered.length === 0) {
    channelList.innerHTML = '<div class="empty-state"><div class="empty-title">no channels</div><div class="empty-sub">no ' + channelFilter + ' channels</div></div>';
    return;
  }

  var html = '';
  for (var i = 0; i < filtered.length; i++) {
    var ch = filtered[i];
    var roleTag = '';
    if (ch.role === 'PRIMARY') roleTag = ' [PRIMARY]';
    else if (ch.role === 'SECONDARY') roleTag = ' [SECONDARY]';
    else if (ch.role === 'DISABLED') roleTag = ' [DISABLED]';

    html += '<div class="channel-card' + (ch.role === 'DISABLED' ? ' channel-disabled' : '') + '">';
    html += '<div class="channel-name">' + escapeHtml(ch.name || ('ch' + ch.index)) + roleTag + '</div>';
    html += '<div class="channel-meta">index ' + ch.index;
    if (ch.uplink_enabled) html += ' - up:on'; else html += ' - up:off';
    if (ch.downlink_enabled) html += ' - dn:on'; else html += ' - dn:off';
    html += '</div>';
    html += '</div>';
  }

  channelList.innerHTML = html;
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

function infoRow(label, value) {
  return '<div class="info-row"><span class="info-label">' + escapeHtml(label) + '</span><span class="info-val">' + escapeHtml(String(value)) + '</span></div>';
}

// --- DM ---
function setDMTarget(nodeId) {
  if (state.dmTarget === nodeId) {
    clearDMTarget();
    return;
  }
  state.dmTarget = nodeId;
  var name = getNodeName(nodeId);
  inputField.placeholder = 'DM to ' + name + '...';
  dmTargetEl.textContent = 'DM: ' + name + ' (tap to cancel)';
  dmTargetEl.className = 'dm-target active';
}

function clearDMTarget() {
  state.dmTarget = null;
  inputField.placeholder = 'broadcast...';
  dmTargetEl.textContent = '';
  dmTargetEl.className = 'dm-target';
}

// --- POLLING ---
function pollAll() {
  fetchStatus().then(function(status) {
    if (status) {
      state.connected = status.connected;
      if (status.connected) {
        var nodeCount = status.node_count || 0;
        var msgCount = status.message_count || 0;
        setStatus('online - ' + nodeCount + ' nodes - ' + msgCount + ' msgs', 'connected');
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
    // Also fetch nodes for name resolution
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

  // Show/hide input area based on tab
  if (tabName === 'messages') inputArea.style.display = '';
  else inputArea.style.display = 'none';

  // Immediate data fetch
  if (tabName === 'messages') {
    fetchMessages().then(renderMessages);
  } else if (tabName === 'channels') {
    fetchChannels().then(renderChannels);
  } else if (tabName === 'nodes') {
    fetchNodes().then(renderNodes);
  } else if (tabName === 'settings') {
    pollAll();
  }
}

// --- EVENTS ---
var tabButtons = document.querySelectorAll('.tab');
for (var i = 0; i < tabButtons.length; i++) {
  (function(btn) {
    btn.addEventListener('click', function() { switchTab(btn.getAttribute('data-tab')); });
  })(tabButtons[i]);
}

// Send message / DM
function handleSend() {
  var text = inputField.value.trim();
  if (!text) return;
  sendBtn.disabled = true;
  sendBtn.textContent = '...';
  sendMessage(text, state.dmTarget).then(function(result) {
    sendBtn.disabled = false;
    sendBtn.textContent = 'send';
    if (result && result.ok) {
      inputField.value = '';
      pollAll();
    } else {
      var err = (result && result.error) ? result.error : 'send failed';
      setStatus('send error: ' + err, 'error');
    }
  });
}

sendBtn.addEventListener('click', handleSend);
inputField.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') { e.preventDefault(); handleSend(); }
});

// DM target cancel
dmTargetEl.addEventListener('click', clearDMTarget);

// Node filters
nodeSearch.addEventListener('input', function() {
  if (state.nodes.length > 0) renderNodes({ nodes: state.nodes });
});
nodeRoleFilter.addEventListener('change', function() {
  if (state.nodes.length > 0) renderNodes({ nodes: state.nodes });
});
nodeSort.addEventListener('change', function() {
  if (state.nodes.length > 0) renderNodes({ nodes: state.nodes });
});
favOnlyBtn.addEventListener('click', function() {
  state.favOnly = !state.favOnly;
  favOnlyBtn.classList.toggle('active');
  if (state.nodes.length > 0) renderNodes({ nodes: state.nodes });
});

// Message search
msgSearch.addEventListener('input', function() {
  if (state.messages.length > 0) renderMessages({ messages: state.messages });
});

// Channel filters
var chFilterBtns = document.querySelectorAll('[data-chfilter]');
for (var j = 0; j < chFilterBtns.length; j++) {
  (function(btn) {
    btn.addEventListener('click', function() {
      channelFilter = btn.getAttribute('data-chfilter');
      for (var k = 0; k < chFilterBtns.length; k++) chFilterBtns[k].classList.remove('active');
      btn.classList.add('active');
      if (state.channels.length > 0) renderChannels({ channels: state.channels });
    });
  })(chFilterBtns[j]);
}

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

saveSettingsBtn.addEventListener('click', function() {
  saveSettings();
});

// Admin actions
document.getElementById('rebootBtn').addEventListener('click', function() {
  adminInfo.textContent = 'sending reboot...';
  adminAction('reboot').then(function(r) {
    adminInfo.textContent = r.ok ? 'reboot sent' : ('error: ' + (r.error || 'failed'));
  });
});
document.getElementById('shutdownBtn').addEventListener('click', function() {
  adminInfo.textContent = 'sending shutdown...';
  adminAction('shutdown').then(function(r) {
    adminInfo.textContent = r.ok ? 'shutdown sent' : ('error: ' + (r.error || 'failed'));
  });
});
document.getElementById('resetNodesBtn').addEventListener('click', function() {
  adminInfo.textContent = 'resetting nodedb...';
  adminAction('reset-nodedb').then(function(r) {
    adminInfo.textContent = r.ok ? 'nodedb reset sent' : ('error: ' + (r.error || 'failed'));
  });
});

// Theme toggle button
document.getElementById('themeBtn').addEventListener('click', function() {
  var isDark = document.body.getAttribute('data-theme') === 'dark';
  if (isDark) {
    document.body.removeAttribute('data-theme');
    localStorage.setItem('mesh_kindle_theme', 'light');
  } else {
    document.body.setAttribute('data-theme', 'dark');
    localStorage.setItem('mesh_kindle_theme', 'dark');
  }
});

// --- INIT ---
loadSettings();
startPolling();

// Register service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(function(e) {});
}
