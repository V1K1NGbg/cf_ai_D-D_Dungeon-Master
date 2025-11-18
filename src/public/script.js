// Frontend glue code that wires the lobby controls to the Cloudflare Worker API.
function generateEpicName() {
  const adjectives = ['Epic', 'Legendary', 'Mystical', 'Ancient', 'Forgotten', 'Dark', 'Golden', 'Cursed'];
  const nouns = ['Quest', 'Journey', 'Adventure', 'Saga', 'Tale', 'Legend', 'Realm', 'Empire'];
  return adjectives[Math.floor(Math.random() * adjectives.length)] + ' ' + nouns[Math.floor(Math.random() * nouns.length)];
}

const log = document.getElementById('log');
const sessionIdEl = document.getElementById('sessionId');
const playerSelectEl = document.getElementById('playerSelect');
const nameEl = document.getElementById('name');
const actionEl = document.getElementById('action');
const clearSessionsBtn = document.getElementById('clearSessions');
const currentSessionEl = document.getElementById('currentSession');
const IS_LOCAL_HOST = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
let currentPlayerId = '';
let currentPlayerName = '';
let currentSessionId = '';
let lastMessageCount = 0;
let pollingInterval = null;

// Hydrate the session select dropdown from the registry endpoint.
async function loadSessions() {
  try {
    const res = await fetch('/api/sessions');
    const data = await res.json();
    sessionIdEl.innerHTML = '';
    data.sessions.forEach(session => {
      const option = document.createElement('option');
      option.value = session;
      option.textContent = session;
      sessionIdEl.appendChild(option);
    });
    const createOption = document.createElement('option');
    createOption.value = 'create-new';
    createOption.textContent = 'Create new story';
    sessionIdEl.appendChild(createOption);
  } catch (e) {
    console.error('Failed to load sessions', e);
    // Fallback
    const option = document.createElement('option');
    option.value = 'demo-session';
    option.textContent = 'demo-session';
    sessionIdEl.appendChild(option);
    const createOption = document.createElement('option');
    createOption.value = 'create-new';
    createOption.textContent = 'Create new story';
    sessionIdEl.appendChild(createOption);
  }
}

// Refreshes the player dropdown for whichever session is selected.
async function loadPlayers() {
  const sessionId = sessionIdEl.value;
  if (!sessionId || sessionId === 'create-new') {
    playerSelectEl.innerHTML = '<option value="new">New Player</option>';
    nameEl.value = '';
    return;
  }
  try {
    const res = await fetch(`/api/session/state?sessionId=${encodeURIComponent(sessionId)}`);
    const data = await res.json();
    playerSelectEl.innerHTML = '<option value="new">New Player</option>';
    data.players.forEach(player => {
      const option = document.createElement('option');
      option.value = player.id;
      option.textContent = player.name;
      playerSelectEl.appendChild(option);
    });
    nameEl.value = '';
  } catch (e) {
    console.error('Failed to load players', e);
    playerSelectEl.innerHTML = '<option value="new">New Player</option>';
    nameEl.value = '';
  }
}

function clearLog() {
  log.innerHTML = '';
}

function showJoinPrompt() {
  console.log('🚪 showJoinPrompt called - hiding game UI');

  // Remove game-active class
  document.body.classList.remove('game-active');

  document.querySelector('.join-section').style.display = 'block';
  document.querySelector('.action-section').style.display = 'none';
  document.querySelector('.help-text').style.display = 'none';

  const characterPanel = document.getElementById('characterPanel');
  if (characterPanel) {
    characterPanel.style.display = 'none';
    console.log('🙈 Character panel hidden');
  }

  currentPlayerId = '';
  currentPlayerName = '';
  currentSessionId = '';
  actionEl.value = '';
  stopPolling();
}

function enableChat() {
  console.log('🎮 enableChat called - showing game UI');

  // Add game-active class to body for CSS control
  document.body.classList.add('game-active');

  // Also set display directly for immediate effect
  document.querySelector('.join-section').style.display = 'none';
  document.getElementById('log').style.display = 'block';
  document.querySelector('.action-section').style.display = 'flex';
  document.querySelector('.help-text').style.display = 'block';

  const characterPanel = document.getElementById('characterPanel');
  if (characterPanel) {
    characterPanel.style.display = 'flex';
    console.log('✅ Character panel set to display: flex');
  } else {
    console.error('❌ Character panel element not found!');
  }

  startPolling();

  // Force initial update
  setTimeout(() => {
    console.log('🔄 Calling initial updateCharacterPanel...');
    updateCharacterPanel();
  }, 100);
}

