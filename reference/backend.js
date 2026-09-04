
import * as ui from './ui';

export default class Stream {
    constructor (id) {
        this.id = id;
        this.partialContent = "";
        this.eof = false;

        this.listeners = {
            data: [],
            end: [],
        };

        let onResponse = (msg) => {
            if (this.eof) return;

            if (msg.eof) {
                this.eof = true;
                this.handle('end');
            } else {
                this.partialContent += msg.data;
                this.handle('data', msg.data);
            }
        };

        this.contentPromise = new Promise((resolve, reject) => {
            this.handle("end", () => {
                resolve(this.partialContent);
            });
        });
    }

    feed (chunk) {
        if (this.eof) return;
        this.partialContent += chunk;
        this.handle('data', chunk);
    }

    close () {
        this.eof = true;
        this.handle('end', this.partialContent);
    }

    getContent () {
        return this.contentPromise;
    }

    handle (event, ...args) {
        for (let fn of this.listeners[event]) {
            fn(...args)
        }
    }

    on (event, callback) {
        this.listeners[event].push(callback);

        if (event == "data" && this.partialContent) {
            callback(this.partialContent);
        }
        if (event == "end" && this.eof) {
            callback();
        }
    }
}

export class ChatInfo {
  constructor({ id, name }) {
    this.id = id;
    this.name = name;
  }
}

// Basic objects and configuration
let socket = null;
let backendUrl = null;

// State
let nextNonce = 0;
let reconnectTimeout = null; // For managing the reconnect timer
let cache = {
  chats: null,
  agents: null,
};

// Auth
let loginToken = null;
let loginTokenDeferred = createDeferred();
let authDeferred = createDeferred();
let credentialsDeferred = createDeferred();

// Handlers
const pendingActions = {}; // Maps nonce to { resolve, reject }
const chatListeners = {}; // Maps chatId to an array of callback functions
const actionListeners = {}; // Listeners for other arbitrary actions
const orphanHandlers = []; // Queue of callbacks for orphan server messages
const connectListeners = []; // Listeners for horde connection

function createDeferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, resolve, reject};
}

function createDeferredStream(callback) {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  let deferred = {promise, resolve, reject};
  return {promise, resolve (value) { callback(value, deferred) }, reject}
}

function initState () {
  backendUrl = window.location.origin;
  const tk = localStorage.getItem('loginToken');
  if (tk) {
    resolveToken(tk);

    // Clear token if it doesn't work
    authDeferred.promise.then(success => {
      console.log(`initState.authDeferred; success=${success}`);
      if (!success) {
        localStorage.removeItem('loginToken');
      }
    });
  } else {
    authDeferred.resolve(false);
  }
  connect();
}

initState();


// --- Authentication ---

// Passes the token to everyone who needs it, and returns it
function resolveToken (tk) {
  loginToken = tk;
  loginTokenDeferred.resolve(tk);
  return tk;
}

// Waits for the result of the last authentication attempt
export async function authResult() {
  // No token has been set, login or signup have to be called
  if (!loginToken) return false;
  return await authDeferred.promise;
}

// Creates an account and returns a login token
export async function signup(username, email, password) {
  try {
    const response = await postRequest('/user/signup', {
      username,
      email,
      password,
    });
    // Reset authentication status
    authDeferred = createDeferred();
    resolveToken(response.token);
    return await authResult();
  } catch (error) {
    ui.alert('Signup error: ' + (error.message || String(error)));
    return false;
  }
}

// Returns a login token for the given credentials
export async function login(username, password) {
  try {
    credentialsDeferred.resolve({username, password});
    const response = await postRequest('/user/login', {
      username,
      password,
    });
    // Reset authentication status
    authDeferred = createDeferred();
    resolveToken(response.token);
    return await authResult();
  } catch (error) {
    ui.alert('Login error: ' + (error.message || String(error)));
    return false;
  }
}

export async function newToken () {
  const response = await postRequest('/user/login', {
    token: loginToken || await loginTokenDeferred.promise,
  });
  return response.token;
}


// --- Communication ---

export function sendAction(action, body = {}, callback = null) {
  if (socket?.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("WebSocket is not open. Cannot send action."));
  }
  const nonce = nextNonce++;
  const deferred = callback ? createDeferredStream(callback) : createDeferred();

  pendingActions[nonce] = deferred;
  deferred.promise.finally(() => {
    delete pendingActions[nonce]; // Clean up
  });

  socket.send(JSON.stringify({
    action,
    nonce,
    body,
  }));
  return deferred.promise;
}

export function ping() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    const data = JSON.stringify({ path: 'ping' });
    socket.send(data);
    console.log('Ping sent:', data);
  } else {
    console.warn('Cannot send ping: WebSocket is not open.');
  }
}

function handleIncomingMessage(rawData) {
  let packet;
  try {
    packet = JSON.parse(rawData);
  } catch (e) {
    console.error("Failed to parse incoming message as JSON:", rawData, e);
    return;
  }

  if (packet.nonce != null) {
    const nonce = packet.nonce;
    const actionPromise = pendingActions[nonce];
    if (actionPromise) {
      if (packet.error) {
        actionPromise.reject(new Error(packet.error));
      } else {
        actionPromise.resolve(packet);
      }
    } else {
      console.warn(`Orphan response for action nonce ${nonce}. No pending action found.`);
    }
  } else if (packet.action === 'chat-message') {
    // This can be in a 'chat-message' listener in the future
    const chatId = packet.chatId;
    const listeners = chatListeners[chatId];
    if (listeners) {
      listeners.forEach(callback => {
        try {
          callback(packet);
        } catch (e) {
          console.error(`Error in chat message listener for chat ${chatId}:`, e);
        }
      });
    } else {
      console.log(`No active listeners for chatId ${chatId}`);
    }
  } else if (packet.action) {
    let listeners = actionListeners[packet.action];
    if (listeners && listeners.length) {
      for (let f of listeners) {
        f(packet);
      }
    }
  } else if (orphanHandlers.length) {
    const f = orphanHandlers.shift();
    f(packet);
  } else if (packet.error) {
    console.error(`Backend Error: ${packet.error}`);
  } else {
    console.warn('ignored server message', packet);
  }
}

