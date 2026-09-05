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

// Global runtime state
let WORK_DIR = null;
let APP_CONFIG = null;
let HOST = null;
let CENTER_NAME = null;
let HORDE = null;
let CENTER = null;
let REMOTES = null;
let API = null;

// --- config loading ---

function loadConfig() {
  if (!WORK_DIR) WORK_DIR = path.resolve(process.cwd());
  try {
    return JSON.parse(fs.readFileSync(path.join(WORK_DIR, '.remote', 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

// --- utility ---

function checkSpaceName(spaceName) {
  if (typeof spaceName !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(spaceName)) {
    throw new Error(`Invalid space name: ${JSON.stringify(spaceName)}`);
  }
}

// --- space operations ---

function addSpaceRemote(spaceName, dir) {
  const remoteName = `${CENTER_NAME}/${spaceName}`;
  let remote = REMOTES.get(remoteName);
  if (remote) return remote;
  remote = new Remote({
    horde: HORDE,
    name: remoteName,
    functionsDir: path.join(dir, '.remote', 'functions'),
    ctx: { dir, remoteName, spaceName, api: API },
    fallback: CENTER.functions,
  });
  REMOTES.set(remoteName, remote);
  return remote;
}

async function initSpace(spaceName, dir) {
  checkSpaceName(spaceName);
  const absoluteDir = path.resolve(WORK_DIR, dir || path.join('spaces', spaceName));
  if (!fs.existsSync(absoluteDir)) {
    throw new Error(`Space directory does not exist: ${absoluteDir}`);
  }

  if (REMOTES != null) {
    const remote = addSpaceRemote(spaceName, absoluteDir);
    if (!(await remote.register())) throw new Error('Failed to register space with the hub');
  }

  APP_CONFIG = { ...APP_CONFIG, spaces: { ...APP_CONFIG.spaces, [spaceName]: { path: absoluteDir } } };
  fs.writeFileSync(path.join(WORK_DIR, '.remote', 'config.json'), JSON.stringify(APP_CONFIG, null, 2) + '\n');

  console.log(`Initialized space '${spaceName}' at ${absoluteDir}`);
}

async function createSpace(spaceName, dir = null) {
  checkSpaceName(spaceName);
  const finalDir = dir || path.join(WORK_DIR, 'spaces', spaceName);
  const absoluteDir = path.resolve(WORK_DIR, finalDir);
  if (fs.existsSync(absoluteDir)) throw new Error(`Space directory already exists: ${absoluteDir}`);
  fs.mkdirSync(absoluteDir, { recursive: true });

  fs.cpSync(path.join(TEMPLATES_DIR, 'space'), path.join(absoluteDir, '.remote'), { recursive: true });
  fs.writeFileSync(path.join(absoluteDir, '.remote', 'config.json'), JSON.stringify({ name: spaceName }, null, 2) + '\n');

  await initSpace(spaceName, absoluteDir);
}

async function cloneSpace(source, newName, dir = null) {
  const isUrl = /^https?:\/\//.test(source) || source.endsWith('.git') || /@[^@]+:/.test(source);
  if (!newName) {
    if (!isUrl) throw new Error('A new space name is required when cloning an existing space');
    newName = path.basename(source).replace(/\.git$/, '');
  }
  checkSpaceName(newName);
  
  const finalDir = dir || path.join(WORK_DIR, 'spaces', newName);
  const absoluteDir = path.resolve(WORK_DIR, finalDir);
  if (fs.existsSync(absoluteDir)) throw new Error(`Space directory already exists: ${absoluteDir}`);

  if (isUrl) {
    await new Promise((resolve, reject) => {
      execFile('git', ['clone', source, absoluteDir], (err, _out, stderr) => {
        if (err) reject(new Error(`git clone failed: ${stderr.trim() || err.message}`));
        else resolve();
      });
    });
    if (!fs.existsSync(path.join(absoluteDir, '.remote'))) {
      fs.cpSync(path.join(TEMPLATES_DIR, 'space'), path.join(absoluteDir, '.remote'), { recursive: true });
    }
  } else {
    const sourceDir = path.join(WORK_DIR, 'spaces', source);
    if (!fs.existsSync(sourceDir)) throw new Error(`Unknown space: ${source}`);
    fs.cpSync(sourceDir, absoluteDir, { recursive: true });
  }

  await initSpace(newName, absoluteDir);
}

function reconcileSpaces() {
  const definedSpaces = APP_CONFIG.spaces || {};
  const present = new Set();

  for (const [spaceName, spaceConfig] of Object.entries(definedSpaces)) {
    let absoluteDir;
    if (typeof spaceConfig === 'string') {
        absoluteDir = path.resolve(WORK_DIR, spaceConfig);
    } else {
        absoluteDir = path.resolve(WORK_DIR, spaceConfig.path);
    }

    if (fs.existsSync(absoluteDir)) {
      present.add(spaceName);
      addSpaceRemote(spaceName, absoluteDir);
    }
  }

  for (const [remoteName, remote] of REMOTES) {
    if (remoteName === CENTER_NAME) continue;
    const spaceName = remoteName.slice(CENTER_NAME.length + 1);
    if (!present.has(spaceName)) {
      REMOTES.delete(remoteName);
      remote.disconnect();
      console.log(`Space '${spaceName}' deleted; disconnected`);
    }
  }
}

// --- remote call handling ---

function handleRemoteCall(packet) {
  const body = packet.body ?? packet;
  const remoteName = body.remotename;
  const fnName = body.function;
  const args = body.args ?? {};
  const requestId = body.requestId ?? packet.requestId;

  const respond = (fields) => {
    try {
      HORDE.send({
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
      const remote = REMOTES.get(remoteName);
      if (!remote) throw new Error(`Unknown remote: ${remoteName}`);
      return remote.call(fnName, args);
    })
    .then((result) => respond({ result: result ?? null }))
    .catch((err) => respond({ error: String(err?.message || err) }));
}

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

function run() {
  const token = process.env.HORDE_TOKEN || APP_CONFIG.token || null;
  const spacesDir = path.join(WORK_DIR, 'spaces');

  console.log(`Running remote-center '${CENTER_NAME}' on ${HOST}, working path ${WORK_DIR}`);
  if (!token) console.warn('No token set in .remote/config.json');

  HORDE = new Horde({ host: HOST, token });
  CENTER = new Remote({
    horde: HORDE,
    name: CENTER_NAME,
    functionsDir: path.join(WORK_DIR, '.remote', 'functions'),
  });
  REMOTES = new Map([[CENTER_NAME, CENTER]]);

  API = {
    createSpace,
    cloneSpace,
    listSpaces: () => [...REMOTES.keys()].filter((n) => n !== CENTER_NAME),
  };

  reconcileSpaces();
  new Watcher(spacesDir, () => reconcileSpaces()).start();
  HORDE.connect();

  HORDE.onConnect(() => {
    for (const remote of REMOTES.values()) remote.register();
  });

  HORDE.onAction('remote-call', handleRemoteCall);

  process.on('SIGINT', async () => {
    console.log('Shutting down...');
    for (const remote of REMOTES.values()) await remote.disconnect();
    HORDE.close();
    process.exit(0);
  });
}

// --- entry point ---

async function mainPromise (p) {
  try {
    await p;
  } catch (e) {
    console.error(e.stack);
    process.exit(1);
  }
}

WORK_DIR = path.resolve(process.cwd());
APP_CONFIG = loadConfig();
HOST = process.env.HORDE_HOST || APP_CONFIG.host || DEFAULT_HOST;
CENTER_NAME = APP_CONFIG.name || DEFAULT_NAME;

const [command, ...rest] = process.argv.slice(2);
if (command === 'init') {
  init(rest[0]);
} else if (command === 'init-space') {
  if (!rest[0]) {
    console.error('Usage: node src/main.js init-space <spaceName> [path]');
    process.exit(1);
  }
  mainPromise(
    initSpace(rest[0], rest[1])
  ).then(()=>process.exit(0));
} else if (command === 'create-space') {
  if (!rest[0]) {
    console.error('Usage: node src/main.js create-space <spaceName> [path]');
    process.exit(1);
  }
  createSpace(rest[0], rest[1]);
  process.exit(0);
} else if (command === 'clone-space') {
  if (!rest[0]) {
    console.error('Usage: node src/main.js clone-space <source> [newName] [path]');
    process.exit(1);
  }
  cloneSpace(rest[0], rest[1], rest[2]);
  process.exit(0);
} else if (command) {
  console.error(`Unknown command: ${command}`);
  console.error('Usage: node src/main.js [init [directory]]');
  process.exit(1);
} else {
  mainPromise(run());
}