function startPolling() {
  // Clear any existing polling interval
  if (pollingInterval) {
    clearInterval(pollingInterval);
  }

  // Poll for updates every 2 seconds for more responsive character panel updates
  pollingInterval = setInterval(async () => {
    if (!currentSessionId) {
      console.log('⏸️ Polling skipped - no current session');
      return;
    }

    console.log('🔄 Polling for updates...');
    try {
      const res = await fetch(`/api/session/state?sessionId=${encodeURIComponent(currentSessionId)}`);
      console.log('📡 Polling response status:', res.status);

      if (res.ok) {
        const data = await res.json();
        console.log('📊 Polling data received:', data);

        if (data.messages && data.messages.length > lastMessageCount) {
          console.log('💬 New messages detected:', data.messages.length - lastMessageCount);
          // New messages available - only add the new ones to avoid duplicates
          const newMessages = data.messages.slice(lastMessageCount);
          newMessages.forEach(msg => {
            addMsg(msg.actor, msg.content);
          });
          lastMessageCount = data.messages.length;
        }
        // Always update character panel with latest data
        console.log('🔄 Calling updateCharacterPanel from polling...');
        updateCharacterPanel(data.players, data.combat);
      } else {
        console.error('❌ Polling failed with status:', res.status);
      }
    } catch (e) {
      console.error('❌ Polling error:', e);
    }
  }, 2000);
}

function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

function hydrateMessages(messages = []) {
  clearLog();
  messages.forEach(msg => addMsg(msg.actor, msg.content));
  lastMessageCount = messages.length;
}

// Lightweight UI reset used whenever a session ends or is cleared.
async function resetAppToInitialState(finalMessage = 'The adventure has concluded. Returning to the lobby...') {
  try {
    stopPolling();
    clearLog();
    if (finalMessage) {
      addMsg('DM', finalMessage);
    }
    addMsg('DM', 'Session reset. Join an existing game or start a new story.');
    showJoinPrompt();
    document.getElementById('log').style.display = 'block';
    currentPlayerId = '';
    currentPlayerName = '';
    currentSessionId = '';
    lastMessageCount = 0;
    actionEl.value = '';
    currentSessionEl.textContent = '';
    await loadSessions();
    sessionIdEl.value = 'create-new';
    await loadPlayers();
  } catch (error) {
    console.error('Failed to reset UI after game end', error);
    window.location.reload();
  }
}

