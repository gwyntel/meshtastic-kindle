/*
 * mesh-kindle: Meshtastic client for Kindle e-ink browsers
 * ES2019 only — no optional chaining (?.), no nullish coalescing (??)
 * No frameworks, no build step, no emojis
 */

var state = {
  connected: false,
  activeTab: 'messages',
  lastMessageCount: 0,
  pollTimer: null,
};

var config = {
  serverUrl: window.location.origin,
  channel: 0,
  pollInterval: 2000,
};

// --- DOM ---
var messageList = document.getElementById('messageList');
var nodeList = document.getElementById('nodeList');
var positionList = document.getElementById('positionList');
var channelList = document.getElementById('channelList');
var inputField = document.getElementById('inputField');
var sendBtn = document.getElementById('sendBtn');
var refreshBtn = document.getElementById('refreshBtn');
var statusBar = document.getElementById('statusBar');
var settingsBtn = document.getElementById('settingsBtn');
var settingsOverlay = document.getElementById('settingsOverlay');
var closeSettings = document.getElementById('closeSettings');
var deviceUrlInput = document.getElementById('deviceUrlInput');
var channelInput = document.getElementById('channelInput');
var pollInput = document.getElementById('pollInput');
var testConnBtn = document.getElementById('testConnBtn');
var saveSettingsBtn = document.getElementById('saveSettingsBtn');
var settingsInfo = document.getElementById('settingsInfo');

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
      console.error('fetch error:', e);
      return null;
    });
}

function fetchStatus() {
  return fetchJSON(config.serverUrl + '/api/status');
}

function fetchMessages() {
  return fetchJSON(config.serverUrl + '/api/messages');
}

function fetchNodes() {
  return fetchJSON(config.serverUrl + '/api/nodes');
}

function fetchPositions() {
  return fetchJSON(config.serverUrl + '/api/positions');
}

function fetchChannels() {
  return fetchJSON(config.serverUrl + '/api/channels');
}

function sendMessage(text) {
  return fetch(config.serverUrl + '/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: text,
      channel: config.channel
    })
  })
  .then(function(r) { return r.json(); })
  .catch(function(e) {
    return { ok: false, error: e.message };
  });
}

// --- RENDER ---
function setStatus(text, type) {
  statusBar.textContent = text;
  statusBar.className = 'status-bar ' + (type || '');
}

function escapeHtml(text) {
  if (!text) return '';
  var div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatTime(timestamp) {
  if (!timestamp) return '--:--';
  var d = new Date(timestamp * 1000);
  var h = d.getHours().toString().padStart(2, '0');
  var m = d.getMinutes().toString().padStart(2, '0');
  return h + ':' + m;
}

function formatNodeId(nodeId) {
  if (!nodeId) return 'unknown';
  return nodeId;
}

function getNodeName(nodeId, nodes) {
  if (!nodeId || !nodes) return formatNodeId(nodeId);
  var node = nodes[nodeId];
  if (node && node.long_name) return node.long_name;
  if (node && node.short_name) return node.short_name;
  return formatNodeId(nodeId);
}

function renderMessages(data) {
  if (!data || !data.messages) return;

  var messages = data.messages;
  if (messages.length === 0) {
    if (messageList.querySelector('.empty-state')) return;
    messageList.innerHTML = '<div class="empty-state"><div class="empty-title">no messages</div><div class="empty-sub">waiting for mesh traffic...</div></div>';
    return;
  }

  // Only re-render if new messages
  if (messages.length === state.lastMessageCount) return;
  state.lastMessageCount = messages.length;

  // Build nodes lookup for name resolution
  var nodesMap = {};
  // We'll fetch nodes separately, for now just show node IDs

  var html = '';
  // Show last 50 messages
  var start = Math.max(0, messages.length - 50);
  for (var i = start; i < messages.length; i++) {
    var msg = messages[i];
    var fromName = msg.from_name || ('!' + msg.from.toString(16).padStart(8, '0'));
    var time = formatTime(msg.timestamp);

    html += '<div class="message">' +
      '<div class="message-meta">' + escapeHtml(fromName) + ' - ch' + (msg.channel || 0) + ' - ' + time + '</div>' +
      '<div class="message-text">' + escapeHtml(msg.text) + '</div>' +
      '</div>';
  }

  messageList.innerHTML = html;
  messageList.scrollTop = messageList.scrollHeight;
}

function renderNodes(data) {
  if (!data || !data.nodes) return;

  var nodes = data.nodes;
  if (nodes.length === 0) {
    if (nodeList.querySelector('.empty-state')) return;
    nodeList.innerHTML = '<div class="empty-state"><div class="empty-title">no nodes</div><div class="empty-sub">no nodes discovered yet</div></div>';
    return;
  }

  var html = '';
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    var name = node.long_name || node.short_name || node.id || 'unknown';
    var role = '';
    if (node.role === 1) role = ' [CLIENT]';
    else if (node.role === 2) role = ' [CLIENT MUTE]';
    else if (node.role === 3) role = ' [ROUTER]';
    else if (node.role === 4) role = ' [REPEATER]';
    else if (node.role === 6) role = ' [TRACKER]';

    html += '<div class="node-card">' +
      '<div class="node-name">' + escapeHtml(name) + role + '</div>' +
      '<div class="node-id">' + escapeHtml(node.id || '') + '</div>';

    if (node.telemetry) {
      var t = node.telemetry;
      html += '<div class="node-telemetry">';
      if (t.battery !== undefined) html += '<div class="tele-meter"><span class="tele-label">bat</span> ' + t.battery + '%</div>';
      if (t.voltage !== undefined) html += '<div class="tele-meter"><span class="tele-label">v</span> ' + t.voltage + '</div>';
      if (t.temp !== undefined) html += '<div class="tele-meter"><span class="tele-label">temp</span> ' + t.temp + 'C</div>';
      if (t.humidity !== undefined) html += '<div class="tele-meter"><span class="tele-label">hum</span> ' + t.humidity + '%</div>';
      if (t.channel_util !== undefined) html += '<div class="tele-meter"><span class="tele-label">ch_util</span> ' + t.channel_util + '%</div>';
      if (t.air_util !== undefined) html += '<div class="tele-meter"><span class="tele-label">air_util</span> ' + t.air_util + '%</div>';
      html += '</div>';
    }

    html += '</div>';
  }

  nodeList.innerHTML = html;
}

