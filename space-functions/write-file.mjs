import fs from 'node:fs';
import path from 'node:path';

export const spec = {
  name: 'write-file',
  description: 'Write text content to a file in the space, creating parent directories as needed.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the space directory.' },
      content: { type: 'string', description: 'Text content to write.' },
    },
    required: ['path', 'content'],
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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, args.content ?? '');
  return { written: args.path };
}