// Append a chat bubble, differentiating between the DM narration and players.
function addMsg(actor, content = '', thinking = '', isPlaceholder = false) {
  const div = document.createElement('div');
  div.className = 'msg ' + (actor === 'DM' ? 'dm' : 'player');

  const label = document.createElement('span');
  label.textContent = actor + ': ';
  div.appendChild(label);

  if (actor === 'DM') {
    if (isPlaceholder) {
      const placeholder = document.createElement('span');
      placeholder.textContent = content;
      placeholder.className = 'pulsating';
      div.appendChild(placeholder);
    } else {
      div.appendChild(renderDmContent(content, thinking));
    }
  } else {
    div.appendChild(document.createTextNode(String(content ?? '')));
  }

  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

// Admin helper tied to the "Clear Sessions" button; wipes the registry via API.
async function clearAllSessions() {
  const confirmed = window.confirm('Clear all sessions? Any in-progress games will be lost.');
  if (!confirmed) {
    return;
  }

  const previousLabel = clearSessionsBtn.textContent;
  clearSessionsBtn.disabled = true;
  clearSessionsBtn.textContent = 'Clearing...';

  try {
    const res = await fetch('/api/sessions/clear', { method: 'POST' });
    if (!res.ok) {
      throw new Error('Failed to clear sessions');
    }
    addMsg('DM', 'All sessions cleared. Start a new story to begin playing again.');
    await loadSessions();
    sessionIdEl.value = 'create-new';
    await loadPlayers();
    showJoinPrompt();
    currentSessionEl.textContent = '';
  } catch (error) {
    console.error('Failed to clear sessions', error);
    addMsg('DM', 'Unable to clear sessions. Please try again.');
  } finally {
    clearSessionsBtn.disabled = false;
    clearSessionsBtn.textContent = previousLabel;
  }
}

// Basic Markdown to HTML converter for DM responses
function markdownToHtml(text) {
  const fragment = document.createDocumentFragment();

  // Split by lines to handle paragraphs, lists, and headers
  const lines = text.split('\n');
  let currentParagraph = null;
  let inList = false;
  let listElement = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line === '') {
      // Empty line ends paragraph or list
      if (currentParagraph) {
        fragment.appendChild(currentParagraph);
        currentParagraph = null;
      }
      if (inList) {
        fragment.appendChild(listElement);
        listElement = null;
        inList = false;
      }
      continue;
    }

    // Check for headers (# and ##)
    const h1Match = line.match(/^#\s+(.*)$/);
    const h2Match = line.match(/^##\s+(.*)$/);

    if (h1Match) {
      // Close any open elements
      if (currentParagraph) {
        fragment.appendChild(currentParagraph);
        currentParagraph = null;
      }
      if (inList) {
        fragment.appendChild(listElement);
        listElement = null;
        inList = false;
      }

      const h1 = document.createElement('h1');
      h1.className = 'dm-title';
      h1.innerHTML = inlineMarkdown(h1Match[1]);
      fragment.appendChild(h1);
      continue;
    }

    if (h2Match) {
      // Close any open elements
      if (currentParagraph) {
        fragment.appendChild(currentParagraph);
        currentParagraph = null;
      }
      if (inList) {
        fragment.appendChild(listElement);
        listElement = null;
        inList = false;
      }

      const h2 = document.createElement('h2');
      h2.className = 'dm-subtitle';
      h2.innerHTML = inlineMarkdown(h2Match[1]);
      fragment.appendChild(h2);
      continue;
    }

    // Check for list items
    const listMatch = line.match(/^[-*]\s+(.*)$/);
    if (listMatch) {
      if (!inList) {
        listElement = document.createElement('ul');
        inList = true;
      }
      const li = document.createElement('li');
      li.innerHTML = inlineMarkdown(listMatch[1]);
      listElement.appendChild(li);
      continue;
    }

    // If we were in a list but this line isn't, end the list
    if (inList) {
      fragment.appendChild(listElement);
      listElement = null;
      inList = false;
    }

    // Start or continue paragraph
    if (!currentParagraph) {
      currentParagraph = document.createElement('p');
    }
    currentParagraph.innerHTML += inlineMarkdown(line) + ' ';
  }

  // Close any open elements
  if (currentParagraph) {
    fragment.appendChild(currentParagraph);
  }
  if (inList) {
    fragment.appendChild(listElement);
  }

  return fragment;
}

// Inline Markdown parsing for bold, italic, code
function inlineMarkdown(text) {
  // Escape HTML first
  text = text.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Bold: **text** or __text__
  text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__(.*?)__/g, '<strong>$1</strong>');

  // Italic: *text* or _text_
  text = text.replace(/\*(.*?)\*/g, '<em>$1</em>');
  text = text.replace(/_(.*?)_/g, '<em>$1</em>');

  // Inline code: `text`
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Line breaks
  text = text.replace(/\n/g, '<br>');

  return text;
}

// Split out <thinking> blocks so reasoning can be hidden behind a disclosure widget.
function renderDmContent(rawContent, thinking = '') {
  const fragment = document.createDocumentFragment();
  const text = typeof rawContent === 'string' ? rawContent : String(rawContent ?? '');
  let narrative = text;
  let thinkingContent = thinking;

  // If thinking not provided, try to parse from text for backward compatibility
  if (!thinkingContent) {
    const thinkingMatch = text.match(/<thinking>([\s\S]*?)<\/thinking>/i);
    if (thinkingMatch) {
      thinkingContent = thinkingMatch[1].trim();
      narrative = rawContent.replace(/<thinking>[\s\S]*?<\/thinking>/i, '').trim();
    }
  }

  if (thinkingContent) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'DM Thinking';
    const pre = document.createElement('pre');
    pre.textContent = thinkingContent;
    details.appendChild(summary);
    details.appendChild(pre);
    fragment.appendChild(details);
  }

  if (narrative) {
    fragment.appendChild(markdownToHtml(narrative));
  }

  return fragment;
}