function renderPositions(data) {
  if (!data || !data.positions) return;

  var positions = data.positions;
  var keys = Object.keys(positions);
  if (keys.length === 0) {
    if (positionList.querySelector('.empty-state')) return;
    positionList.innerHTML = '<div class="empty-state"><div class="empty-title">no positions</div><div class="empty-sub">no position data available</div></div>';
    return;
  }

  var html = '';
  for (var i = 0; i < keys.length; i++) {
    var nodeId = keys[i];
    var pos = positions[nodeId];
    var name = pos.name || nodeId;

    html += '<div class="position-card">' +
      '<div class="position-name">' + escapeHtml(name) + '</div>' +
      '<div class="position-coords">' +
      (pos.lat !== undefined ? pos.lat.toFixed(6) : '--') + ', ' +
      (pos.lon !== undefined ? pos.lon.toFixed(6) : '--') +
      '</div>';
    if (pos.alt !== undefined) {
      html += '<div class="position-coords">alt: ' + pos.alt + 'm</div>';
    }
    html += '</div>';
  }

  positionList.innerHTML = html;
}

function renderChannels(data) {
  if (!data || !data.channels) return;

  var channels = data.channels;
  if (channels.length === 0) {
    if (channelList.querySelector('.empty-state')) return;
    channelList.innerHTML = '<div class="empty-state"><div class="empty-title">no channels</div><div class="empty-sub">waiting for channel data...</div></div>';
    return;
  }

  var html = '';
  for (var i = 0; i < channels.length; i++) {
    var ch = channels[i];
    var roleTag = '';
    if (ch.role === 'PRIMARY') roleTag = ' [PRIMARY]';
    else if (ch.role === 'SECONDARY') roleTag = ' [SECONDARY]';
    else if (ch.role === 'DISABLED') roleTag = ' [DISABLED]';

    html += '<div class="channel-card">' +
      '<div class="channel-name">' + escapeHtml(ch.name || ('ch' + ch.index)) + roleTag + '</div>' +
      '<div class="channel-meta">index ' + ch.index;

    if (ch.uplink_enabled) html += ' - uplink:on';
    if (ch.downlink_enabled) html += ' - downlink:on';
    html += '</div>';

    html += '</div>';
  }

  channelList.innerHTML = html;
}

