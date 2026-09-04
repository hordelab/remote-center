import fs from 'node:fs';
import path from 'node:path';

export const spec = {
  name: 'delete_function',
  description: 'Delete a function module from this remote.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Name of the function to delete.' },
    },
    required: ['name'],
  },
};

export default async function (args, ctx) {
  const functionsDir = path.join(ctx.dir, '.remote', 'functions');
  for (const ext of ['.mjs', '.js']) {
    const file = path.join(functionsDir, `${args.name}${ext}`);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      return { deleted: args.name };
    }
  }
  throw new Error(`No such function: ${args.name}`);
}