// Join or create a session, then hydrate the UI with the server's response.
async function join() {
  let sessionId = sessionIdEl.value;
  if (sessionId === 'create-new') {
    sessionId = generateEpicName();
    sessionIdEl.value = sessionId;
  }
  let playerId = playerSelectEl.value;
  if (playerId === 'new') {
    playerId = 'player_' + Date.now();
  }
  const name = nameEl.value.trim();
  if (!name) {
    addMsg('DM', 'Please enter a character name before joining.');
    return;
  }

  const res = await fetch('/api/session/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, playerId, name }),
  });
  const data = await res.json();
  console.log('🎮 Join response data:', data);

  if (data.messages) {
    hydrateMessages(data.messages);
  } else {
    clearLog();
  }
  addMsg('DM', `Joined as ${name}. Players: ${data.players.map(p => p.name).join(', ')}`);
  await loadSessions();
  sessionIdEl.value = sessionId;
  await loadPlayers();
  playerSelectEl.value = playerId;
  currentPlayerId = playerId;
  currentSessionId = sessionId;
  const joinedPlayer = data.players.find(p => p.id === playerId);
  currentPlayerName = joinedPlayer ? joinedPlayer.name : name;
  // Hide join, show chat
  enableChat();
  currentSessionEl.textContent = `Session: ${sessionId}`;
  // Update character panel with initial data
  console.log('🔄 Calling updateCharacterPanel from join...');
  updateCharacterPanel(data.players, data.combat);
  // Scroll to bottom after showing
  log.scrollTop = log.scrollHeight;
}

// Send the player's action to the Worker and stream results back into the log.
async function sendAction() {
  const sessionId = sessionIdEl.value;
  const playerId = currentPlayerId || playerSelectEl.value;
  const playerAction = actionEl.value;
  if (!playerAction.trim()) return;
  if (!playerId || playerId === 'new') {
    addMsg('DM', 'Join a session before sending actions.');
    return;
  }
  const playerName = currentPlayerName || nameEl.value.trim() || 'Player';
  actionEl.value = '';

  // Disable UI
  actionEl.disabled = true;
  document.getElementById('send').disabled = true;
  document.getElementById('send').textContent = 'Sending...';

  // Add player message
  addMsg(playerName, playerAction);
  lastMessageCount++; // Account for the player message we just added

  // Add pulsating DM placeholder
  const dmPlaceholder = addMsg('DM', '✨', '', true);
  lastMessageCount++; // Account for the placeholder DM message

  let skipActionFocus = false;
  try {
    const res = await fetch('/api/session/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, playerId, playerAction }),
    });
    if (!res.ok) {
      const errorText = await res.text();
      let parsedMessage = errorText;
      try {
        const parsed = JSON.parse(errorText);
        parsedMessage = parsed.error || parsedMessage;
      } catch (_) { }
      const err = new Error(parsedMessage || `Action failed with status ${res.status}`);
      err.name = 'ActionError';
      throw err;
    }
    const data = await res.json();
    const shouldReset = Boolean(data.reset) || (Array.isArray(data.state?.players) && data.state.players.length === 0);
    if (shouldReset) {
      skipActionFocus = true;
      await resetAppToInitialState(data.result ?? 'The game has ended. Thank you for playing!');
    } else {
      // Replace placeholder with actual DM response
      dmPlaceholder.innerHTML = '';
      dmPlaceholder.className = 'msg dm';
      const label = document.createElement('span');
      label.textContent = 'DM: ';
      dmPlaceholder.appendChild(label);
      dmPlaceholder.appendChild(renderDmContent(data.result ?? 'The DM is thinking...', data.thinking || ''));

      // Update character panel with latest state
      if (data.state && data.state.players) {
        console.log('🔄 Calling updateCharacterPanel from sendAction...');
        console.log('🎮 Action response state:', data.state);
        updateCharacterPanel(data.state.players, data.state.combat);
      } else {
        console.warn('⚠️ No state data in action response');
      }

      // Update the message count to account for the actual DM response
      // (player action + DM response = +2 to the server's message count)
      lastMessageCount = (lastMessageCount - 2) + 2; // Reset and add both messages
    }
  } catch (e) {
    if (IS_LOCAL_HOST) {
      console.error('Failed to send action', {
        error: e,
        sessionId,
        playerId,
        playerAction,
      });
    }
    const message = e instanceof Error ? e.message : 'Unknown error';
    // Replace placeholder with error message
    dmPlaceholder.innerHTML = '';
    dmPlaceholder.className = 'msg dm';
    const label = document.createElement('span');
    label.textContent = 'DM: ';
    dmPlaceholder.appendChild(label);
    dmPlaceholder.appendChild(document.createTextNode(`Error processing action. ${message}`));
    if (message.toLowerCase().includes('player not joined')) {
      addMsg('DM', 'Session reset detected. Please rejoin to continue.');
      showJoinPrompt();
    }
  } finally {
    // Re-enable UI
    actionEl.disabled = false;
    document.getElementById('send').disabled = false;
    document.getElementById('send').textContent = 'Send';
    if (!skipActionFocus) {
      actionEl.focus();
    }
  }
}