// --- POLLING ---
function pollAll() {
  // Always fetch status
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

      if (status.device_info && status.device_info.firmware) {
        // Could display firmware version somewhere
      }
    } else {
      setStatus('server unreachable', 'error');
    }
  });

  // Fetch tab-specific data
  if (state.activeTab === 'messages') {
    fetchMessages().then(renderMessages);
  } else if (state.activeTab === 'channels') {
    fetchChannels().then(renderChannels);
  } else if (state.activeTab === 'nodes') {
    fetchNodes().then(renderNodes);
  } else if (state.activeTab === 'map') {
    fetchPositions().then(renderPositions);
  }
}

function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  pollAll(); // Immediate first poll
  state.pollTimer = setInterval(pollAll, config.pollInterval);
}

function restartPolling() {
  startPolling();
}

// --- TABS ---
function switchTab(tabName) {
  state.activeTab = tabName;

  // Update tab buttons
  var tabs = document.querySelectorAll('.tab');
  for (var i = 0; i < tabs.length; i++) {
    if (tabs[i].getAttribute('data-tab') === tabName) {
      tabs[i].classList.add('active');
    } else {
      tabs[i].classList.remove('active');
    }
  }

  // Update panels
  var panels = document.querySelectorAll('.tab-panel');
  for (var j = 0; j < panels.length; j++) {
    panels[j].classList.remove('active');
  }
  var panel = document.getElementById('panel-' + tabName);
  if (panel) panel.classList.add('active');

  // Immediate data fetch for new tab
  if (tabName === 'messages') {
    fetchMessages().then(renderMessages);
  } else if (tabName === 'channels') {
    fetchChannels().then(renderChannels);
  } else if (tabName === 'nodes') {
    fetchNodes().then(renderNodes);
  } else if (tabName === 'map') {
    fetchPositions().then(renderPositions);
  }
}

// --- EVENTS ---
// Tab clicks
var tabButtons = document.querySelectorAll('.tab');
for (var i = 0; i < tabButtons.length; i++) {
  (function(btn) {
    btn.addEventListener('click', function() {
      switchTab(btn.getAttribute('data-tab'));
    });
  })(tabButtons[i]);
}

// Send message
function handleSend() {
  var text = inputField.value.trim();
  if (!text) return;

  sendBtn.disabled = true;
  sendBtn.textContent = '...';

  sendMessage(text).then(function(result) {
    sendBtn.disabled = false;
    sendBtn.textContent = 'send';

    if (result && result.ok) {
      inputField.value = '';
      // Immediate poll to pick up the message
      pollAll();
    } else {
      var err = (result && result.error) ? result.error : 'send failed';
      setStatus('send error: ' + err, 'error');
    }
  });
}

sendBtn.addEventListener('click', handleSend);

inputField.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    handleSend();
  }
});

// Refresh
refreshBtn.addEventListener('click', function() {
  pollAll();
});

// Settings
settingsBtn.addEventListener('click', function() {
  settingsOverlay.classList.add('active');
});

closeSettings.addEventListener('click', function() {
  settingsOverlay.classList.remove('active');
});

settingsOverlay.addEventListener('click', function(e) {
  if (e.target === settingsOverlay) {
    settingsOverlay.classList.remove('active');
  }
});

testConnBtn.addEventListener('click', function() {
  settingsInfo.textContent = 'testing...';
  fetchStatus().then(function(status) {
    if (status) {
      if (status.connected) {
        settingsInfo.textContent = 'connected - ' + status.node_count + ' nodes';
      } else {
        settingsInfo.textContent = 'server up - device offline';
      }
    } else {
      settingsInfo.textContent = 'unreachable';
    }
  });
});

saveSettingsBtn.addEventListener('click', function() {
  saveSettings();
  settingsOverlay.classList.remove('active');
});

// --- THEME TOGGLE (triple-tap header title) ---
var tapCount = 0;
var tapTimer = null;
document.querySelector('.header-title').addEventListener('click', function() {
  tapCount++;
  if (tapTimer) clearTimeout(tapTimer);
  tapTimer = setTimeout(function() { tapCount = 0; }, 600);

  if (tapCount >= 3) {
    tapCount = 0;
    var isDark = document.body.getAttribute('data-theme') === 'dark';
    if (isDark) {
      document.body.removeAttribute('data-theme');
      localStorage.setItem('mesh_kindle_theme', 'light');
    } else {
      document.body.setAttribute('data-theme', 'dark');
      localStorage.setItem('mesh_kindle_theme', 'dark');
    }
  }
});

// --- INIT ---
loadSettings();
startPolling();

// Register service worker for PWA
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(function(e) {
    console.log('SW registration failed:', e);
  });
}
