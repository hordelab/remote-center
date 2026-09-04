export const spec = {
  name: 'create_space',
  description: 'Create a new space: a named sub-remote with its own working directory.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Name of the new space.' },
    },
    required: ['name'],
  },
};

export default async function (args, ctx) {
  return await ctx.api.createSpace(args.name);
}