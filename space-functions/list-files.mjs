import fs from 'node:fs';
import path from 'node:path';

export const spec = {
  name: 'list-files',
  description: 'List every file in the space, as paths relative to the space directory.',
  parameters: { type: 'object', properties: {} },
};

export default async function (args, ctx) {
  const files = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else files.push(rel);
    }
  };
  walk(ctx.dir, '');
  return { files };
}