// Character panel management
function updateCharacterPanel(players, combat) {
  console.log('🔄 updateCharacterPanel called with:', { players, combat });

  const characterInfo = document.getElementById('characterInfo');
  const combatInfo = document.getElementById('combatInfo');

  if (!characterInfo) {
    console.error('❌ characterInfo element not found!');
    return;
  }

  if (!combatInfo) {
    console.error('❌ combatInfo element not found!');
    return;
  }

  console.log('✅ Character panel elements found, updating...');

  // Debug logging for HP updates
  if (players) {
    console.log('👥 Players data:', players.map(p => `${p.name}: ${p.hp}HP, inventory: ${JSON.stringify(p.inventory)}`));
  }

  // Update character information
  if (players && players.length > 0) {
    const htmlContent = players.map(player => {
      const isCurrentPlayer = player.id === currentPlayerId;
      // Allow for dynamic max HP, but default to 20
      const maxHp = player.maxHp || 20;
      const hpPercentage = Math.max(0, Math.min(100, (player.hp / maxHp) * 100));
      const playerIcon = isCurrentPlayer ? '👤' : '🧙‍♂️';
      const hpColor = hpPercentage > 60 ? '#44ff44' : hpPercentage > 30 ? '#ffaa44' : '#ff4444';

      console.log(`📊 ${player.name} stats:`, { hp: player.hp, maxHp, hpPercentage, inventory: player.inventory });

      return `
        <div class="character-card ${isCurrentPlayer ? 'current-player' : ''}">
          <div class="character-name">
            ${playerIcon} ${player.name}${isCurrentPlayer ? ' (You)' : ''}
          </div>
          <div class="character-stats">
            <div class="stat-row">
              <span class="stat-label">❤️ Health:</span>
              <span class="stat-value" style="color: ${hpColor}">${player.hp}/${maxHp}</span>
            </div>
            <div class="hp-container">
              <div class="hp-bar">
                <div class="hp-fill" style="width: ${hpPercentage}%; background: linear-gradient(90deg, ${hpColor}, ${hpColor})"></div>
              </div>
            </div>
            <div class="inventory">
              <div class="inventory-title">🎒 Inventory ${player.inventory && player.inventory.length > 0 ? `(${player.inventory.length})` : ''}:</div>
              <div class="inventory-items">${player.inventory && player.inventory.length > 0 ? player.inventory.join(', ') : 'Empty'}</div>
            </div>
          </div>
        </div>
      `;
    }).join('');

    console.log('🔧 Setting characterInfo HTML:', htmlContent.substring(0, 200) + '...');
    characterInfo.innerHTML = htmlContent;
  } else {
    console.log('👥 No players data, showing empty state');
    characterInfo.innerHTML = '<div style="text-align: center; color: #888; padding: 20px;">🏛️ No party members in session</div>';
  }

  // Update combat information
  if (combat) {
    console.log('⚔️ Combat data:', combat);
    if (combat.active && combat.enemies && combat.enemies.length > 0) {
      const aliveEnemies = combat.enemies.filter(e => e.hp > 0);
      const deadEnemies = combat.enemies.filter(e => e.hp <= 0);

      combatInfo.innerHTML = `
        <div class="combat-status combat-active">
          ⚔️ Combat is Active!
        </div>
        ${aliveEnemies.length > 0 ? `
        <div class="enemy-list">
          <div style="margin-bottom: 8px; font-weight: bold; color: #d4af37;">👹 Active Enemies:</div>
          ${aliveEnemies.map(enemy => `
            <div class="enemy-item">
              <span class="enemy-name">${enemy.name}</span>
              <span class="enemy-hp">${enemy.hp} HP</span>
            </div>
          `).join('')}
        </div>
        ` : ''}
        ${deadEnemies.length > 0 ? `
        <div style="margin-top: 10px; padding: 8px; background: rgba(0, 0, 0, 0.2); border-radius: 4px;">
          <div style="font-size: 0.9rem; color: #888;">💀 Defeated: ${deadEnemies.map(e => e.name).join(', ')}</div>
        </div>
        ` : ''}
        ${combat.turnOrder && combat.turnOrder.length > 0 ? `
        <div style="margin-top: 15px; padding: 10px; background: rgba(212, 175, 55, 0.1); border-radius: 6px; border: 1px solid #d4af37;">
          <strong style="color: #d4af37;">🎯 Turn Order:</strong><br>
          <span style="color: #f4e4bc;">${combat.turnOrder.map((name, index) =>
        index === combat.currentTurnIndex ? `<strong style="color: #d4af37;">${name}</strong>` : name
      ).join(' → ')}</span>
        </div>
        ` : ''}
      `;
    } else {
      combatInfo.innerHTML = `
        <div class="combat-status combat-inactive">
          ✌️ No Active Combat
        </div>
        <div style="text-align: center; color: #888; padding: 20px; font-style: italic;">
          🌲 The party is currently exploring peacefully.
        </div>
      `;
    }
  } else {
    console.log('⚔️ No combat data');
    combatInfo.innerHTML = `
      <div class="combat-status combat-inactive">
        ✌️ No Active Combat
      </div>
      <div style="text-align: center; color: #888; padding: 20px; font-style: italic;">
        Waiting for game data...
      </div>
    `;
  }

  console.log('✅ Character panel update completed!');
}

