import fs from 'node:fs';
import path from 'node:path';

export const spec = {
  name: 'create-function',
  description: 'Create a new function on this remote by writing a function module.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Function identifier.' },
      description: { type: 'string', description: 'Description shown to the AI.' },
      parameters: { type: 'object', description: 'OpenAI tool parameter schema for the function arguments.' },
      code: { type: 'string', description: 'JavaScript statements forming the function body; `args` and `ctx` are in scope.' },
    },
    required: ['name', 'description', 'parameters', 'code'],
  },
};

export default async function (args, ctx) {
  const name = args.name;
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
    throw new Error(`Invalid function name: ${JSON.stringify(name)}`);
  }
  const functionsDir = path.join(ctx.dir, '.remote', 'functions');
  fs.mkdirSync(functionsDir, { recursive: true });
  const moduleSource = `export const spec = ${JSON.stringify({
    name,
    description: args.description,
    parameters: args.parameters,
  }, null, 2)};

export default async function (args, ctx) {
${args.code}
}
`;
  fs.writeFileSync(path.join(functionsDir, `${name}.mjs`), moduleSource);
  return { created: name };
}