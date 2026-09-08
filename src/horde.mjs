// Horde hub WebSocket client for Node.js (>= 22, uses the global WebSocket).
// Modeled on the browser client in reference/backend.js: nonce-tracked actions,
// action listeners, orphan handlers for the auth response, auto-reconnect.

export class Horde {
  constructor({ host, token = null }) {
    this.host = host;
    this.token = token;
    this.socket = null;
    this.nextNonce = 0;
    this.pending = new Map();          // nonce -> { resolve, reject }
    this.actionListeners = new Map();  // action -> [callback(packet)]
    this.orphanHandlers = [];          // callbacks for nonce-less messages (auth replies)
    this.connectListeners = [];
    this.reconnectTimeout = null;
    this.stopped = false;
  }

  connect() {
    if (this.stopped) return;
    if (this.socket && (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN)) return;

    const socket = new WebSocket(this.host + "/ws");
    this.socket = socket;

    socket.onopen = async () => {
      console.log(`Connected to ${this.host}`);
      try {
        if (this.token) {
          socket.send(JSON.stringify({ token: this.token }));
          const response = await this.waitOrphan();
          if (response && response.error) {
            console.error('Hub authentication failed:', response.error);
            socket.close();
            return;
          }
        } else {
          console.warn('No auth token configured; the hub may reject this session');
        }
        for (const cb of this.connectListeners) {
          try { cb(); } catch (err) { console.error('Connect listener failed:', err); }
        }
      } catch (err) {
        console.error('Error during hub login:', err);
        socket.close();
      }
    };

    socket.onmessage = (event) => {
      if (typeof event.data === 'string') this.handleMessage(event.data);
    };

    socket.onclose = () => {
      this.socket = null;
      this.clearPending();
      if (!this.stopped) {
        console.log('Disconnected from hub. Reconnecting in 1s...');
        this.reconnectTimeout = setTimeout(() => this.connect(), 1000);
      }
    };

    socket.onerror = (event) => {
      console.error('WebSocket error:', event.message || event.error || event);
    };
  }

  close() {
    this.stopped = true;
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
    }
    this.clearPending();
  }

  clearPending() {
    for (const { reject } of this.pending.values()) {
      reject(new Error('Connection lost'));
    }
    this.pending.clear();
  }

  onConnect(cb) {
    this.connectListeners.push(cb);
  }

  onAction(action, cb) {
    let list = this.actionListeners.get(action);
    if (!list) {
      list = [];
      this.actionListeners.set(action, list);
    }
    list.push(cb);
  }

  waitOrphan() {
    return new Promise((resolve) => this.orphanHandlers.push(resolve));
  }

  send(value) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
    this.socket.send(JSON.stringify(value));
  }

  sendAction(action, body = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('WebSocket is not open'));
    }
    const nonce = this.nextNonce++;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(nonce, { resolve, reject });
    });
    promise.catch(() => {}); // avoid unhandled rejections when nobody awaits
    this.send({ action, nonce, body });
    return promise;
  }

  handleMessage(raw) {
    let packet;
    try {
      packet = JSON.parse(raw);
    } catch (err) {
      console.error('Failed to parse hub message:', raw, err);
      return;
    }

    if (packet.nonce != null) {
      const pending = this.pending.get(packet.nonce);
      if (!pending) {
        console.warn(`Orphan response for nonce ${packet.nonce}`);
        return;
      }
      this.pending.delete(packet.nonce);
      if (packet.error) pending.reject(new Error(packet.error));
      else pending.resolve(packet);
      return;
    }

    if (packet.action) {
      const listeners = this.actionListeners.get(packet.action);
      if (listeners && listeners.length) {
        for (const cb of listeners) {
          try { cb(packet); } catch (err) {
            console.error(`Listener for '${packet.action}' failed:`, err);
          }
        }
        return;
      }
    }

    if (this.orphanHandlers.length) {
      this.orphanHandlers.shift()(packet);
      return;
    }

    if (packet.error) console.error('Hub error:', packet.error);
    else console.warn('Ignored hub message:', packet.action);
  }
}