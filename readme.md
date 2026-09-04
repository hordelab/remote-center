# Remote Center

`remote-center` is a slim application that exposes user-written functions to a horde hub as **remotes**. It has no npm dependencies and runs on a plain Node.js install.

A **center** is the main remote: it connects to the hub, exposes its own functions, and manages **spaces** — named sub-remotes, each with a working subdirectory of the center's working path. Spaces share the center's functions and may define their own.

## Requirements

- Node.js >= 22 (uses the built-in global `WebSocket`).
- `git` on PATH, if you want `clone_space` to work with git URLs.

## Quick start

```sh
node src/main.js init     # copies the center template into ./.remote
# edit .remote/config.json and set your hub token
node src/main.js          # runs the center from the current directory