function toggleCharacterPanel() {
  const panel = document.getElementById('characterPanel');
  const toggleBtn = document.getElementById('toggleCharPanel');

  if (!panel || !toggleBtn) {
    console.error('❌ Panel or toggle button not found!');
    return;
  }

  console.log('🔄 Toggling character panel...');

  // Disable button during transition to prevent multiple clicks
  toggleBtn.style.pointerEvents = 'none';

  if (panel.classList.contains('collapsed')) {
    console.log('📖 Expanding panel');
    panel.classList.remove('collapsed');

    // Change button text after a brief delay to sync with width transition
    setTimeout(() => {
      toggleBtn.textContent = '−';
      toggleBtn.setAttribute('aria-label', 'Collapse panel');
    }, 100);

    // Force update when expanding (after transition completes)
    setTimeout(() => {
      forceUpdateCharacterPanel();
      toggleBtn.style.pointerEvents = 'auto';
    }, 350);
  } else {
    console.log('📕 Collapsing panel');

    // Change button text immediately since we're collapsing
    toggleBtn.textContent = '+';
    toggleBtn.setAttribute('aria-label', 'Expand panel');

    // Add collapsed class after button text change
    setTimeout(() => {
      panel.classList.add('collapsed');
    }, 50);

    // Re-enable button after transition
    setTimeout(() => {
      toggleBtn.style.pointerEvents = 'auto';
    }, 350);
  }

  console.log('✅ Panel toggle initiated, collapsed:', panel.classList.contains('collapsed'));
}

