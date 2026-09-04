# Remote Center

`remote-center` is a slim application, easily runs in any system. It connects to a configurable horde host, can be given an optional name (defaults to "remote-center") and a working path.
The application connects to the hub api reliably, connects it's main remote, and exposes all it's functions.
It's not in the hub repository. Users can either install `remote-center` and launch it with any working path, or clone the remote center repository and run it with itself to serve as the user's working copy.

A **Space** is a "sub-remote" of the remote center. They are named, and have an assigned working subpath of the center's working path.
This is the structure of all remote types:
- Center: has it's own distinct set of functions, working directory is not configurable, configurable name with default
- Space: subdirectory of the center's working path, configurable and required name
    - spaces share functions that can be defined in the center's space functions
    - every space can define their own unique functions

Functions are declared by writing them in expected file directories, which the center scans.
All spaces connect automatically to the hub when the center starts up, and are always live, until deleted.
Functions are user-written, directly executable from the client, and stored in the remote directories. They are executed with the fewest layer's of abstraction possible, even by the package manager itself if it's possible (but also remember the application must be small, use the simplest and most robust method available, not necessarily the most secured).

All configuration lives in the '.remote' subdirectory, for all remotes. Functions specifically live in .remote as well, but they are meant to be relatively small and contained, working closely with the remote-center's api. For less limited environment, functions can execute scripts or read any data from the remote's working directory.
Because functions live as scripts in the remote's directories, the initial space functions are templates, not remote source code. This also means that new remote centers must be installed, by copying an initial '.remote' from a template.
These are the initial functions for all remote types:
- Center functions: create_space(name), clone_space(space_name or git_url, optional new space name)
- Space functions: basic file operations, create and delete local functions (no execution command)

## Implementation

Application uses `deno` with only 2 commands: 'init' to copy the template directory into the local remote, and 'start' to start in the current directory or a given one.
File structure:
- src/: main.ts (cli, config), runtime.ts (remotes, functions), horde.ts (backend hub connection)
- templates/functions/: create_space.ts and clone_space.ts
- templates/space_functions/: all space functions
- spaces/: untracked directory where spaces are stored
- readme.md
- .remote/config.json: holds host, token, name
- .remote/functions/: every function is a module in this directory, loaded by deno
Functions are loaded as modules, and the .remote/functions directory is directly watched to track function updates, falling back to a scanning loop every 5 seconds.
Function modules export `spec` with the metadata of the function, and a default function that takes `args` and returns a json value.
The 'HORDE_HOST' is used if present, overriding any existing config, and defaults to 'wss://hub.hordelab.com' if not defined at all.