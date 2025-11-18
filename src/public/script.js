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
  document.querySelector('.join-section').style.display = 'block';
  document.querySelector('.action-section').style.display = 'none';
  document.querySelector('.help-text').style.display = 'none';
  currentPlayerId = '';
  currentPlayerName = '';
  actionEl.value = '';
}

function enableChat() {
  document.querySelector('.join-section').style.display = 'none';
  document.getElementById('log').style.display = 'block';
  document.querySelector('.action-section').style.display = 'flex';
  document.querySelector('.help-text').style.display = 'block';
}

function hydrateMessages(messages = []) {
  clearLog();
  messages.forEach(msg => addMsg(msg.actor, msg.content));
}

// Lightweight UI reset used whenever a session ends or is cleared.
async function resetAppToInitialState(finalMessage = 'The adventure has concluded. Returning to the lobby...') {
  try {
    clearLog();
    if (finalMessage) {
      addMsg('DM', finalMessage);
    }
    addMsg('DM', 'Session reset. Join an existing game or start a new story.');
    showJoinPrompt();
    document.getElementById('log').style.display = 'block';
    currentPlayerId = '';
    currentPlayerName = '';
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

  // Split by lines to handle paragraphs and lists
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
  const joinedPlayer = data.players.find(p => p.id === playerId);
  currentPlayerName = joinedPlayer ? joinedPlayer.name : name;
  // Hide join, show chat
  enableChat();
  currentSessionEl.textContent = `Session: ${sessionId}`;
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

  // Add pulsating DM placeholder
  const dmPlaceholder = addMsg('DM', '✨', '', true);

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
      } catch (_) {}
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

actionEl.addEventListener('keydown', function(event) {
  if (event.key === 'Enter') {
    sendAction();
  }
});