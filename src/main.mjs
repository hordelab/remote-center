#!/usr/bin/env node
// remote-center: connects local functions to a horde hub as remotes.
//
// Usage:
//   node src/main.js            run the center from the current directory
//   node src/main.js init [dir] copy the center template into <dir>/.remote and exit

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Horde } from './horde.mjs';
import { Remote, Watcher } from './runtime.mjs';

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const TEMPLATES_DIR = path.join(APP_DIR, 'templates');
const DEFAULT_HOST = 'wss://hub.hordelab.com';
const DEFAULT_NAME = 'remote-center';

// --- init command ---

function init(dir = '.') {
  const remoteDir = path.resolve(dir, '.remote');
  if (fs.existsSync(remoteDir)) {
    console.error(`Refusing to overwrite existing ${remoteDir}`);
    process.exit(1);
  }
  fs.cpSync(path.join(TEMPLATES_DIR, 'center'), remoteDir, { recursive: true });
  console.log(`Initialized center remote at ${remoteDir}`);
  console.log('Set your hub token in .remote/config.json, then run: node src/main.js');
}

// --- run ---

function loadConfig(workPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(workPath, '.remote', 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function run() {
  const workPath = process.cwd();
  const config = loadConfig(workPath);

  const host = process.env.HORDE_HOST || config.host || DEFAULT_HOST;
  const name = config.name || DEFAULT_NAME;
  const token = process.env.HORDE_TOKEN || config.token || null;
  const spacesDir = path.join(workPath, 'spaces');

  console.log(`Running remote-center '${name}' on ${host}, working path ${workPath}`);
  if (!token) console.warn('No token set in .remote/config.json');

  const horde = new Horde({ host, token });
  const center = new Remote({
    horde,
    name,
    functionsDir: path.join(workPath, '.remote', 'functions'),
  });
  const remotes = new Map([[name, center]]);

  function checkSpaceName(spaceName) {
    if (typeof spaceName !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(spaceName)) {
      throw new Error(`Invalid space name: ${JSON.stringify(spaceName)}`);
    }
  }

  async function createSpace(spaceName) {
    checkSpaceName(spaceName);
    const dir = path.join(spacesDir, spaceName);
    if (fs.existsSync(dir)) throw new Error(`Space already exists: ${spaceName}`);
    fs.cpSync(path.join(TEMPLATES_DIR, 'space'), path.join(dir, '.remote'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.remote', 'config.json'),
      JSON.stringify({ name: spaceName }, null, 2) + '\n',
    );
    const remote = addSpaceRemote(spaceName, dir);
    if (!(await remote.register())) throw new Error('Failed to register space with the hub');
    console.log(`Created space '${spaceName}' at ${dir}`);
    return { name: spaceName, dir };
  }

  async function cloneSpace(source, newName) {
    const isUrl = /^https?:\/\//.test(source) || source.endsWith('.git') || /@[^@]+:/.test(source);
    if (!newName) {
      if (!isUrl) throw new Error('A new space name is required when cloning an existing space');
      newName = path.basename(source).replace(/\.git$/, '');
    }
    checkSpaceName(newName);
    const dir = path.join(spacesDir, newName);
    if (fs.existsSync(dir)) throw new Error(`Space already exists: ${newName}`);

    if (isUrl) {
      await new Promise((resolve, reject) => {
        execFile('git', ['clone', source, dir], (err, _out, stderr) => {
          if (err) reject(new Error(`git clone failed: ${stderr.trim() || err.message}`));
          else resolve();
        });
      });
      if (!fs.existsSync(path.join(dir, '.remote'))) {
        fs.cpSync(path.join(TEMPLATES_DIR, 'space'), path.join(dir, '.remote'), { recursive: true });
      }
    } else {
      const sourceDir = path.join(spacesDir, source);
      if (!fs.existsSync(sourceDir)) throw new Error(`Unknown space: ${source}`);
      fs.cpSync(sourceDir, dir, { recursive: true });
    }

    const remote = addSpaceRemote(newName, dir);
    if (!(await remote.register())) throw new Error('Failed to register space with the hub');
    console.log(`Cloned space '${newName}' from ${source}`);
    return { name: newName, dir };
  }

  const api = {
    createSpace,
    cloneSpace,
    listSpaces: () => [...remotes.keys()].filter((n) => n !== name),
  };

  center.ctx = { dir: workPath, remoteName: name, api };

  function addSpaceRemote(spaceName, dir) {
    const remoteName = `${name}/${spaceName}`;
    let remote = remotes.get(remoteName);
    if (remote) return remote;
    remote = new Remote({
      horde,
      name: remoteName,
      functionsDir: path.join(dir, '.remote', 'functions'),
      ctx: { dir, remoteName, spaceName, api },
      fallback: center.functions, // spaces share the center's functions
    });
    remotes.set(remoteName, remote);
    return remote;
  }

  // Registers new spaces and disconnects deleted ones. Safe to call repeatedly.
  function reconcileSpaces() {
    let entries = [];
    try {
      entries = fs.readdirSync(spacesDir, { withFileTypes: true });
    } catch {
      // spaces/ does not exist yet
    }

    const present = new Set();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(spacesDir, entry.name);
      if (!fs.existsSync(path.join(dir, '.remote'))) continue;
      present.add(entry.name);
      addSpaceRemote(entry.name, dir).register();
    }

    for (const [remoteName, remote] of remotes) {
      if (remoteName === name) continue;
      const spaceName = remoteName.slice(name.length + 1);
      if (!present.has(spaceName)) {
        remotes.delete(remoteName);
        remote.disconnect();
        console.log(`Space '${spaceName}' deleted; disconnected`);
      }
    }
  }

  horde.onAction('remote-call', (packet) => {
    const body = packet.body ?? packet;
    const remoteName = body.remotename;
    const fnName = body.function;
    const args = body.args ?? {};
    const requestId = body.requestId ?? packet.requestId;

    const respond = (fields) => {
      try {
        horde.send({
          action: 'remote-call-result',
          nonce: packet.nonce,
          body: { requestId, ...fields },
        });
      } catch (err) {
        console.error('Failed to send remote-call-result:', err.message);
      }
    };

    Promise.resolve()
      .then(() => {
        const remote = remotes.get(remoteName);
        if (!remote) throw new Error(`Unknown remote: ${remoteName}`);
        return remote.call(fnName, args);
      })
      .then((result) => respond({ result: result ?? null }))
      .catch((err) => respond({ error: String(err?.message || err) }));
  });

  horde.onConnect(() => {
    // (Re)register every remote after each (re)connection
    for (const remote of remotes.values()) remote.register();
  });

  reconcileSpaces();
  new Watcher(spacesDir, () => reconcileSpaces()).start();
  horde.connect();

  process.on('SIGINT', async () => {
    console.log('Shutting down...');
    for (const remote of remotes.values()) await remote.disconnect();
    horde.close();
    process.exit(0);
  });
}

// --- entry point ---

const [command, ...rest] = process.argv.slice(2);
if (command === 'init') {
  init(rest[0]);
} else if (command) {
  console.error(`Unknown command: ${command}`);
  console.error('Usage: node src/main.js [init [directory]]');
  process.exit(1);
} else {
  run();
}