# Remotes

## Overview

A **remote** is a collection of functions exposed to an AI agent through the WebSocket session. Remotes are scoped to a user and live in memory during the server's lifetime.

## Architecture & Function Lifecycle

Remote functions are not standard Python methods attached to the agent. Instead, they are definitions (schemas) wrapped into adapters that fit the expert agent's tool loop.

1.  **Definition (`backend/src/remote.py`)**:
    *   A **`RemoteFunction`** represents a function exposed by a remote. It contains the function's name, description, and its OpenAI-compatible schema for input parameters.
    *   A **`RemoteToolSpec`** wraps a `RemoteFunction` to make it compatible with the agent's tool system. It exposes the required interface: `.name`, `.description`, `.to_openai_dict()` (for the LLM), and `.execute_async(**args)` (for execution).
    *   A **`RemoteConnection`** manages the connection state. It holds the function definitions and an internal queue of pending calls.

2.  **Injection**:
    *   When a run starts (see **Agent Integration** below), the expert agent requests tools for specific remotes. The server resolves these remote names into `RemoteToolSpec` objects and adds them to the run's input tools list.

3.  **Execution**:
    *   When the AI decides to use a remote tool, the expert agent's loop calls `execute_async` on the `RemoteToolSpec`.
    *   This triggers `RemoteConnection.call()`, which sends a request over the WebSocket to the session that owns the remote.
    *   The remote executes the function code (for local remotes) or accepts an RPC call (for external remotes).
    *   Results are sent back through `remote-call-result` actions. Pending calls time out after 30 seconds if no response is received.

4.  **Lifecycle**:
    *   Remotes are established when a user connects them via the UI (`remote-connect`).
    *   They persist for the session lifetime unless manually disconnected (`remote-disconnect`) or if the session serving them closes.
    *   Collisions are handled by scoping connections to `(user_id, name)`.

## API Reference

All endpoints are actions sent to the backend via the WebSocket.

### `remote-connect`
Registers a new remote connection for the current user.

**Payload**:
*   `remotename` (string): The unique name for this remote collection.
*   `functions` (array of objects): List of function specs. Each object must contain:
    *   `name` (string): The function identifier.
    *   `description` (string): Text visible to the AI.
    *   `parameters` (object): OpenAI tool parameter schema (`type`, `properties`, `required`).

### `remote-disconnect`
Removes a connected remote.

**Payload**:
*   `remotename` (string): The name of the remote to remove.

### `remote-list`
Requests the list of remotes currently registered for the authenticated user.

**Payload**: (Empty)

### `remote-call`
Invokes a specific function on a remote.

**Payload**:
*   `remotename` (string): The target remote.
*   `function` (string): The function name.
*   `args` (object): The arguments to pass to the function, matching the schema defined in `remote-connect`.

### `remote-call-result`
Sent by the server to the active session to deliver the outcome of a pending `remote-call`.

**Payload**:
*   `requestId` (string): A unique identifier for this specific request.
*   `result` (any): The return value of the function.
*   `error` (string): An error message if execution failed.

## Agent Integration

Remotes are integrated into the agent workflow in two stages: receiving context and executing tools.

### Chat Integration (`Agent.received_message`)
When a user sends a message to a chat thread, the frontend sends a special system resource to mark which remotes should be available for that conversation.

*   In `backend/src/agent.py`, the `received_message` method scans the thread's resources.
*   It looks for items with `subkind: 'remote'`.
*   It extracts the content of these resources (the remote names) and passes them into the agent run context.

### Execution Integration (`ExpertAgent.run`)
In `backend/src/agents/expert.py`, the `run` method prepares for execution.

*   It retrieves the list of remotes from the run input.
*   It calls `app.getRemoteTools(user_id, remotes)` to resolve these names into active tool specifications.
*   These tools are injected into the inference loop. When the AI selects a tool, the expert agent executes it. If a remote fails (timeout or error), the failure is returned as a string error, allowing the AI to retry or handle the failure naturally.