async function postRequest(path, body) {
  const response = await fetch(`${backendUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Response Error: ${response.status}\n${errorText}`);
  }

  const responseText = await response.text();
  const responseData = JSON.parse(responseText);
  return responseData;
}


// --- Data Management ---

// Returns a function to unsubscribe
export function onChatMessages(chatId, callback) {
  if (typeof callback !== 'function') {
    throw new TypeError("chatMessages: callback must be a function.");
  }

  if (!chatListeners[chatId]) {
    chatListeners[chatId] = [];
  }
  const listeners = chatListeners[chatId];
  listeners.push(callback);

  // Return an unsubscribe function
  return () => {
    const index = listeners.indexOf(callback);
    if (index > -1) {
      listeners.splice(index, 1);
    }
    if (listeners.length === 0) {
      delete chatListeners[chatId];
    }
  };
}

export function onAction(action, callback) {
  if (typeof callback !== 'function') {
    throw new TypeError("onAction: callback must be a function.");
  }

  let listeners = actionListeners[action];
  if (!listeners) {
    listeners = [];
    actionListeners[action] = listeners;
  }
  listeners.push(callback);

  // Return an unsubscribe function
  return () => {
    const index = listeners.indexOf(callback);
    if (index > -1) {
      listeners.splice(index, 1);
    }
  };
}

export async function getChats() {
  if (cache.chats === null) {
    const response = await sendAction("get-chats", {});
    if (response && response.chats) {
      cache.chats = response.chats.map(msg => new ChatInfo({
        id: msg.id,
        name: msg.name || `<chat-${msg.id}>`,
      }));
    } else {
      throw new Error("Invalid response for get-chats: " + JSON.stringify(response));
    }
  }
  return cache.chats;
}

export async function getChat(chatId) {
  const allChats = await getChats();
  return allChats.find(it => it.id == chatId);
}

export async function getAgents() {
  if (cache.agents === null) {
    const response = await sendAction("get-agents", {});
    if (response && response.agents) {
      cache.agents = response.agents.map(msg => ({
        id: msg.id,
        name: msg.name || `<agent-${msg.id}>`,
        agentname: msg.agentname,
        description: msg.description,
        picture: msg.picture,
        kind: msg.kind,
      }));
    } else {
      throw new Error("Invalid response for get-agents: " + JSON.stringify(response));
    }
  }
  return cache.agents;
}

export async function getAgent(agentname) {
  const allAgents = await getAgents();
  return allAgents.find(it => it.agentname == agentname);
}

export function readStream(streamId) {
  let stream = new Stream(streamId);
  sendAction("read-stream", {streamId}, (packet, deferred) => {
    if (packet.eof) {
      stream.close();
      deferred.resolve();
    } else if (packet.data != null) {
      stream.feed(packet.data);
    }
  });
  return stream;
}

export function invalidateCache({ chats=false, agents=false } = {}) {
  if (chats) cache.chats = null;
  if (agents) cache.agents = null;
}



// --- Connection ---

export function onConnect (callback) {
  connectListeners.push(callback);
  if (socket && socket.readyState === WebSocket.OPEN) {
    callback();
  }
  // TODO: return cancel function
}

function reconnect() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }
  reconnectTimeout = setTimeout(() => {
    connect();
  }, 1000); // Wait 1 second before attempting to reconnect
}

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    console.log('WebSocket is already connected or connecting.');
    return;
  }

  socket = new WebSocket(`${backendUrl}/ws`);

  socket.onopen = async (event) => {
    console.log('Connected to the WebSocket server');
    invalidateCache({ chat: true });

    console.log('Attempting to log in...');
    try {
      const tk = loginToken || await loginTokenDeferred.promise;
      socket.send(JSON.stringify({ token: tk }));

      // Wait for the login response as an orphan server message
      const response = await new Promise(resolve => {
        orphanHandlers.push(resolve);
      });

      if (response && !response.error) {
        // Successful connection, store token long term
        authDeferred.resolve(true);
        localStorage.setItem('loginToken', loginToken);

        for (let cb of connectListeners) cb();
      } else {
        authDeferred.resolve(false);
        console.error("Socket authentication failed:", response ? response.error : "Unknown error");
        socket.close(); // Close to trigger reconnect and retry login
      }
    } catch (error) {
      console.error("Error during WebSocket login:", error);
      authDeferred.resolve(false);
      socket.close(); // Close to trigger reconnect
    }
  };

  socket.onerror = (event) => {
    console.error('WebSocket Error:', event);
    reconnect();
  };

  socket.onclose = (event) => {
    console.log('Disconnected. Attempting to reconnect...', event.reason);
    reconnect();
  };

  socket.onmessage = (event) => {
    handleIncomingMessage(event.data);
  };
}

function disconnect() {
  if (socket) {
    socket.close(1000, "Client initiated disconnect");
    socket = null;
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout); // Stop any pending reconnects
    }
  }
}