// Force update character panel by fetching fresh data
async function forceUpdateCharacterPanel() {
  if (!currentSessionId) {
    console.log('⏸️ Force update skipped - no current session');
    return;
  }

  console.log('🔄 Force updating character panel...');
  try {
    const res = await fetch(`/api/session/state?sessionId=${encodeURIComponent(currentSessionId)}`);
    if (res.ok) {
      const data = await res.json();
      console.log('📊 Force update data:', data);
      updateCharacterPanel(data.players, data.combat);
      console.log('✅ Character panel force updated');
    } else {
      console.error('❌ Force update failed with status:', res.status);
    }
  } catch (e) {
    console.error('❌ Failed to force update character panel:', e);
  }
}

// Add a manual refresh function for testing
function refreshCharacterPanel() {
  console.log('🔄 Manual refresh triggered');
  forceUpdateCharacterPanel();
}

// Test function to check panel visibility
function testCharacterPanel() {
  const panel = document.getElementById('characterPanel');
  if (!panel) {
    console.error('❌ Character panel element does not exist!');
    return false;
  }

  console.log('🔍 Panel element found:', panel);
  console.log('📐 Panel computed styles:', window.getComputedStyle(panel));
  console.log('👁️ Panel display:', window.getComputedStyle(panel).display);
  console.log('👁️ Panel visibility:', window.getComputedStyle(panel).visibility);
  console.log('📏 Panel dimensions:', {
    width: panel.offsetWidth,
    height: panel.offsetHeight,
    clientWidth: panel.clientWidth,
    clientHeight: panel.clientHeight
  });

  const characterInfo = document.getElementById('characterInfo');
  const combatInfo = document.getElementById('combatInfo');

  console.log('📋 characterInfo exists:', !!characterInfo);
  console.log('⚔️ combatInfo exists:', !!combatInfo);

  if (characterInfo) {
    console.log('📋 characterInfo content:', characterInfo.innerHTML);
  }

  // Add debug class to make panel super visible
  panel.classList.add('debug-visible');
  console.log('🔴 Added debug-visible class to make panel red and prominent');

  // Force update with fake data for testing
  console.log('🧪 Testing with fake data...');
  updateCharacterPanel([
    { id: 'test1', name: 'Test Player', hp: 15, maxHp: 20, inventory: ['sword', 'potion'] }
  ], { active: false, enemies: [] });

  return true;
}

// Make test functions available globally
window.testCharacterPanel = testCharacterPanel;
window.refreshCharacterPanel = refreshCharacterPanel;
window.updateCharacterPanel = updateCharacterPanel;

console.log('🧪 Debug functions available: testCharacterPanel(), refreshCharacterPanel(), updateCharacterPanel()');
console.log('🔧 To test: Type testCharacterPanel() in the console to check panel visibility');

// Initialization and event listeners
(async () => {
  await loadSessions();
  loadPlayers();
})();

sessionIdEl.addEventListener('change', () => {
  loadPlayers();
  clearLog();
  showJoinPrompt();
  const sessionId = sessionIdEl.value;
  currentSessionEl.textContent = sessionId === 'create-new' ? '' : `Session: ${sessionId}`;
  lastMessageCount = 0;
});

clearSessionsBtn.addEventListener('click', () => {
  clearAllSessions();
});

playerSelectEl.addEventListener('change', () => {
  const selected = playerSelectEl.value;
  if (selected === 'new') {
    nameEl.value = '';
    currentPlayerId = '';
    currentPlayerName = '';
    nameEl.disabled = false;
  } else {
    // Find the player name
    const option = playerSelectEl.querySelector(`option[value="${selected}"]`);
    const selectedName = option ? option.textContent || '' : '';
    nameEl.value = selectedName;
    currentPlayerId = selected;
    currentPlayerName = selectedName;
    nameEl.disabled = true;
  }
});

document.getElementById('join').onclick = join;
document.getElementById('send').onclick = sendAction;

actionEl.addEventListener('keydown', function (event) {
  if (event.key === 'Enter') {
    sendAction();
  }
});

// Character panel toggle
document.getElementById('toggleCharPanel').addEventListener('click', toggleCharacterPanel);

// Cleanup polling when page is unloaded
window.addEventListener('beforeunload', () => {
  stopPolling();
});