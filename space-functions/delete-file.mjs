import fs from 'node:fs';
import path from 'node:path';

export const spec = {
  name: 'delete-file',
  description: 'Delete a file (or directory) in the space.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the space directory.' },
    },
    required: ['path'],
  },
};

function resolveIn(base, relPath) {
  const resolved = path.resolve(base, relPath);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error('Path escapes the space directory');
  }
  return resolved;
}

export default async function (args, ctx) {
  const file = resolveIn(ctx.dir, args.path);
  if (!fs.existsSync(file)) throw new Error(`No such file: ${args.path}`);
  fs.rmSync(file, { recursive: true });
  return { deleted: args.path };
}