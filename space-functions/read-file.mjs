import fs from 'node:fs';
import path from 'node:path';

export const spec = {
  name: 'read-file',
  description: 'Read the text content of a file in the space.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the space directory.' },
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
  return { content: fs.readFileSync(resolveIn(ctx.dir, args.path), 'utf8') };
}