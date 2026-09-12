import fs from 'node:fs';
import path from 'node:path';

export const spec = {
  name: 'list-dir',
  description: 'List items in a directory. Takes a path argument and returns a list of strings representing the items in that directory.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory path relative to the space directory'
      }
    },
    required: ['path']
  }
};

function resolveIn(base, relPath) {
  const resolved = path.resolve(base, relPath);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error('Path escapes the space directory');
  }
  return resolved;
}

export default async function (args, ctx) {
  const dirPath = resolveIn(ctx.dir, args.path);
  
  // Check if path exists and is a directory
  if (!fs.existsSync(dirPath)) {
    throw new Error(`Directory not found: ${args.path}`);
  }
  
  if (!fs.statSync(dirPath).isDirectory()) {
    throw new Error(`Path is not a directory: ${args.path}`);
  }
  
  // Read directory and format paths with trailing slash for directories
  const items = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  
  for (const entry of entries) {
    const relPath = args.path ? `${args.path}/${entry.name}` : entry.name;
    items.push(entry.isDirectory() ? `${relPath}/` : relPath);
  }
  
  return { items };
}
