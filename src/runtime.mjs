// Remote runtime: loads function modules from directories, watches them for
// changes, and registers remotes on a horde connection.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const FUNCTION_EXTENSIONS = ['.mjs', '.js'];

// A directory of function modules. Each module exports `spec`
// ({ name, description, parameters }) and a default async function (args, ctx).
export class Functions {
  constructor(dir) {
    this.dir = dir;
    this.map = new Map(); // spec.name -> { spec, fn, file }
  }

  async scan() {
    const map = new Map();
    let entries = [];
    try {
      entries = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch {
      this.map = map; // no directory yet: no functions
      return map;
    }

    // Load .mjs first so it wins over a same-named .js module
    entries.sort((a, b) =>
      FUNCTION_EXTENSIONS.indexOf(path.extname(a.name)) -
      FUNCTION_EXTENSIONS.indexOf(path.extname(b.name)));

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!FUNCTION_EXTENSIONS.includes(path.extname(entry.name))) continue;
      const file = path.join(this.dir, entry.name);
      try {
        // Cache-busting query: node caches modules by URL
        const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
        const { spec } = mod;
        if (!spec || typeof spec.name !== 'string') {
          throw new Error('module must export a `spec` object with a `name` string');
        }
        if (typeof mod.default !== 'function') {
          throw new Error('module must export a default function');
        }
        if (map.has(spec.name)) continue;
        map.set(spec.name, { spec, fn: mod.default, file });
      } catch (err) {
        console.error(`Failed to load function module ${file}: ${err.message}`);
      }
    }

    this.map = map;
    return map;
  }

  specs() {
    return [...this.map.values()].map((f) => f.spec);
  }

  names() {
    return [...this.map.keys()];
  }

  has(name) {
    return this.map.has(name);
  }

  spec(name) {
    return this.map.get(name)?.spec;
  }

  async call(name, args, ctx) {
    const fn = this.map.get(name);
    if (!fn) throw new Error(`Unknown function: ${name}`);
    return await fn.fn(args, ctx);
  }
}

// Watches a directory using fs.watch, with a polling fallback every 5 seconds.
export class Watcher {
  constructor(dir, onChange, intervalMs = 5000) {
    this.dir = dir;
    this.onChange = onChange;
    this.intervalMs = intervalMs;
    this.fsWatcher = null;
    this.timer = null;
    this.signature = null;
    this.debounce = null;
  }

  signatureOf() {
    try {
      return fs.readdirSync(this.dir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => {
          const st = fs.statSync(path.join(this.dir, e.name));
          return `${e.name}:${st.mtimeMs}`;
        })
        .sort()
        .join('|');
    } catch {
      return null;
    }
  }

  check() {
    const signature = this.signatureOf();
    if (signature !== this.signature) {
      const changed = this.signature !== null;
      this.signature = signature;
      if (changed) this.onChange();
    }
  }

  start() {
    this.signature = this.signatureOf();
    try {
      this.fsWatcher = fs.watch(this.dir, () => {
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.check(), 100);
      });
    } catch (err) {
      console.warn(`fs.watch unavailable for ${this.dir}, relying on polling: ${err.message}`);
    }
    this.timer = setInterval(() => this.check(), this.intervalMs);
  }

  stop() {
    if (this.fsWatcher) this.fsWatcher.close();
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
  }
}

// A named collection of functions in a directory, registered on the hub.
export class Remote {
  constructor({ horde, name, functionsDir, ctx, centerFunctions = [], fallback }) {
    this.horde = horde;
    this.name = name;
    this.ctx = ctx;
    this.functions = new Functions(functionsDir);
    this.centerFunctions = centerFunctions;
    this.fallback = fallback;
    this.watcher = null;
  }

  // (Re)scans functions and (re)registers the remote. Returns success.
  async register() {
    await this.functions.scan();
    try {
      let functions = this.functions.specs();


      // Extend functions list with center functions
      for (const fname of this.centerFunctions) {
        // don't override local functions (should override?)
        //if (this.functions.has(fname)) continue;
        if (this.fallback && this.fallback.has(fname)) {
          functions.push(this.fallback.spec(fname));
        } else {
          console.error(`Remote ${this.name}: center function ${fname} not found`)
        }
      }
      
      await this.horde.sendAction('remote-connect', {
        remotename: this.name,
        functions,
      });
      console.log(`Registered remote '${this.name}' with ${functions.length} function(s) (${this.functions.map.size} defined)`);
    } catch (err) {
      console.error(`Failed to register remote '${this.name}': ${err.message}`);
      return false;
    }
    if (!this.watcher) {
      this.watcher = new Watcher(this.functions.dir, async () => {
        await this.disconnect();
        await this.register()
      });
      this.watcher.start();
    }
    return true;
  }

  async disconnect() {
    if (this.watcher) this.watcher.stop();
    try {
      await this.horde.sendAction('remote-disconnect', { remotename: this.name });
    } catch {
      // socket may already be gone
    }
  }

  // Handles an incoming remote-call. Falls back to shared center functions.
  async call(functionName, args) {
    if (this.functions.has(functionName)) {
      return await this.functions.call(functionName, args, this.ctx);
    }
    if (this.fallback) {
      return await this.fallback.call(functionName, args, this.ctx);
    }
    throw new Error(`Unknown function '${functionName}' on remote '${this.name}'`);
  }
}